//! Render-loop tests with a scriptable fake presenter. Tests that spawn render threads hold
//! [`SERIAL`] so the process-wide thread counts are deterministic.
use super::*;
use crate::timing::EventRing;
use crate::frame::encode;
use raw_window_handle::{AndroidDisplayHandle, AndroidNdkWindowHandle, RawDisplayHandle, RawWindowHandle};
use rnrs_surface::platform::{self, AttachError, Detached};
use rnrs_surface::PlatformWindow;
use std::collections::VecDeque;
use std::sync::atomic::AtomicBool;
use std::ptr::NonNull;
use std::sync::mpsc;

pub(crate) static SERIAL: Mutex<()> = Mutex::new(());
pub(crate) fn serial() -> MutexGuard<'static, ()> {
    lock(&SERIAL)
}

struct FakeWindow(usize, Arc<AtomicUsize>);
impl PlatformWindow for FakeWindow {
    fn raw_window_handle(&self) -> Result<RawWindowHandle, raw_window_handle::HandleError> {
        Ok(RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(NonNull::<u8>::dangling().cast())))
    }
    fn raw_display_handle(&self) -> RawDisplayHandle {
        RawDisplayHandle::Android(AndroidDisplayHandle::new())
    }
    fn identity(&self) -> usize {
        self.0
    }
}
impl Drop for FakeWindow {
    fn drop(&mut self) {
        self.1.fetch_add(1, Ordering::SeqCst);
    }
}
static NEXT_ID: AtomicUsize = AtomicUsize::new(0x9000);

#[derive(Debug, PartialEq)]
enum Event {
    Prepare,
    Bind(u64, u32),
    Resize(u32),
    Unbind,
    ResetDevice,
    Present(usize),
    PresentRevoked,
    Dropped,
}

/// A blocking point the test opens one permit at a time. `entered` counts arrivals, so a test
/// waits for the render thread to be stalled there instead of sleeping.
#[derive(Default)]
struct Gate(Mutex<(bool, usize, usize)>, Condvar); // (enabled, permits, entered)
impl Gate {
    fn enable(&self) {
        lock(&self.0).0 = true;
    }
    fn pass(&self) {
        let mut g = lock(&self.0);
        g.2 += 1;
        self.1.notify_all();
        while g.0 && g.1 == 0 {
            g = self.1.wait(g).unwrap();
        }
        if g.0 {
            g.1 -= 1;
        }
    }
    /// Waits (failure guard: 5 s) until `n` arrivals in total have reached the gate.
    fn wait_entered(&self, n: usize) {
        let deadline = Instant::now() + T;
        let mut g = lock(&self.0);
        while g.2 < n {
            let now = Instant::now();
            assert!(now < deadline, "the render thread never reached the gate");
            g = self.1.wait_timeout(g, deadline - now).unwrap().0;
        }
    }
    fn release(&self) {
        lock(&self.0).1 += 1;
        self.1.notify_all();
    }
    fn open(&self) {
        lock(&self.0).0 = false;
        self.1.notify_all();
    }
}

/// Scripted results and gates shared between the test and the fake presenter.
#[derive(Default)]
struct Ctl {
    bind_results: Mutex<VecDeque<Result<(), String>>>,
    present_results: Mutex<VecDeque<PresentError>>,
    prepare_gate: Gate,
    /// Blocks inside present after the first admission (an admitted acquire in flight).
    present_gate: Gate,
    /// Device-lost flag, as the real device-lost callback sets it.
    lost: AtomicBool,
    /// Every present fails with this error (a persistent fault).
    always_fail: Mutex<Option<fn(String) -> PresentError>>,
    /// Drawable-timeout read-backs for the next binds' configures (default: confirmed).
    readbacks: Mutex<VecDeque<bool>>,
}

/// A layer transaction whose read-back is scripted (rnrs_surface::layer).
struct FakeTx(bool);
impl rnrs_surface::layer::LayerTransaction for FakeTx {
    fn begin(&mut self) {}
    fn disable_actions(&mut self) {}
    fn allow_drawable_timeout(&mut self) {}
    fn commit(&mut self) {}
    fn drawable_timeout_allowed(&mut self) -> bool {
        self.0
    }
}

struct Fake {
    events: mpsc::Sender<Event>,
    ctl: Arc<Ctl>,
    lease: Option<WindowLease>,
    device: bool,
    acquire_allowed: bool,
}
impl Presenter for Fake {
    fn device_lost(&self) -> bool {
        self.ctl.lost.load(Ordering::SeqCst)
    }
    fn prepare(&mut self) -> Result<(), String> {
        if !self.device {
            self.ctl.prepare_gate.pass();
            self.device = true;
            self.events.send(Event::Prepare).unwrap();
        }
        Ok(())
    }
    fn bind(&mut self, lease: WindowLease, extent: Extent) -> Result<(), String> {
        if let Some(Err(e)) = lock(&self.ctl.bind_results).pop_front() {
            return Err(e); // the lease is dropped: nothing retained on failure
        }
        // The configure runs in the scripted layer transaction, as on iOS.
        let readback = lock(&self.ctl.readbacks).pop_front().unwrap_or(true);
        let configured = rnrs_surface::layer::configure_in_transaction(&mut FakeTx(readback), || Ok::<(), String>(()));
        configured.result?;
        self.acquire_allowed = configured.acquire_allowed;
        self.events.send(Event::Bind(lease.attachment(), extent.width)).unwrap();
        self.lease = Some(lease);
        Ok(())
    }
    fn resize(&mut self, extent: Extent) -> Result<(), String> {
        self.events.send(Event::Resize(extent.width)).unwrap();
        Ok(())
    }
    fn unbind(&mut self) {
        if self.lease.take().is_some() {
            self.events.send(Event::Unbind).unwrap();
        }
    }
    fn reset_device(&mut self) {
        self.device = false;
        self.ctl.lost.store(false, Ordering::SeqCst);
        self.events.send(Event::ResetDevice).unwrap();
    }
    fn present(&mut self, cmds: &[Cmd], _extent: Extent) -> Result<Timings, PresentError> {
        if let Some(e) = lock(&self.ctl.present_results).pop_front() {
            return Err(e);
        }
        if let Some(make) = *lock(&self.ctl.always_fail) {
            return Err(make("persistent".into()));
        }
        let lease = self.lease.as_ref().expect("bound");
        // The renderer's admission order (render::present_admitted), with a fake swapchain.
        let mut acquired = false;
        let result = present_admitted(
            lease,
            self.acquire_allowed,
            || {
                acquired = true;
                self.ctl.present_gate.pass(); // "acquire" in flight, possibly stalled
                Ok(())
            },
            |()| (),
            |()| self.events.send(Event::Present(cmds.len())).unwrap(),
        );
        if acquired && result == Err(PresentError::Revoked) {
            self.events.send(Event::PresentRevoked).unwrap();
        }
        result.map(|()| Timings::default())
    }
    fn raster_size(&self, e: Extent) -> (u32, u32) {
        (e.width, e.height)
    }
    fn device_init_ms(&self) -> f64 {
        0.0
    }
    fn describe(&self) -> String {
        "fake".into()
    }
}
impl Drop for Fake {
    fn drop(&mut self) {
        let _ = self.events.send(Event::Dropped);
    }
}

const E: Extent = Extent { width: 100, height: 200, scale: 2.0 };
const T: Duration = Duration::from_secs(5);
const CAP: usize = 64;

struct Rig {
    surface: Surface,
    shared: Arc<Shared>,
    rx: mpsc::Receiver<Event>,
    ctl: Arc<Ctl>,
}
fn rig() -> Rig {
    let surface = Surface::new().unwrap();
    let (tx, rx) = mpsc::channel();
    let ctl = Arc::new(Ctl::default());
    let shared = spawn(&surface, Fake { events: tx, ctl: ctl.clone(), lease: None, device: false, acquire_allowed: false }, CAP).unwrap();
    Rig { surface, shared, rx, ctl }
}
fn window_with(id: usize) -> (Box<dyn PlatformWindow>, Arc<AtomicUsize>) {
    let released = Arc::new(AtomicUsize::new(0));
    (Box::new(FakeWindow(id, released.clone())), released)
}
fn attach(surface: &Surface, extent: Extent) -> (u64, Arc<AtomicUsize>, usize) {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let (w, released) = window_with(id);
    (platform::attach(surface.key(), w, extent).unwrap(), released, id)
}
fn next(rx: &mpsc::Receiver<Event>) -> Event {
    rx.recv_timeout(T).expect("event")
}
fn quiet(rx: &mpsc::Receiver<Event>) -> bool {
    rx.recv_timeout(Duration::from_millis(150)).is_err()
}
fn rect_frame(n: usize) -> Vec<u8> {
    let rect = [2.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
    encode(&rect.repeat(n))
}
fn wait_until(mut pred: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + T;
    while Instant::now() < end {
        if pred() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    pred()
}

#[test]
fn prepares_before_leasing_binds_presents_resizes_and_unbinds_on_detach() {
    let _s = serial();
    let r = rig();
    assert!(r.shared.submit(rect_frame(1)));
    let (a, released, _) = attach(&r.surface, E);
    assert_eq!(next(&r.rx), Event::Prepare, "the device is created before the lease is taken");
    assert_eq!(next(&r.rx), Event::Bind(a, 100));
    assert_eq!(next(&r.rx), Event::Present(1));
    assert_eq!(r.shared.stats().gpu, GpuState::Ready);
    assert!(platform::resize(r.surface.key(), a, Extent { width: 300, ..E }));
    assert_eq!(next(&r.rx), Event::Resize(300));
    assert_eq!(next(&r.rx), Event::Present(1), "presented again at the new size");
    assert_eq!(r.shared.stats().bound, Some((300, 200)));
    assert_eq!(platform::detach(r.surface.key(), a, T), Detached::Released);
    assert_eq!(released.load(Ordering::SeqCst), 1, "window released when detach returns");
    assert_eq!(next(&r.rx), Event::Unbind);
    let (b, _, _) = attach(&r.surface, E);
    assert_eq!(next(&r.rx), Event::Bind(b, 100), "same device, no second prepare");
    assert_eq!(next(&r.rx), Event::Present(1));
    r.shared.close();
    assert_eq!(next(&r.rx), Event::Unbind);
    assert_eq!(next(&r.rx), Event::Dropped);
    assert!(!r.shared.submit(rect_frame(1)), "closed: submit stores nothing");
}

#[test]
fn a_detach_during_device_creation_does_not_wait_for_it() {
    let _s = serial();
    let r = rig();
    r.ctl.prepare_gate.enable();
    let (a, released, _) = attach(&r.surface, E);
    r.ctl.prepare_gate.wait_entered(1); // the thread is stalled in prepare(), no lease
    let started = Instant::now();
    assert_eq!(platform::detach(r.surface.key(), a, T), Detached::Released);
    assert!(started.elapsed() < Duration::from_millis(100));
    assert_eq!(released.load(Ordering::SeqCst), 1);
    r.ctl.prepare_gate.open();
    assert_eq!(next(&r.rx), Event::Prepare);
    assert!(quiet(&r.rx), "nothing to bind after the detach");
    r.shared.close();
}

#[test]
fn frames_coalesce_to_the_latest_while_presenting() {
    let _s = serial();
    let r = rig();
    r.ctl.present_gate.enable();
    let (a, _, _) = attach(&r.surface, E);
    assert_eq!(next(&r.rx), Event::Prepare);
    assert_eq!(next(&r.rx), Event::Bind(a, 100));
    assert!(r.shared.submit(rect_frame(1)));
    r.ctl.present_gate.wait_entered(1); // blocked in present(1)
    for n in 2..=4 {
        assert!(r.shared.submit(rect_frame(n)));
    }
    r.ctl.present_gate.release();
    assert_eq!(next(&r.rx), Event::Present(1));
    r.ctl.present_gate.release();
    assert_eq!(next(&r.rx), Event::Present(4), "only the latest pending frame is drawn");
    let s = r.shared.stats();
    assert_eq!((s.frames_submitted, s.frames_replaced), (4, 2));
    r.ctl.present_gate.open();
    r.shared.close();
}

/// Admitted acquire stalled → detach times out → completion → no present (second admission
/// refused) → unbind → window released exactly once. Meanwhile the same window cannot attach
/// to a second key; after the release the retry succeeds.
#[test]
fn stalled_presenter_timeout_no_present_after_revocation_and_same_window_waits() {
    let _s = serial();
    let r = rig();
    r.ctl.present_gate.enable();
    let (a, released, id) = attach(&r.surface, E);
    assert_eq!(next(&r.rx), Event::Prepare);
    assert_eq!(next(&r.rx), Event::Bind(a, 100));
    assert!(r.shared.submit(rect_frame(1)));
    r.ctl.present_gate.wait_entered(1); // admitted "acquire" stalled
    let started = Instant::now();
    assert_eq!(platform::detach(r.surface.key(), a, Duration::from_millis(40)), Detached::TimedOut { in_flight: 1 });
    assert!(started.elapsed() < Duration::from_millis(200), "the UI wait is bounded by its budget");
    assert_eq!(released.load(Ordering::SeqCst), 0, "retained while the renderer holds it");
    let other = Surface::new().unwrap();
    let (same, same_released) = window_with(id);
    assert_eq!(platform::attach(other.key(), same, E), Err(AttachError::WindowBusy));
    assert_eq!(same_released.load(Ordering::SeqCst), 1);
    r.ctl.present_gate.release();
    assert_eq!(next(&r.rx), Event::PresentRevoked, "the late acquire is not followed by a present");
    assert_eq!(next(&r.rx), Event::Unbind);
    assert!(wait_until(|| released.load(Ordering::SeqCst) == 1), "released exactly once after the unbind");
    let (same, _) = window_with(id);
    assert!(platform::attach(other.key(), same, E).is_ok(), "the platform's retry succeeds");
    assert_eq!(r.surface.snapshot().counters.detach_timeouts_in_flight, 1);
    r.ctl.present_gate.open();
    r.shared.close();
    assert!(quiet_until_dropped(&r.rx));
    assert_eq!(released.load(Ordering::SeqCst), 1, "still exactly once");
}
fn quiet_until_dropped(rx: &mpsc::Receiver<Event>) -> bool {
    loop {
        match rx.recv_timeout(T) {
            Ok(Event::Dropped) => return true,
            Ok(Event::Present(_)) => return false,
            Ok(_) => {}
            Err(_) => return false,
        }
    }
}

#[test]
fn device_loss_drops_everything_then_recovers_with_a_new_device() {
    let _s = serial();
    let r = rig();
    let (a, _, _) = attach(&r.surface, E);
    assert_eq!(next(&r.rx), Event::Prepare);
    assert_eq!(next(&r.rx), Event::Bind(a, 100));
    lock(&r.ctl.present_results).push_back(PresentError::DeviceLost("test".into()));
    assert!(r.shared.submit(rect_frame(1)));
    assert_eq!(next(&r.rx), Event::Unbind);
    assert_eq!(next(&r.rx), Event::ResetDevice, "old resources dropped before a new device");
    assert_eq!(r.shared.stats().gpu, GpuState::Recovering);
    assert!(r.shared.submit(rect_frame(2)), "submit stays true while recovering");
    assert_eq!(next(&r.rx), Event::Prepare, "new device after the backoff");
    assert_eq!(next(&r.rx), Event::Bind(a, 100));
    assert_eq!(next(&r.rx), Event::Present(2));
    let s = r.shared.stats();
    assert_eq!((s.gpu, s.device_losses), (GpuState::Ready, 1));
    assert!(s.last_error.unwrap().contains("device lost"));
    r.shared.close();
}

#[test]
fn surface_loss_recreates_the_surface() {
    let _s = serial();
    let r = rig();
    let (a, _, _) = attach(&r.surface, E);
    assert_eq!(next(&r.rx), Event::Prepare);
    assert_eq!(next(&r.rx), Event::Bind(a, 100));
    lock(&r.ctl.present_results).push_back(PresentError::SurfaceLost("test".into()));
    assert!(r.shared.submit(rect_frame(1)));
    assert_eq!(next(&r.rx), Event::Unbind);
    assert_eq!(next(&r.rx), Event::Bind(a, 100), "a new surface on the same attachment");
    assert_eq!(next(&r.rx), Event::Present(1));
    assert_eq!(r.shared.stats().surface_recreations, 1);
    r.shared.close();
}

#[test]
fn repeated_bind_failures_back_off_then_fail_until_a_new_attachment() {
    let _s = serial();
    let r = rig();
    for _ in 0..MAX_RECOVERY_ATTEMPTS {
        lock(&r.ctl.bind_results).push_back(Err("no".into()));
    }
    let started = Instant::now();
    let (a, _, _) = attach(&r.surface, E);
    assert_eq!(next(&r.rx), Event::Prepare);
    assert!(wait_until(|| r.shared.stats().gpu == GpuState::Failed));
    let elapsed = started.elapsed();
    // 100 + 200 + 400 + 800 + 1600 ms of backoff between the six attempts.
    assert!(elapsed >= Duration::from_millis(3000), "backed off: {elapsed:?}");
    assert_eq!(r.shared.stats().recovery_attempts, MAX_RECOVERY_ATTEMPTS as u64);
    assert!(r.shared.submit(rect_frame(1)), "failed GPU: submit still true (only closed is false)");
    assert!(quiet(&r.rx), "no retries once failed");
    assert_eq!(platform::detach(r.surface.key(), a, T), Detached::Released);
    let (b, _, _) = attach(&r.surface, E);
    assert_eq!(next(&r.rx), Event::Bind(b, 100), "a new attachment gets fresh attempts");
    assert_eq!(next(&r.rx), Event::Present(1));
    assert_eq!(r.shared.stats().gpu, GpuState::Ready);
    r.shared.close();
}

#[test]
fn zero_extent_unbinds_and_invalid_frames_are_counted() {
    let _s = serial();
    let r = rig();
    let (a, _, _) = attach(&r.surface, E);
    assert_eq!(next(&r.rx), Event::Prepare);
    assert_eq!(next(&r.rx), Event::Bind(a, 100));
    assert!(r.shared.submit(vec![0; 12]), "malformed content is accepted by submit, rejected by the thread");
    assert!(platform::resize(r.surface.key(), a, Extent { width: 0, ..E }));
    assert_eq!(next(&r.rx), Event::Unbind);
    assert!(platform::resize(r.surface.key(), a, E));
    assert_eq!(next(&r.rx), Event::Bind(a, 100));
    assert_eq!(r.shared.stats().frames_invalid, 1);
    assert!(quiet(&r.rx), "nothing valid to present");
    r.shared.close();
}

#[test]
fn the_cap_counts_retiring_threads_until_they_exit() {
    let _s = serial();
    // Earlier tests' closed renderers may still be exiting.
    assert!(wait_until(|| process_counts().1 == 0), "no render threads left from earlier tests");
    let before = 0;
    let stalled = rig();
    stalled.ctl.present_gate.enable();
    let (a, _, _) = attach(&stalled.surface, E);
    assert_eq!(next(&stalled.rx), Event::Prepare);
    assert_eq!(next(&stalled.rx), Event::Bind(a, 100));
    assert!(stalled.shared.submit(rect_frame(1)));
    stalled.ctl.present_gate.wait_entered(1); // stalled "GPU"
    let started = Instant::now();
    stalled.shared.close();
    assert!(started.elapsed() < Duration::from_millis(20), "close returns while the presenter is stalled");
    // The closed renderer's thread is still retiring: it holds its slot.
    assert_eq!(process_counts().1, before + 1);
    let surface = Surface::new().unwrap();
    let (tx, _rx) = mpsc::channel();
    let fake = Fake { events: tx, ctl: Arc::new(Ctl::default()), lease: None, device: false, acquire_allowed: false };
    let err = spawn(&surface, fake, before + 1).map(|_| ()).unwrap_err();
    assert!(err.contains("renderer limit reached") && err.contains("still releasing"), "{err}");
    stalled.ctl.present_gate.open();
    assert!(wait_until(|| process_counts().1 == before), "slot released at thread exit");
    platform::detach(stalled.surface.key(), a, T);
}

/// Bind always succeeds, every present fails: a successful bind must not reset the attempt
/// budget, so the cycle ends in "failed" after MAX_RECOVERY_ATTEMPTS presents, with no more
/// binds until a new attachment.
#[test]
fn bind_then_fail_cycles_are_bounded() {
    for (name, make) in [("failed", PresentError::Failed as fn(String) -> PresentError), ("device lost", PresentError::DeviceLost)] {
        let _s = serial();
        let r = rig();
        *lock(&r.ctl.always_fail) = Some(make);
        let (a, _, _) = attach(&r.surface, E);
        assert!(r.shared.submit(rect_frame(1)));
        assert!(wait_until(|| r.shared.stats().gpu == GpuState::Failed), "{name}: reached failed");
        let binds = std::iter::from_fn(|| r.rx.recv_timeout(Duration::from_millis(300)).ok()).filter(|e| matches!(e, Event::Bind(..))).count();
        assert_eq!(binds, MAX_RECOVERY_ATTEMPTS as usize, "{name}: one bind per attempt, then none");
        assert_eq!(r.shared.stats().recovery_attempts, MAX_RECOVERY_ATTEMPTS as u64, "{name}");
        assert!(r.shared.submit(rect_frame(1)), "{name}: submit still accepted");
        // A new attachment starts over (and succeeds once the fault is gone).
        *lock(&r.ctl.always_fail) = None;
        assert_eq!(platform::detach(r.surface.key(), a, T), Detached::Released);
        let (b, _, _) = attach(&r.surface, E);
        assert!(wait_until(|| r.shared.stats().gpu == GpuState::Ready), "{name}: recovered on the new attachment");
        let _ = b;
        r.shared.close();
    }
}

/// A device lost while no window is attached (backgrounded) is replaced before the next bind.
#[test]
fn a_device_lost_while_unbound_is_replaced_before_binding() {
    let _s = serial();
    let r = rig();
    let (a, _, _) = attach(&r.surface, E);
    assert_eq!(next(&r.rx), Event::Prepare);
    assert_eq!(next(&r.rx), Event::Bind(a, 100));
    assert_eq!(platform::detach(r.surface.key(), a, T), Detached::Released);
    assert_eq!(next(&r.rx), Event::Unbind);
    r.ctl.lost.store(true, Ordering::SeqCst); // lost in the background
    let (b, _, _) = attach(&r.surface, E);
    assert_eq!(next(&r.rx), Event::ResetDevice);
    assert_eq!(next(&r.rx), Event::Prepare);
    assert_eq!(next(&r.rx), Event::Bind(b, 100));
    assert_eq!(r.shared.stats().device_losses, 1);
    r.shared.close();
}

/// The diagnostics ring: submits get frame IDs in order; presents name the frame they drew and
/// the attachment; sequence numbers are consecutive.
#[test]
fn event_ring_records_submits_and_presents_with_frame_ids() {
    let _s = serial();
    let surface = Surface::new().unwrap();
    let (tx, rx) = mpsc::channel();
    let ctl = Arc::new(Ctl::default());
    let shared = spawn_with(&surface, Fake { events: tx, ctl, lease: None, device: false, acquire_allowed: false }, CAP, EventRing::new(64).unwrap()).unwrap();
    let (a, _, _) = attach(&surface, E);
    assert_eq!(next(&rx), Event::Prepare);
    assert_eq!(next(&rx), Event::Bind(a, 100));
    for n in 1..=3 {
        assert!(shared.submit(rect_frame(n)));
        assert_eq!(next(&rx), Event::Present(n));
    }
    let b = shared.drain_timings();
    let u32_at = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap());
    let count = u32_at(8) as usize;
    let records: Vec<(u32, u32, u32, u16)> = (0..count)
        .map(|i| {
            let o = 40 + i * 24;
            (u32_at(o + 8), u32_at(o + 12), u32_at(o + 16), u16::from_le_bytes(b[o + 20..o + 22].try_into().unwrap()))
        })
        .collect();
    let seqs: Vec<u32> = records.iter().map(|r| r.0).collect();
    assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1), "consecutive sequence numbers: {seqs:?}");
    let submits: Vec<u32> = records.iter().filter(|r| r.3 == 1).map(|r| r.1).collect();
    assert_eq!(submits, [1, 2, 3]);
    let presents: Vec<(u32, u32)> = records.iter().filter(|r| r.3 == 2).map(|r| (r.1, r.2)).collect();
    assert_eq!(presents, [(1, a as u32), (2, a as u32), (3, a as u32)]);
    shared.close();
}

/// What the diagnostics ring must not change: the presenter calls, submit results, counters,
/// errors and lifecycle of one barrier-controlled script. Timing values are excluded; no
/// performance equivalence is claimed.
#[derive(Debug, PartialEq)]
struct Visible {
    events: Vec<Event>,
    submits: Vec<bool>,
    counters: [u64; 8],
    gpu: GpuState,
    bound: Option<(u32, u32)>,
    presentation: String,
    last_error: Option<String>,
}

/// Each step waits for the render thread (present gate, events, counters) before the next, so
/// the interleaving is fixed by the test, not by scheduling.
fn scripted_run(ring: EventRing) -> (Visible, Vec<u8>) {
    let surface = Surface::new().unwrap();
    let (tx, rx) = mpsc::channel();
    let ctl = Arc::new(Ctl::default());
    let shared = spawn_with(&surface, Fake { events: tx, ctl: ctl.clone(), lease: None, device: false, acquire_allowed: false }, CAP, ring).unwrap();
    ctl.present_gate.enable();
    let mut submits = Vec::new();
    let (a, _, _) = attach(&surface, E);
    // Attachment numbers are process-wide and never reused: recorded as 1 for this run's.
    let mut events = Vec::new();
    let mut expect = |want: Event| {
        let got = next(&rx);
        assert_eq!(got, want);
        events.push(match got {
            Event::Bind(x, w) if x == a => Event::Bind(1, w),
            other => other,
        });
    };
    expect(Event::Prepare);
    expect(Event::Bind(a, 100));
    // Coalescing: frames 2 and 3 are replaced while frame 1 is in present.
    submits.push(shared.submit(rect_frame(1)));
    ctl.present_gate.wait_entered(1);
    for n in 2..=4 {
        submits.push(shared.submit(rect_frame(n)));
    }
    ctl.present_gate.release();
    expect(Event::Present(1));
    ctl.present_gate.wait_entered(2);
    ctl.present_gate.release();
    expect(Event::Present(4));
    // An invalid frame: counted, not drawn; the last valid frame (4) is presented again.
    submits.push(shared.submit(vec![0; 12]));
    ctl.present_gate.wait_entered(3);
    ctl.present_gate.release();
    expect(Event::Present(4));
    submits.push(shared.submit(rect_frame(5)));
    ctl.present_gate.wait_entered(4);
    ctl.present_gate.release();
    expect(Event::Present(5));
    // A visible error: surface lost, recovered on the same attachment.
    lock(&ctl.present_results).push_back(PresentError::SurfaceLost("scripted".into()));
    submits.push(shared.submit(rect_frame(6)));
    expect(Event::Unbind);
    expect(Event::Bind(a, 100));
    ctl.present_gate.wait_entered(5);
    ctl.present_gate.release();
    expect(Event::Present(6));
    // Lifecycle: detach, close, then submit after close.
    assert_eq!(platform::detach(surface.key(), a, T), Detached::Released);
    expect(Event::Unbind);
    ctl.present_gate.open();
    shared.close();
    expect(Event::Dropped);
    assert!(wait_until(|| render_threads_alive_now() == 0));
    submits.push(shared.submit(rect_frame(7)));
    let s = shared.stats();
    let visible = Visible {
        events,
        submits,
        counters: [s.frames_submitted, s.frames_presented, s.frames_replaced, s.frames_invalid, s.surface_errors, s.surface_recreations, s.device_losses, s.recovery_attempts],
        gpu: s.gpu,
        bound: s.bound,
        presentation: s.presentation,
        last_error: s.last_error,
    };
    (visible, shared.drain_timings())
}

fn render_threads_alive_now() -> usize {
    process_counts().1
}

#[test]
fn the_event_ring_does_not_change_visible_behaviour() {
    let _s = serial();
    let (off, off_ring) = scripted_run(EventRing::default());
    let (on, on_ring) = scripted_run(EventRing::new(256).unwrap());
    assert_eq!(off, on, "same presenter calls, submit results, counters, errors and lifecycle");
    assert_eq!(off.submits, [true, true, true, true, true, true, true, false]);
    assert_eq!((off.counters[0], off.counters[2], off.counters[3], off.counters[5]), (7, 2, 1, 1), "submitted, replaced, invalid, surface recreations");
    assert!(off_ring.is_empty(), "disabled: nothing recorded");
    // Enabled: the accepted and presented frame IDs of the same script (the invalid frame is 5).
    let u32_at = |i: usize| u32::from_le_bytes(on_ring[i..i + 4].try_into().unwrap());
    let records: Vec<(u32, u16)> = (0..u32_at(8) as usize)
        .map(|i| (u32_at(40 + i * 24 + 12), u16::from_le_bytes(on_ring[40 + i * 24 + 20..40 + i * 24 + 22].try_into().unwrap())))
        .collect();
    let of = |k: u16| records.iter().filter(|r| r.1 == k).map(|r| r.0).collect::<Vec<_>>();
    assert_eq!(of(1), [1, 2, 3, 4, 5, 6, 7], "accepted submits; none after close");
    assert_eq!(of(2), [1, 4, 4, 6, 7], "presented: 2, 3 replaced; 5 invalid, so 4 again");
    assert_eq!(of(3), [7], "the present that lost the surface");
}

/// Kind 3 is every unsuccessful present call, whatever the error: skipped, revoked, surface
/// lost, device lost or failed. The error kinds are not distinguished in the ring.
#[test]
fn the_event_ring_records_every_unsuccessful_present_as_kind_3() {
    let _s = serial();
    let surface = Surface::new().unwrap();
    let (tx, rx) = mpsc::channel();
    let ctl = Arc::new(Ctl::default());
    let shared = spawn_with(&surface, Fake { events: tx, ctl: ctl.clone(), lease: None, device: false, acquire_allowed: false }, CAP, EventRing::new(256).unwrap()).unwrap();
    let (a, _, _) = attach(&surface, E);
    assert_eq!(next(&rx), Event::Prepare);
    assert_eq!(next(&rx), Event::Bind(a, 100));
    let fail_then_submit = |e: PresentError, n: usize| {
        lock(&ctl.present_results).push_back(e);
        assert!(shared.submit(rect_frame(n)));
        assert!(wait_until(|| lock(&ctl.present_results).is_empty()), "the scripted error was returned");
    };
    // Skipped and revoked: nothing else happens; the next frame presents.
    fail_then_submit(PresentError::Skipped("scripted".into()), 1);
    assert!(shared.submit(rect_frame(2)));
    assert_eq!(next(&rx), Event::Present(2));
    fail_then_submit(PresentError::Revoked, 3);
    assert!(shared.submit(rect_frame(4)));
    assert_eq!(next(&rx), Event::Present(4));
    // Surface lost, device lost, failed: recovery presents the same frame again.
    fail_then_submit(PresentError::SurfaceLost("scripted".into()), 5);
    assert_eq!(next(&rx), Event::Unbind);
    assert_eq!(next(&rx), Event::Bind(a, 100));
    assert_eq!(next(&rx), Event::Present(5));
    fail_then_submit(PresentError::DeviceLost("scripted".into()), 6);
    assert_eq!(next(&rx), Event::Unbind);
    assert_eq!(next(&rx), Event::ResetDevice);
    assert_eq!(next(&rx), Event::Prepare);
    assert_eq!(next(&rx), Event::Bind(a, 100));
    assert_eq!(next(&rx), Event::Present(6));
    fail_then_submit(PresentError::Failed("scripted".into()), 7);
    assert_eq!(next(&rx), Event::Unbind);
    assert_eq!(next(&rx), Event::Bind(a, 100));
    assert_eq!(next(&rx), Event::Present(7));
    shared.close();
    assert_eq!(next(&rx), Event::Unbind);
    let b = shared.drain_timings();
    let u32_at = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap());
    let presents: Vec<(u32, u16)> = (0..u32_at(8) as usize)
        .map(|i| (u32_at(40 + i * 24 + 12), u16::from_le_bytes(b[40 + i * 24 + 20..40 + i * 24 + 22].try_into().unwrap())))
        .filter(|r| r.1 != 1)
        .collect();
    assert_eq!(presents, [(1, 3), (2, 2), (3, 3), (4, 2), (5, 3), (5, 2), (6, 3), (6, 2), (7, 3), (7, 2)]);
}

/// The admission order on a real lease: refused acquires start nothing; a revocation before
/// the acquire starts no acquire; a revocation after it drops the frame unsubmitted.
#[test]
fn present_admitted_orders_acquire_and_submit_under_admission() {
    let _s = serial();
    let surface = Surface::new().unwrap();
    let calls = std::cell::RefCell::new(Vec::new());
    let run = |lease: &WindowLease, allowed: bool, revoke_in_prepare: Option<(u64, u64)>| {
        calls.borrow_mut().clear();
        present_admitted(
            lease,
            allowed,
            || {
                calls.borrow_mut().push("acquire");
                Ok("frame")
            },
            |f| {
                calls.borrow_mut().push("prepare");
                if let Some((key, a)) = revoke_in_prepare {
                    platform::revoke_async(key, a);
                }
                f
            },
            |_| calls.borrow_mut().push("submit"),
        )
    };
    let (a, _, _) = attach(&surface, E);
    let lease = surface.lease().unwrap();
    assert_eq!(run(&lease, true, None), Ok(()));
    assert_eq!(*calls.borrow(), ["acquire", "prepare", "submit"]);
    assert_eq!(run(&lease, false, None), Err(PresentError::Failed(ACQUIRE_REFUSED.into())));
    assert!(calls.borrow().is_empty(), "a refused acquire starts nothing");
    assert_eq!(run(&lease, true, Some((surface.key(), a))), Err(PresentError::Revoked));
    assert_eq!(*calls.borrow(), ["acquire", "prepare"], "no submit after the revocation");
    assert_eq!(run(&lease, true, None), Err(PresentError::Revoked));
    assert!(calls.borrow().is_empty(), "no acquire after the revocation");
}

/// SurfaceLease drops the surface before the lease that keeps the window alive.
#[test]
fn the_surface_is_dropped_before_the_lease_that_keeps_the_window() {
    let _s = serial();
    let order = Arc::new(Mutex::new(Vec::new()));
    struct Rec(&'static str, Arc<Mutex<Vec<&'static str>>>);
    impl Drop for Rec {
        fn drop(&mut self) {
            lock(&self.1).push(self.0);
        }
    }
    struct RecWindow(usize, #[allow(dead_code)] Rec); // the Rec records the window's drop
    impl PlatformWindow for RecWindow {
        fn raw_window_handle(&self) -> Result<RawWindowHandle, raw_window_handle::HandleError> {
            Err(raw_window_handle::HandleError::NotSupported)
        }
        fn raw_display_handle(&self) -> RawDisplayHandle {
            RawDisplayHandle::Android(AndroidDisplayHandle::new())
        }
        fn identity(&self) -> usize {
            self.0
        }
    }
    let surface = Surface::new().unwrap();
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let a = platform::attach(surface.key(), Box::new(RecWindow(id, Rec("window", order.clone()))), E).unwrap();
    let bound = SurfaceLease { surface: Rec("surface", order.clone()), lease: surface.lease().unwrap() };
    assert!(matches!(platform::revoke_async(surface.key(), a), platform::Revoked::Retiring { .. }));
    assert!(lock(&order).is_empty(), "the lease keeps the window alive after the revocation");
    drop(bound);
    assert_eq!(*lock(&order), ["surface", "window"]);
}

/// A drawable-timeout read-back of NO: no acquire is admitted, the present fails like a bind
/// failure (unbind, then the bounded recovery backoff rebinds and reconfigures), and the stats
/// show it. It neither spins nor stops silently.
#[test]
fn a_failed_timeout_readback_refuses_acquires_and_recovers_by_rebinding() {
    let _s = serial();
    let r = rig();
    lock(&r.ctl.readbacks).push_back(false); // the first bind's configure is not confirmed
    let (a, _, _) = attach(&r.surface, E);
    assert_eq!(next(&r.rx), Event::Prepare);
    assert_eq!(next(&r.rx), Event::Bind(a, 100));
    assert!(r.shared.submit(rect_frame(1)));
    assert_eq!(next(&r.rx), Event::Unbind, "the refused acquire unbinds");
    let unbound = Instant::now();
    assert_eq!(next(&r.rx), Event::Bind(a, 100), "rebinds (and reconfigures) after the backoff");
    assert!(unbound.elapsed() >= Duration::from_millis(90), "not a spin: waited {:?}", unbound.elapsed());
    assert_eq!(next(&r.rx), Event::Present(1));
    let s = r.shared.stats();
    assert_eq!(s.recovery_attempts, 1);
    assert_eq!(s.frames_presented, 1);
    assert!(s.last_error.as_deref().is_some_and(|e| e.contains("drawable timeout")), "{:?}", s.last_error);
    r.shared.close();
}

/// A read-back that never confirms ends in the failed state after the bounded attempts, with
/// no further binds: no endless loop.
#[test]
fn a_persistently_failed_readback_stops_after_the_bounded_attempts() {
    let _s = serial();
    let r = rig();
    lock(&r.ctl.readbacks).extend(std::iter::repeat_n(false, 64));
    let _a = attach(&r.surface, E);
    assert!(r.shared.submit(rect_frame(1)));
    assert!(wait_until(|| r.shared.stats().gpu == GpuState::Failed));
    assert_eq!(r.shared.stats().recovery_attempts, MAX_RECOVERY_ATTEMPTS as u64);
    assert_eq!(r.shared.stats().frames_presented, 0);
    r.shared.close();
}

/// An outdated swapchain is reconfigured only while the attachment is current: after a
/// revocation no configure starts (no layer writes on a revoked window).
#[test]
fn an_outdated_swapchain_is_not_reconfigured_after_revocation() {
    let _s = serial();
    let surface = Surface::new().unwrap();
    let (a, _, _) = attach(&surface, E);
    let lease = surface.lease().unwrap();
    let mut configures = 0;
    assert_eq!(reconfigure_outdated(&lease, || { configures += 1; Ok(()) }), PresentError::Skipped("swapchain outdated; reconfigured".into()));
    assert_eq!(reconfigure_outdated(&lease, || Err("lost".into())), PresentError::SurfaceLost("lost".into()));
    // A revocation during the reconfigure sees it in flight (it holds an admission).
    let mut seen = None;
    let out = reconfigure_outdated(&lease, || {
        seen = Some(platform::revoke_async(surface.key(), a));
        configures += 1;
        Ok(())
    });
    assert_eq!(seen, Some(platform::Revoked::Retiring { in_flight: 1 }), "the configure is counted in flight");
    assert_eq!(out, PresentError::Skipped("swapchain outdated; reconfigured".into()), "the admitted configure completes");
    assert_eq!(reconfigure_outdated(&lease, || { configures += 1; Ok(()) }), PresentError::Revoked);
    assert_eq!(configures, 2, "no configure after the revocation");
}

/// Configures (bind, resize, Outdated) run under one admission: refused after a revocation,
/// counted in flight while they run, released when they return.
#[test]
fn configures_are_admitted_and_refused_after_revocation() {
    let _s = serial();
    let surface = Surface::new().unwrap();
    let (a, _, _) = attach(&surface, E);
    let lease = surface.lease().unwrap();
    assert_eq!(admitted(&lease, || 7), Some(7));
    let mut seen = None;
    assert_eq!(admitted(&lease, || seen = Some(platform::revoke_async(surface.key(), a))), Some(()));
    assert_eq!(seen, Some(platform::Revoked::Retiring { in_flight: 1 }), "in flight during the configure");
    let mut ran = false;
    assert_eq!(admitted(&lease, || ran = true), None);
    assert!(!ran, "no configure after the revocation");
}
