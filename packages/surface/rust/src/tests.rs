use super::platform::*;
use super::*;
use raw_window_handle::{AndroidDisplayHandle, AndroidNdkWindowHandle};
use std::ptr::NonNull;
use std::sync::atomic::AtomicUsize;
use std::sync::mpsc;
use std::thread;

/// A window that counts its releases.
struct FakeWindow {
    released: Arc<AtomicUsize>,
}
impl PlatformWindow for FakeWindow {
    fn raw_window_handle(&self) -> Result<RawWindowHandle, HandleError> {
        Ok(RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(NonNull::<u8>::dangling().cast())))
    }
    fn raw_display_handle(&self) -> RawDisplayHandle {
        RawDisplayHandle::Android(AndroidDisplayHandle::new())
    }
}
impl Drop for FakeWindow {
    fn drop(&mut self) {
        self.released.fetch_add(1, Ordering::SeqCst);
    }
}

fn window() -> (Box<dyn PlatformWindow>, Arc<AtomicUsize>) {
    let released = Arc::new(AtomicUsize::new(0));
    (Box::new(FakeWindow { released: released.clone() }), released)
}
/// A window as the host hands it: with its claim (host::testing). Returns the claim.
fn claimed_window() -> (Box<dyn PlatformWindow>, Arc<AtomicUsize>, u64) {
    let released = Arc::new(AtomicUsize::new(0));
    let (w, claim) = host::testing::claimed(FakeWindow { released: released.clone() }, released.clone());
    (w, released, claim)
}
/// The claim went back exactly once, after its window was released (once).
fn assert_claim_returned(claim: u64) {
    assert_eq!(host::testing::releases(claim), [1], "claim {claim}: returned once, after the window");
}
fn surface() -> Surface {
    Surface::new().unwrap()
}
const E: Extent = Extent { width: 100, height: 50, scale: 2.0 };
const LONG: Duration = Duration::from_secs(5);

/// Waits (failure guard: 5 s) until the attachment of `lease` is revoked.
fn wait_revoked(lease: &WindowLease) {
    let deadline = Instant::now() + LONG;
    while !lease.is_revoked() {
        assert!(Instant::now() < deadline, "never revoked");
        thread::yield_now();
    }
}

#[test]
fn keys_are_unique_and_unregistered_when_dropped() {
    let a = surface();
    let b = surface();
    assert_ne!(a.key(), b.key());
    assert!(a.key() > 0);
    let key = a.key();
    drop(a);
    let (w, released) = window();
    assert_eq!(attach(key, w, E), Err(AttachError::UnknownKey));
    assert_eq!(released.load(Ordering::SeqCst), 1, "a refused window is released at once");
}

#[test]
fn attach_resize_lease_detach() {
    let s = surface();
    let wakes = Arc::new(AtomicUsize::new(0));
    let w2 = wakes.clone();
    s.set_waker(move || {
        w2.fetch_add(1, Ordering::SeqCst);
    });
    assert!(s.lease().is_none());
    let (w, released) = window();
    let a = attach(s.key(), w, E).unwrap();
    assert_eq!(s.snapshot().attachment, a);
    let (w, released2) = window();
    assert_eq!(attach(s.key(), w, E), Err(AttachError::SurfaceBusy), "first attached wins");
    assert_eq!(released2.load(Ordering::SeqCst), 1);
    let bigger = Extent { width: 200, ..E };
    assert!(resize(s.key(), a, bigger));
    assert!(!resize(s.key(), a + 1000, E), "a stale attachment is ignored");
    let lease = s.lease().unwrap();
    assert_eq!(lease.attachment(), a);
    assert!(lease.window_handle().is_ok() && lease.display_handle().is_ok());
    // Detach on another thread; it must not return before the lease is dropped.
    let key = s.key();
    let (tx, rx) = mpsc::channel();
    let detacher = thread::spawn(move || tx.send(detach(key, a, LONG)).unwrap());
    wait_revoked(&lease);
    assert!(rx.try_recv().is_err(), "detach waits for the lease");
    assert_eq!(released.load(Ordering::SeqCst), 0);
    drop(lease);
    assert_eq!(rx.recv().unwrap(), Detached::Released);
    detacher.join().unwrap();
    assert_eq!(released.load(Ordering::SeqCst), 1);
    assert_eq!(detach(s.key(), a, LONG), Detached::Stale);
    let snap = s.snapshot();
    assert_eq!((snap.attachment, snap.extent), (0, Extent::default()));
    assert_eq!(snap.counters, Counters { attaches: 1, detaches: 1, resizes: 1, refused_attaches: 1, detach_timeouts: 0, detach_timeouts_in_flight: 0, retiring: 0 });
    assert_eq!(wakes.load(Ordering::SeqCst), 3, "attach, resize, detach");
}

/// Admitted operation in flight → detach times out → no further admission → the operation
/// completes → the lease drops → the window is released exactly once.
#[test]
fn timeout_forbids_new_admissions_and_the_window_is_released_exactly_once() {
    let s = surface();
    let (w, released, claim) = claimed_window();
    let a = attach(s.key(), w, E).unwrap();
    let lease = s.lease().unwrap();
    let (admitted_tx, admitted_rx) = mpsc::channel();
    let (finish_tx, finish_rx) = mpsc::channel::<()>();
    let (done_tx, done_rx) = mpsc::channel();
    let renderer = thread::spawn(move || {
        {
            let op = lease.admit().expect("admitted before detach");
            admitted_tx.send(()).unwrap();
            finish_rx.recv().unwrap(); // the "GPU operation" is stalled until released
            drop(op);
        }
        // The next operation is refused: revoked by the timed-out detach.
        done_tx.send(lease.admit().is_none()).unwrap();
        drop(lease);
    });
    admitted_rx.recv().unwrap();
    assert_eq!(detach(s.key(), a, Duration::from_millis(30)), Detached::TimedOut { in_flight: 1 });
    assert_eq!(released.load(Ordering::SeqCst), 0, "still retained by the lease");
    assert_eq!(host::testing::releases(claim), [0; 0], "the window stays claimed");
    finish_tx.send(()).unwrap();
    assert!(done_rx.recv().unwrap(), "no admission after revocation");
    renderer.join().unwrap();
    assert_eq!(released.load(Ordering::SeqCst), 1, "released exactly once, by the last lease");
    assert_claim_returned(claim);
    let c = s.snapshot().counters;
    assert_eq!((c.detach_timeouts, c.detach_timeouts_in_flight), (1, 1));
}

/// Window exclusivity across binaries is the host's (packages/runtime/cpp/RnrsSurfaceHost.h);
/// here: a binary returns the claim it was given exactly once, after the window, on every path.
#[test]
fn the_claim_is_returned_once_after_the_window_on_every_path() {
    let s = surface();
    let busy = surface();
    let closed = surface();
    closed.close();
    // Refused: unknown key, closed surface, surface already showing a window.
    let (w, _, unknown) = claimed_window();
    assert_eq!(attach(u64::MAX, w, E), Err(AttachError::UnknownKey));
    let (w, _, refused_closed) = claimed_window();
    assert_eq!(attach(closed.key(), w, E), Err(AttachError::Closed));
    let (w, _, shown) = claimed_window();
    let b = attach(busy.key(), w, E).unwrap();
    let (w, _, refused_busy) = claimed_window();
    assert_eq!(attach(busy.key(), w, E), Err(AttachError::SurfaceBusy));
    for claim in [unknown, refused_closed, refused_busy] {
        assert_claim_returned(claim);
    }
    // Detach without leases.
    assert_eq!(detach(busy.key(), b, LONG), Detached::Released);
    assert_claim_returned(shown);
    // A timed-out detach keeps the claim until the late lease drop.
    let (w, _, late) = claimed_window();
    let a = attach(s.key(), w, E).unwrap();
    let lease = s.lease().unwrap();
    assert_eq!(detach(s.key(), a, Duration::from_millis(10)), Detached::TimedOut { in_flight: 0 });
    assert!(host::testing::releases(late).is_empty(), "still leased: still claimed");
    let renderer = thread::spawn(move || drop(lease)); // the render thread drops it
    renderer.join().unwrap();
    assert_claim_returned(late);
    // A surface dropped while attached.
    let (w, _, dropped) = claimed_window();
    let gone = surface();
    attach(gone.key(), w, E).unwrap();
    drop(gone);
    assert_claim_returned(dropped);
}

#[test]
fn close_revokes_and_refuses_without_blocking() {
    let s = surface();
    let (w, released) = window();
    let a = attach(s.key(), w, E).unwrap();
    let lease = s.lease().unwrap();
    s.close();
    s.close();
    assert!(s.snapshot().closed);
    assert!(s.lease().is_none());
    assert!(lease.is_revoked() && lease.admit().is_none(), "close revokes the attachment");
    let (w3, _) = window();
    assert_eq!(attach(s.key(), w3, E), Err(AttachError::Closed));
    let key = s.key();
    let (tx, rx) = mpsc::channel();
    let detacher = thread::spawn(move || tx.send(detach(key, a, LONG)).unwrap());
    while s.snapshot().attachment != 0 {
        thread::yield_now(); // until the detach has taken the attachment
    }
    assert!(rx.try_recv().is_err(), "the platform detach still waits for the lease");
    drop(lease);
    assert_eq!(rx.recv().unwrap(), Detached::Released);
    detacher.join().unwrap();
    assert_eq!(released.load(Ordering::SeqCst), 1);
}

#[test]
fn dropping_a_surface_releases_its_attached_window() {
    let s = surface();
    let (w, released) = window();
    attach(s.key(), w, E).unwrap();
    drop(s);
    assert_eq!(released.load(Ordering::SeqCst), 1);
}

#[test]
fn a_lease_keeps_the_surface_registered_after_its_owner_is_dropped() {
    let s = surface();
    let key = s.key();
    let (w, released) = window();
    let a = attach(key, w, E).unwrap();
    let lease = s.lease().unwrap();
    let clone = lease.clone();
    drop(s);
    drop(lease);
    // The surface stays registered through the remaining lease; detach finds it and waits.
    let (tx, rx) = mpsc::channel();
    let detacher = thread::spawn(move || tx.send(detach(key, a, LONG)).unwrap());
    wait_revoked(&clone);
    assert!(rx.try_recv().is_err());
    drop(clone);
    assert_eq!(rx.recv().unwrap(), Detached::Released);
    detacher.join().unwrap();
    assert_eq!(released.load(Ordering::SeqCst), 1);
}

/// Racing admissions against detach: once detach has revoked, no admission succeeds, and
/// every admission that succeeded happened before the revocation.
#[test]
fn admissions_racing_detach_stop_at_revocation() {
    for _ in 0..50 {
        let s = surface();
        let (w, _) = window();
        let a = attach(s.key(), w, E).unwrap();
        let lease = s.lease().unwrap();
        let worker = thread::spawn(move || {
            let mut after_revoke = 0;
            loop {
                let revoked_before = lease.is_revoked();
                match lease.admit() {
                    Some(op) => {
                        if revoked_before {
                            after_revoke += 1;
                        }
                        drop(op);
                    }
                    None => break,
                }
            }
            after_revoke
        });
        thread::sleep(Duration::from_micros(200));
        assert_eq!(detach(s.key(), a, LONG), Detached::Released);
        assert_eq!(worker.join().unwrap(), 0);
    }
}

/// A layer-backed window (as on iOS): no raw window handle, a Metal layer instead.
struct LayerWindow {
    layer: usize,
    released: Arc<AtomicUsize>,
}
impl PlatformWindow for LayerWindow {
    fn raw_window_handle(&self) -> Result<RawWindowHandle, HandleError> {
        Err(HandleError::NotSupported)
    }
    fn raw_display_handle(&self) -> RawDisplayHandle {
        RawDisplayHandle::Android(AndroidDisplayHandle::new())
    }
    fn metal_layer(&self) -> Option<NonNull<c_void>> {
        NonNull::new(self.layer as *mut c_void)
    }
}
impl Drop for LayerWindow {
    fn drop(&mut self) {
        self.released.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn a_layer_window_refuses_raw_handles_and_exposes_its_layer() {
    let s = surface();
    let released = Arc::new(AtomicUsize::new(0));
    let id = 0x1000;
    attach(s.key(), Box::new(LayerWindow { layer: id, released: released.clone() }), E).unwrap();
    let lease = s.lease().unwrap();
    assert!(matches!(lease.window_handle(), Err(HandleError::NotSupported)), "a renderer cannot take the raw-handle path");
    assert_eq!(lease.metal_layer().map(|p| p.as_ptr() as usize), Some(id));
    let (w, _) = window();
    let other = surface();
    attach(other.key(), w, E).unwrap();
    let plain = other.lease().unwrap();
    assert!(plain.window_handle().is_ok());
    assert_eq!(plain.metal_layer(), None, "no layer by default");
}

/// The asynchronous revocations below share process-wide retirement statistics: every test in
/// this crate that calls `revoke_async` or reads `retirement_stats` holds this lock, so the
/// exact-count assertions cannot race (tests run on parallel threads).
pub(crate) static RETIREMENT: Mutex<()> = Mutex::new(());

#[test]
fn revoke_async_without_leases_releases_at_once_and_is_not_a_detach_timeout() {
    let _r = RETIREMENT.lock().unwrap_or_else(|e| e.into_inner());
    let before = retirement_stats();
    let s = surface();
    let (w, released) = window();
    let a = attach(s.key(), w, E).unwrap();
    assert_eq!(revoke_async(s.key(), a), Revoked::Released);
    assert_eq!(released.load(Ordering::SeqCst), 1);
    let c = s.snapshot().counters;
    assert_eq!((c.detaches, c.retiring, c.detach_timeouts), (1, 0, 0));
    assert_eq!(s.snapshot().attachment, 0);
    assert_eq!(revoke_async(s.key(), a), Revoked::Stale, "a second revoke of the same attachment is stale");
    assert_eq!(revoke_async(u64::MAX, 1), Revoked::Stale);
    assert_eq!(retirement_stats().retired, before.retired + 1);
}

#[test]
fn revoke_async_with_a_lease_retires_later_and_records_the_time() {
    let _r = RETIREMENT.lock().unwrap_or_else(|e| e.into_inner());
    let before = retirement_stats();
    let s = surface();
    let (w, released, claim) = claimed_window();
    let a = attach(s.key(), w, E).unwrap();
    let lease = s.lease().unwrap();
    let op = lease.admit().unwrap();
    let started = Instant::now();
    assert_eq!(revoke_async(s.key(), a), Revoked::Retiring { in_flight: 1 });
    assert!(started.elapsed() < Duration::from_millis(100), "never waits for the lease");
    assert!(lease.is_revoked());
    assert!(lease.admit().is_none(), "no new operation after revocation");
    let c = s.snapshot().counters;
    assert_eq!((c.detaches, c.retiring, c.detach_timeouts, c.detach_timeouts_in_flight), (1, 1, 0, 0));
    assert_eq!(released.load(Ordering::SeqCst), 0, "retained while leased");
    // The window stays claimed (no binary can attach it) until it is retired.
    assert!(host::testing::releases(claim).is_empty());
    thread::sleep(Duration::from_millis(30));
    drop(op);
    drop(lease);
    assert_eq!(released.load(Ordering::SeqCst), 1, "released with the last lease");
    let after = retirement_stats();
    assert_eq!(after.retired, before.retired + 1);
    assert!(after.max_ms >= 30.0, "{after:?}");
    assert_claim_returned(claim);
}

#[test]
fn a_slow_retirement_is_counted_over_the_warning_threshold() {
    let _r = RETIREMENT.lock().unwrap_or_else(|e| e.into_inner());
    let before = retirement_stats();
    let s = surface();
    let (w, _) = window();
    let a = attach(s.key(), w, E).unwrap();
    let lease = s.lease().unwrap();
    assert!(matches!(revoke_async(s.key(), a), Revoked::Retiring { in_flight: 0 }));
    thread::sleep(RETIRE_WARN + Duration::from_millis(100));
    drop(lease);
    let after = retirement_stats();
    assert_eq!(after.over_warn, before.over_warn + 1);
    assert!(after.max_ms >= RETIRE_WARN.as_secs_f64() * 1000.0);
}

#[test]
fn synchronous_detach_is_unchanged_and_records_no_retirement() {
    let _r = RETIREMENT.lock().unwrap_or_else(|e| e.into_inner());
    let before = retirement_stats();
    let s = surface();
    let (w, _) = window();
    let a = attach(s.key(), w, E).unwrap();
    let lease = s.lease().unwrap();
    assert!(matches!(detach(s.key(), a, Duration::from_millis(10)), Detached::TimedOut { in_flight: 0 }));
    assert_eq!(s.snapshot().counters.detach_timeouts, 1, "Android's synchronous detach still counts timeouts");
    drop(lease);
    assert_eq!(retirement_stats().retired, before.retired, "only asynchronous revocations are timed");
}

/// Touch through the platform entry points: refused until the renderer opts in; accepted for the
/// current attachment only, waking the renderer; a detach queues a reset (even with no frame
/// rendered) and the next attachment's input is separate; a resize changes later events' scale.
#[test]
fn touch_follows_the_attachment_and_detach_resets() {
    use crate::touch::{Phase, ResetReason, TouchPhase, TouchRecord};
    let s = surface();
    let wakes = Arc::new(AtomicUsize::new(0));
    let w = wakes.clone();
    s.set_waker(move || {
        w.fetch_add(1, Ordering::SeqCst);
    });
    let (win, _) = window();
    let a = attach(s.key(), win, E).unwrap();
    assert!(!touch(s.key(), a, Phase::Down, 0, 10.0, 10.0, 1), "not enabled by the renderer");
    s.enable_touch();
    assert!(!touch(s.key(), a + 1, Phase::Down, 0, 10.0, 10.0, 1), "not the current attachment");
    let before = wakes.load(Ordering::SeqCst);
    assert!(touch(s.key(), a, Phase::Down, 0, 10.0, 10.0, 1));
    assert!(wakes.load(Ordering::SeqCst) > before, "an accepted touch wakes the renderer");
    assert!(resize(s.key(), a, Extent { scale: 4.0, ..E }));
    assert!(touch(s.key(), a, Phase::Move, 0, 20.0, 10.0, 2));
    assert_eq!(detach(s.key(), a, LONG), Detached::Released);
    assert!(!touch(s.key(), a, Phase::Up, 0, 20.0, 10.0, 3), "after detach");
    let (win, _) = window();
    let b = attach(s.key(), win, E).unwrap();
    assert!(!touch(s.key(), b, Phase::Move, 0, 20.0, 10.0, 4), "the old pointer is unknown to the new attachment");
    assert!(touch(s.key(), b, Phase::Down, 0, 20.0, 10.0, 5));
    let mut out = Vec::new();
    s.drain_touch(&mut out);
    let summary: Vec<_> = out.iter().map(|r| match r {
        TouchRecord::Event(e) => format!("{}:{}:{:?}:{}", e.attachment == a, e.id, e.phase, e.extent.scale),
        TouchRecord::Reset { attachment, reason } => format!("reset:{}:{reason:?}", *attachment == a),
    }).collect();
    assert_eq!(summary, ["true:1:Down:2", "true:1:Move:4", "reset:true:Detached", "false:2:Down:2"]);
    assert!(matches!(out[3], TouchRecord::Event(e) if e.phase == TouchPhase::Down && e.attachment == b));
    s.close();
    s.drain_touch(&mut out);
    assert!(matches!(out[..], [TouchRecord::Reset { reason: ResetReason::Closed, .. }]));
    assert!(!touch(s.key(), b, Phase::Down, 1, 0.0, 0.0, 6), "closed");
    let (counters, active) = s.touch_counters();
    assert_eq!((counters.resets, active), (2, 0));
    assert_eq!(detach(s.key(), b, LONG), Detached::Released);
}

#[test]
fn a_browser_instance_binds_its_owner_once_and_reports_it() {
    let cell = AtomicU32::new(0);
    assert_eq!(bind_once(&cell, 0), 0, "owner 0 is out of range; still unbound");
    assert_eq!(bind_once(&cell, OWNER_LIMIT), 0, "out of range; still unbound");
    assert_eq!(bind_once(&cell, 3), 3, "binds");
    assert_eq!(bind_once(&cell, 3), 3, "the same owner again");
    assert_eq!(bind_once(&cell, 9), 3, "another candidate gets the owner it is bound to");
    assert_eq!(bind_once(&cell, 0), 3, "never changes");
    assert_eq!(bind_once(&cell, OWNER_LIMIT - 1), 3);
}
