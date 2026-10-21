//! Browser attachment operations on the existing Surface/Inner authority.
use crate::{lookup, Extent, Surface, NEXT_ATTACHMENT};
use crate::touch::{Phase, ResetReason};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, PartialEq)]
pub enum Attached { Closed, Busy, Token(u64) }
#[derive(Debug, PartialEq)]
pub enum Resized { Ok, Closed, Stale }
fn validate(e: Extent) -> Result<(), String> {
    if e.is_empty() || !e.scale.is_finite() || e.scale <= 0.0 { return Err("invalid browser extent".into()); }
    Ok(())
}
pub fn attach(key: u64, extent: Extent) -> Result<Attached, String> {
    attach_with_counter(key, extent, &NEXT_ATTACHMENT)
}
fn attach_with_counter(key: u64, extent: Extent, counter: &AtomicU64) -> Result<Attached, String> {
    validate(extent)?;
    let Some(inner) = lookup(key) else { return Ok(Attached::Closed); };
    {
        let mut s = inner.lock();
        if s.closed { s.counters.refused_attaches += 1; return Ok(Attached::Closed); }
        if s.attachment != 0 { s.counters.refused_attaches += 1; return Ok(Attached::Busy); }
    }
    let Some(producer) = crate::web_producer::producer(key) else { return Ok(Attached::Closed); };
    // Allocate the token before configure can reserve raster memory.
    let token = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed,
        |n| (n < (1 << 53)).then_some(n + 1)).map_err(|_| "attachment keys exhausted")?;
    producer.configure(extent)?;
    let mut s = inner.lock();
    if s.closed { return Ok(Attached::Closed); }
    if s.attachment != 0 { return Ok(Attached::Busy); }
    s.attachment = token; s.extent = extent; s.counters.attaches += 1;
    drop(s);
    // The touch epoch is this token. Touch lock taken alone, after the state lock.
    inner.touch().begin(token, extent);
    Ok(Attached::Token(token))
}
pub fn resize(key: u64, token: u64, extent: Extent) -> Result<Resized, String> {
    validate(extent)?;
    let Some(inner) = lookup(key) else { return Ok(Resized::Closed); };
    let snapshot = Surface { inner: inner.clone() }.snapshot();
    if snapshot.closed { return Ok(Resized::Closed); }
    if token == 0 || snapshot.attachment != token { return Ok(Resized::Stale); }
    if snapshot.extent == extent { return Ok(Resized::Ok); }
    let Some(producer) = crate::web_producer::producer(key) else { return Ok(Resized::Closed); };
    producer.configure(extent)?;
    let mut s = inner.lock();
    if s.closed { return Ok(Resized::Closed); }
    if s.attachment != token { return Ok(Resized::Stale); }
    s.extent = extent; s.counters.resizes += 1;
    drop(s);
    inner.touch().resize(token, extent);
    Ok(Resized::Ok)
}
/// One browser pointer transition for attachment `token` (touch.rs, same contract as Android).
/// Refused while the surface is closed (a browser close keeps the attachment until the host
/// detaches, which queues the reset) or `token` is not current. Main thread; calls no JS.
pub fn touch(key: u64, token: u64, phase: Phase, pointer: i32, x_px: f32, y_px: f32, time_ms: i64) -> bool {
    let Some(inner) = lookup(key) else { return false; };
    let current = { let s = inner.lock(); !s.closed && token != 0 && s.attachment == token };
    let mut t = inner.touch();
    if !current { t.counters.refused_stale += 1; return false; }
    t.push(token, phase, pointer, x_px, y_px, time_ms)
}
pub fn detach(key: u64, token: u64) -> bool {
    let Some(inner) = lookup(key) else { return false; };
    {
        let mut s = inner.lock();
        if token == 0 || s.attachment != token { return false; }
        s.attachment = 0; s.extent = Extent::default(); s.counters.detaches += 1;
    }
    inner.touch().end(token, ResetReason::Detached);
    if let Some(producer) = crate::web_producer::producer(key) { producer.detach(); }
    #[cfg(target_arch = "wasm32")]
    crate::web_exports::released(key, token);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web_producer::{self, Pixels, Producer};
    use std::sync::Arc;
    struct Fake;
    impl Producer for Fake {
        fn render(&self, _: Extent, _: bool) -> Result<Option<Pixels>, String> { Ok(None) }
    }
    #[test]
    fn exhausted_token_does_not_configure_or_reserve_pixels() {
        struct MustNotConfigure;
        impl Producer for MustNotConfigure {
            fn configure(&self, _: Extent) -> Result<(), String> { panic!("token must precede allocation"); }
            fn render(&self, _: Extent, _: bool) -> Result<Option<Pixels>, String> { Ok(None) }
        }
        let surface = Surface::new().unwrap();
        let producer: Arc<dyn Producer> = Arc::new(MustNotConfigure);
        let _registration = web_producer::register(&surface, &producer).unwrap();
        let before = web_producer::diagnostics();
        assert!(attach_with_counter(surface.key(), Extent { width: 20, height: 10, scale: 1.0 },
            &AtomicU64::new(1 << 53)).unwrap_err().contains("exhausted"));
        assert_eq!(surface.snapshot().attachment, 0);
        assert_eq!(web_producer::diagnostics(), before);
    }
    #[test]
    fn authority_first_wins_stale_tokens_and_closed_keys() {
        let surface = Surface::new().unwrap();
        let producer: Arc<dyn Producer> = Arc::new(Fake);
        let _registration = web_producer::register(&surface, &producer).unwrap();
        let key = surface.key();
        let e = Extent { width: 20, height: 10, scale: 2.0 };
        let Attached::Token(first) = attach(key, e).unwrap() else { panic!() };
        assert_eq!(surface.snapshot().attachment, first);
        assert_eq!(attach(key, e).unwrap(), Attached::Busy);
        assert!(!detach(key, first + 1));
        assert!(detach(key, first));
        let Attached::Token(next) = attach(key, e).unwrap() else { panic!() };
        assert_ne!(first, next);
        assert_eq!(resize(key, first, e).unwrap(), Resized::Stale);
        surface.close();
        assert_eq!(attach(key, e).unwrap(), Attached::Closed);
        assert_eq!(resize(key, next, e).unwrap(), Resized::Closed);
        assert!(detach(key, next));
    }
    #[test]
    fn browser_touch_uses_the_attachment_token_as_epoch_and_the_real_bounded_queue() {
        use crate::touch::{TouchPhase, TouchRecord, QUEUE_CAPACITY};
        let surface = Surface::new().unwrap();
        let producer: Arc<dyn Producer> = Arc::new(Fake);
        let _registration = web_producer::register(&surface, &producer).unwrap();
        let key = surface.key();
        let e = Extent { width: 64, height: 32, scale: 2.0 };
        let mut out = Vec::new();
        let Attached::Token(first) = attach(key, e).unwrap() else { panic!() };
        assert!(!touch(key, first, Phase::Down, 1, 10.0, 10.0, 1), "not opted in by the renderer");
        surface.enable_touch();
        assert!(!touch(key, first + 1, Phase::Down, 1, 10.0, 10.0, 1), "another token");
        assert!(touch(key, first, Phase::Down, 1, 10.0, 12.0, 2));
        let wide = Extent { width: 128, ..e };
        assert_eq!(resize(key, first, wide).unwrap(), Resized::Ok);
        assert!(touch(key, first, Phase::Move, 1, 100.0, 12.0, 3));
        assert!(detach(key, first));
        assert!(!touch(key, first, Phase::Up, 1, 0.0, 0.0, 4), "detached: refused");
        surface.drain_touch(&mut out);
        let [TouchRecord::Event(down), TouchRecord::Event(moved), TouchRecord::Reset { attachment, .. }] = out[..] else { panic!("{out:?}") };
        assert_eq!((down.attachment, down.phase, down.extent), (first, TouchPhase::Down, e));
        assert_eq!((moved.phase, moved.extent.width), (TouchPhase::Move, 128), "extent when pushed");
        assert_eq!(attachment, first);

        // A new token is a new epoch; a full queue overflows into one reset, then closes.
        let Attached::Token(next) = attach(key, e).unwrap() else { panic!() };
        assert!(!touch(key, next, Phase::Move, 1, 0.0, 0.0, 5), "pointer of the old epoch unknown");
        for i in 0..(QUEUE_CAPACITY as i64 + 1) {
            touch(key, next, if i % 2 == 0 { Phase::Down } else { Phase::Up }, 7, 0.0, 0.0, i);
        }
        let (counters, _) = surface.touch_counters();
        assert_eq!(counters.overflows, 1);
        surface.drain_touch(&mut out);
        assert!(out.len() <= QUEUE_CAPACITY && matches!(out[0], TouchRecord::Reset { .. }));
        assert!(touch(key, next, Phase::Down, 2, 0.0, 0.0, 9));
        surface.close();
        assert!(!touch(key, next, Phase::Up, 2, 0.0, 0.0, 10), "closed: refused before the host detaches");
        assert!(detach(key, next));
        surface.drain_touch(&mut out);
        // Host builds compile the native close, which queues the closed reset itself; the wasm
        // close does not, and its reset comes from the host's detach (fixtures/web-touch).
        assert!(matches!(out[..], [TouchRecord::Event(_), TouchRecord::Reset { reason: ResetReason::Closed, .. }]), "{out:?}");
    }
}
