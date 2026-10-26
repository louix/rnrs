use std::ptr::NonNull;

use raw_window_handle::{AndroidDisplayHandle, AndroidNdkWindowHandle, HandleError, RawDisplayHandle, RawWindowHandle};
use rnrs_surface::platform::{self, Revoked};
use rnrs_surface::touch::Phase;
use rnrs_surface::{Extent, PlatformWindow};

use super::*;
use crate::spec::{Probe as _, TouchProbeModule as _};

struct FakeWindow;
impl PlatformWindow for FakeWindow {
    fn raw_window_handle(&self) -> Result<RawWindowHandle, HandleError> {
        Ok(RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(NonNull::<u8>::dangling().cast())))
    }
    fn raw_display_handle(&self) -> RawDisplayHandle {
        RawDisplayHandle::Android(AndroidDisplayHandle::new())
    }
}

const E: Extent = Extent { width: 1170, height: 600, scale: 3.0 };

fn attach(key: u64) -> u64 {
    platform::attach(key, Box::new(FakeWindow), E).expect("attached")
}

fn probe() -> (Native<Probe>, u64) {
    let probe = Module::default().create().expect("probe");
    let key = probe.surface_key().unwrap() as u64;
    (probe, key)
}

#[test]
fn delivers_a_gesture_and_explicit_drain_only() {
    let (probe, key) = probe();
    let a = attach(key);
    assert!(platform::touch(key, a, Phase::Down, 0, 30.0, 60.0, 10));
    assert!(platform::touch(key, a, Phase::Move, 0, 33.0, 66.0, 11));
    // Nothing drains in the background: the producer still has the pointer queued.
    let s = probe.drain().unwrap();
    assert_eq!((s.downs, s.moves, s.ups, s.contradictions), (1.0, 1.0, 0.0, 0.0));
    assert_eq!(s.down.len(), 1);
    assert_eq!((s.down[0].x_px, s.down[0].y_px, s.down[0].scale), (33.0, 66.0, 3.0));
    assert!(platform::touch(key, a, Phase::Up, 0, 33.0, 66.0, 12));
    let s = probe.drain().unwrap();
    assert_eq!((s.ups, s.down.len(), s.producer_down, s.drains), (1.0, 0, 0.0, 2.0));
    assert_eq!(s.recent.iter().map(|r| r.kind.as_str()).collect::<Vec<_>>(), ["down", "move", "up"]);
}

#[test]
fn revoke_resets_and_old_slot_is_unknown_after_reattach() {
    let (probe, key) = probe();
    let a = attach(key);
    assert!(platform::touch(key, a, Phase::Down, 0, 1.0, 1.0, 1));
    assert!(matches!(platform::revoke_async(key, a), Revoked::Released));
    // The old attachment is refused; after reattach the old slot is not a pointer.
    assert!(!platform::touch(key, a, Phase::Move, 0, 2.0, 2.0, 2));
    let b = attach(key);
    assert!(!platform::touch(key, b, Phase::Move, 0, 2.0, 2.0, 3));
    assert!(!platform::touch(key, b, Phase::Up, 0, 2.0, 2.0, 4));
    assert!(platform::touch(key, b, Phase::Down, 0, 5.0, 5.0, 5));
    let s = probe.drain().unwrap();
    assert_eq!((s.resets_detached, s.downs, s.contradictions), (1.0, 2.0, 0.0), "{:?}", s.last_contradiction);
    assert_eq!(s.down.len(), 1);
    assert_eq!((s.down[0].attachment, s.down[0].id), (b as f64, 2.0));
}

#[test]
fn close_queues_a_closed_reset_and_refuses() {
    let (probe, key) = probe();
    let a = attach(key);
    assert!(platform::touch(key, a, Phase::Down, 3, 1.0, 1.0, 1));
    probe.close().unwrap();
    assert!(!platform::touch(key, a, Phase::Move, 3, 1.0, 1.0, 2));
    let s = probe.drain().unwrap();
    assert_eq!((s.state.as_str(), s.resets_closed, s.down.len(), s.contradictions), ("closed", 1.0, 0, 0.0));
}

#[test]
fn model_flags_contradictions_and_stays_bounded() {
    let ev = |id, attachment, phase| TouchRecord::Event(TouchEvent { attachment, id, phase, x_px: 0.0, y_px: 0.0, extent: E, time_ms: 0 });
    let mut m = Model::default();
    m.apply(&ev(1, 1, TouchPhase::Move));
    assert_eq!(m.contradictions, 1, "move for a pointer not down");
    m.apply(&ev(2, 1, TouchPhase::Down));
    m.apply(&ev(2, 1, TouchPhase::Up));
    m.apply(&ev(2, 1, TouchPhase::Down));
    assert_eq!(m.contradictions, 2, "id reused");
    m.apply(&ev(3, 2, TouchPhase::Down));
    assert_eq!(m.contradictions, 3, "new attachment without a reset");
    m.apply(&TouchRecord::Reset { attachment: 2, reason: ResetReason::Detached });
    for id in 10..30 {
        m.apply(&ev(id, 3, TouchPhase::Down));
    }
    assert_eq!(m.down.len(), MAX_POINTERS);
    assert_eq!(m.contradictions, 3 + 10, "downs beyond the bound");
    let before = m.contradictions;
    m.apply(&ev(40, 2, TouchPhase::Down));
    assert_eq!(m.contradictions, before + 3, "attachment backwards, mixed attachments, beyond the bound");
    for _ in 0..RECENT {
        m.apply(&TouchRecord::Reset { attachment: 3, reason: ResetReason::Overflow });
    }
    assert_eq!((m.recent.len(), m.down.len()), (RECENT, 0));
}
