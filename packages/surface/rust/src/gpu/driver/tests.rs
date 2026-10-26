//! The native render loop with a fake GPU backend (no device needed): lease and drop order,
//! revocation between acquire and present, resize, failure policy, device loss, reentrant
//! hooks, non-blocking close, touch while detached, and frame pacing on a virtual clock.
use std::collections::VecDeque;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use raw_window_handle::{AndroidDisplayHandle, AndroidNdkWindowHandle, HandleError, RawDisplayHandle, RawWindowHandle};

use super::*;
use crate::platform::{self, Detached, Revoked};
use crate::{touch, PlatformWindow};

type Log = Arc<Mutex<Vec<String>>>;
fn log(l: &Log, what: impl Into<String>) {
    l.lock().unwrap().push(what.into());
}
fn events(l: &Log) -> Vec<String> {
    l.lock().unwrap().clone()
}
fn count(l: &Log, what: &str) -> usize {
    events(l).iter().filter(|e| e.as_str() == what).count()
}

struct Window(usize);
impl PlatformWindow for Window {
    fn raw_window_handle(&self) -> Result<RawWindowHandle, HandleError> {
        Ok(RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(NonNull::<u8>::dangling().cast())))
    }
    fn raw_display_handle(&self) -> RawDisplayHandle {
        RawDisplayHandle::Android(AndroidDisplayHandle::new())
    }
}
static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(0x9000);
fn attach(surface: &Surface, extent: Extent) -> u64 {
    platform::attach(surface.key(), Box::new(Window(NEXT_WINDOW.fetch_add(1, Ordering::SeqCst))), extent).unwrap()
}
const E: Extent = Extent { width: 100, height: 50, scale: 1.0 };
const LONG: Duration = Duration::from_secs(5);

/// Waits (failure guard 5 s, real time) until `cond`.
fn until(what: &str, cond: impl Fn() -> bool) {
    let end = Instant::now() + LONG;
    while !cond() {
        assert!(Instant::now() < end, "timed out: {what}");
        thread::sleep(Duration::from_millis(1));
    }
}

/// What the fake backend does next.
#[derive(Default)]
struct Script {
    presents: VecDeque<&'static str>, // "skip", "fail", "reset", "loss"; default: present
    fail_create: bool,
    devices: usize,
    /// A fault reported for this device id (the device-lost callback having fired).
    fault: Option<(usize, String, bool)>,
}

struct Device {
    id: usize,
    log: Log,
}
impl Drop for Device {
    fn drop(&mut self) {
        log(&self.log, format!("drop device {}", self.id));
    }
}
struct Target {
    lease: WindowLease,
    log: Log,
}
impl Drop for Target {
    fn drop(&mut self) {
        log(&self.log, "drop target");
    }
}
struct FakeFrame {
    extent: Extent,
}

struct Fake {
    log: Log,
    script: Arc<Mutex<Script>>,
}

impl Backend for Fake {
    type Device = Device;
    type Target = Target;
    type Info = ();
    type Frame<'a> = FakeFrame;
    fn create_device(&mut self) -> Result<Device, String> {
        let mut s = self.script.lock().unwrap();
        s.devices += 1;
        log(&self.log, format!("device {}", s.devices));
        Ok(Device { id: s.devices, log: self.log.clone() })
    }
    fn fault(&self, d: &Device) -> Option<(String, bool)> {
        let s = self.script.lock().unwrap();
        s.fault.as_ref().filter(|f| f.0 == d.id).map(|f| (f.1.clone(), f.2))
    }
    fn adapter(&self, d: &Device) -> String {
        format!("fake {}", d.id)
    }
    fn bind(&mut self, _: &Device, lease: WindowLease, extent: Extent) -> Result<Target, String> {
        lease.admit().ok_or("revoked before configure")?;
        log(&self.log, format!("bind {}x{}", extent.width, extent.height));
        Ok(Target { lease, log: self.log.clone() })
    }
    fn info(&self, _: &Target) {}
    fn describe(&self, _: &Target) -> String {
        "Fake".into()
    }
    fn resize(&mut self, _: &Device, t: &mut Target, extent: Extent) -> Result<(), String> {
        let _admitted = t.lease.admit().ok_or("revoked before configure")?;
        log(&self.log, format!("resize {}x{}", extent.width, extent.height));
        Ok(())
    }
    fn scoped<T>(&mut self, _: &Device, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        f()
    }
    fn present(&mut self, d: &Device, t: &mut Target, extent: Extent, draw: &mut dyn FnMut(&mut FakeFrame) -> Result<Next, String>) -> Presented {
        if let Some((error, loss)) = self.fault(d) {
            return Presented::Reset { error, loss };
        }
        match self.script.lock().unwrap().presents.pop_front() {
            Some("skip") => return Presented::Skipped("timeout".into()),
            Some("fail") => return Presented::Failed("swapchain lost".into()),
            _ => {}
        }
        if t.lease.admit().is_none() {
            return Presented::Revoked;
        }
        let next = match draw(&mut FakeFrame { extent }) {
            Ok(next) => next,
            Err(e) => return Presented::Failed(format!("draw: {e}")),
        };
        let Some(_present) = t.lease.admit() else {
            log(&self.log, "dropped unpresented");
            return Presented::Revoked;
        };
        log(&self.log, "present");
        Presented::Done(next)
    }
}

struct Resources {
    log: Log,
}
impl Drop for Resources {
    fn drop(&mut self) {
        log(&self.log, "drop resources");
    }
}

type Hook = Box<dyn FnMut(u32) + Send>;
struct Renderer {
    log: Log,
    script: Arc<Mutex<Script>>,
    next: Next,
    fail_draw: bool,
    on_draw: Option<Hook>,
}
impl Drop for Renderer {
    fn drop(&mut self) {
        log(&self.log, "drop renderer");
    }
}
impl Client<Fake> for Renderer {
    type State = u32;
    type Resources = Resources;
    fn create(&mut self, d: &Device, _: &()) -> Result<Resources, String> {
        log(&self.log, format!("create on device {}", d.id));
        if self.script.lock().unwrap().fail_create {
            return Err("pipeline rejected".into());
        }
        Ok(Resources { log: self.log.clone() })
    }
    fn resized(&mut self, _: &mut Resources, _: &Device, e: Extent) -> Result<(), String> {
        log(&self.log, format!("resized {}x{}", e.width, e.height));
        Ok(())
    }
    fn draw(&mut self, _: &mut Resources, f: &mut FakeFrame, state: &u32) -> Result<Next, String> {
        log(&self.log, format!("draw {state} {}x{}", f.extent.width, f.extent.height));
        if let Some(hook) = self.on_draw.as_mut() {
            hook(*state);
        }
        if self.fail_draw {
            return Err("shader exploded".into());
        }
        Ok(self.next)
    }
    fn touch(&mut self, records: &[touch::TouchRecord]) {
        log(&self.log, format!("touch {}", records.len()));
    }
}

/// A virtual clock: timed waits return at once, advancing time to their deadline.
struct FakeClock {
    now: Mutex<Instant>,
    timed_waits: AtomicUsize,
}
impl FakeClock {
    fn new() -> Arc<Self> {
        Arc::new(Self { now: Mutex::new(Instant::now()), timed_waits: AtomicUsize::new(0) })
    }
}
impl Clock for Arc<FakeClock> {
    fn now(&self) -> Instant {
        *self.now.lock().unwrap()
    }
    fn wait<'a, T>(&self, wake: &Condvar, guard: MutexGuard<'a, T>, until: Option<Instant>) -> MutexGuard<'a, T> {
        match until {
            Some(at) => {
                self.timed_waits.fetch_add(1, Ordering::SeqCst);
                let mut now = self.now.lock().unwrap();
                *now = (*now).max(at);
                guard
            }
            None => wake.wait(guard).unwrap(),
        }
    }
}

struct Harness {
    surface: Surface,
    shared: Arc<Shared<u32>>,
    log: Log,
    script: Arc<Mutex<Script>>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        // Also stop after a failed assertion. Do not join here: an unwinding test may
        // still hold a gate the hook needs, released after this harness is dropped.
        self.shared.close();
        self.surface.close();
    }
}

impl Harness {
    fn start(next: Next, fail_draw: bool, on_draw: Option<Hook>) -> Self {
        Self::start_with(next, fail_draw, on_draw, RealClock, Duration::from_millis(1))
    }
    fn start_with(next: Next, fail_draw: bool, on_draw: Option<Hook>, clock: impl Clock, interval: Duration) -> Self {
        let surface = Surface::new().unwrap();
        surface.enable_touch();
        let shared = Arc::new(Shared::new());
        let waker = Arc::downgrade(&shared);
        surface.set_waker(move || {
            if let Some(s) = waker.upgrade() {
                s.surface_changed();
            }
        });
        let log: Log = Default::default();
        let script: Arc<Mutex<Script>> = Default::default();
        let (s, l, sc, sf) = (shared.clone(), log.clone(), script.clone(), surface.clone());
        let thread = thread::spawn(move || {
            let renderer = Renderer { log: l.clone(), script: sc.clone(), next, fail_draw, on_draw };
            run(&s, &sf, Fake { log: l, script: sc }, renderer, 0, &clock, interval);
        });
        Self { surface, shared, log, script, thread: Some(thread) }
    }
    fn close_and_join(&mut self) {
        self.shared.close();
        self.surface.close();
        self.thread.take().unwrap().join().unwrap();
    }
    fn status(&self) -> Status {
        self.shared.status()
    }
}

#[test]
fn attach_draw_detach_reattach_and_close_in_drop_order() {
    let mut h = Harness::start(Next::Wait, false, None);
    let a = attach(&h.surface, E);
    until("first present", || h.status().frames_presented == 1);
    assert_eq!(h.status().gpu, GpuState::Ready);
    assert_eq!(h.status().state, SurfaceState::Attached);
    assert_eq!(platform::detach(h.surface.key(), a, LONG), Detached::Released, "the thread drops the lease at once");
    until("detached", || count(&h.log, "drop target") == 1);
    let e = events(&h.log);
    let pos = |w: &str| e.iter().position(|x| x == w).unwrap();
    assert!(pos("drop resources") < pos("drop target"), "resources before swapchain: {e:?}");
    assert_eq!(e[..4], ["device 1", "bind 100x50", "create on device 1", "resized 100x50"], "device before lease");
    // A new attachment: new resources on the kept device.
    attach(&h.surface, Extent { width: 80, ..E });
    until("second present", || h.status().frames_presented == 2);
    assert_eq!(count(&h.log, "create on device 1"), 2, "resources are recreated per attachment");
    assert_eq!(count(&h.log, "device 1"), 1, "the device is kept across attachments");
    h.close_and_join();
    let e = events(&h.log);
    let tail: Vec<&str> = e[e.len() - 4..].iter().map(String::as_str).collect();
    assert_eq!(tail, ["drop resources", "drop target", "drop renderer", "drop device 1"], "exit drop order");
    assert_eq!(h.status().state, SurfaceState::Closed);
    assert!(!h.shared.set_state(1), "closed: false");
}

#[test]
fn a_revocation_between_acquire_and_present_drops_the_frame_unpresented() {
    // revoke_async changes process-wide retirement statistics (crate::tests).
    let _r = crate::tests::RETIREMENT.lock().unwrap_or_else(|e| e.into_inner());
    let key = Arc::new(Mutex::new((0u64, 0u64)));
    let k = key.clone();
    let (entered_tx, entered) = std::sync::mpsc::channel();
    let hook: Hook = Box::new(move |_| {
        entered_tx.send(()).unwrap();
        let (key, attachment) = *k.lock().unwrap();
        // From inside draw (no lock held): an iOS-style asynchronous revocation.
        assert_eq!(platform::revoke_async(key, attachment), Revoked::Retiring { in_flight: 0 });
    });
    let mut h = Harness::start(Next::Wait, false, Some(hook));
    // Attaching wakes the render thread immediately. Publish the returned attachment
    // while holding the same lock the hook reads, never exposing the initial (0, 0).
    let mut published = key.lock().unwrap();
    let a = attach(&h.surface, E);
    // Force the previously failing schedule: draw starts before publication finishes.
    entered.recv_timeout(LONG).unwrap();
    *published = (h.surface.key(), a);
    drop(published);
    until("revoked and released", || count(&h.log, "drop target") == 1);
    assert_eq!(count(&h.log, "dropped unpresented"), 1);
    assert_eq!(count(&h.log, "present"), 0);
    assert_eq!(h.status().frames_presented, 0);
    h.close_and_join();
}

#[test]
fn resize_reconfigures_and_calls_resized_without_new_resources() {
    let mut h = Harness::start(Next::Wait, false, None);
    let a = attach(&h.surface, E);
    until("first present", || h.status().frames_presented == 1);
    assert!(platform::resize(h.surface.key(), a, Extent { width: 30, height: 20, scale: 1.0 }));
    until("redrawn at the new size", || count(&h.log, "draw 0 30x20") == 1);
    let e = events(&h.log);
    assert!(e.contains(&"resize 30x20".to_string()) && e.contains(&"resized 30x20".to_string()), "{e:?}");
    assert_eq!(count(&h.log, "create on device 1"), 1);
    assert_eq!(h.status().width, 30);
    h.close_and_join();
}

#[test]
fn a_failure_ends_the_attachment_without_retry_and_a_new_attachment_tries_once() {
    let mut h = Harness::start(Next::Wait, false, None);
    h.script.lock().unwrap().fail_create = true;
    let a = attach(&h.surface, E);
    until("failed", || h.status().gpu == GpuState::Failed);
    assert_eq!(h.status().last_error.as_deref(), Some("pipeline rejected"));
    until("swapchain dropped", || count(&h.log, "drop target") == 1);
    // Changes to the failed attachment do not retry.
    h.shared.set_state(7);
    assert!(platform::resize(h.surface.key(), a, Extent { width: 90, ..E }));
    thread::sleep(Duration::from_millis(50));
    assert_eq!(count(&h.log, "create on device 1"), 1, "no retry on the same attachment");
    // A new attachment: one fresh attempt, which succeeds.
    h.script.lock().unwrap().fail_create = false;
    assert_eq!(platform::detach(h.surface.key(), a, LONG), Detached::Released);
    attach(&h.surface, E);
    until("presented", || h.status().frames_presented == 1);
    assert_eq!(h.status().gpu, GpuState::Ready);
    // A failed present ends it too (resources then swapchain), still without retry.
    h.script.lock().unwrap().presents.push_back("fail");
    h.shared.set_state(8);
    until("failed again", || h.status().gpu == GpuState::Failed);
    assert_eq!(h.status().last_error.as_deref(), Some("swapchain lost"));
    let e = events(&h.log);
    let last = |w: &str| e.iter().rposition(|x| x == w).unwrap();
    assert!(last("drop resources") < last("drop target"));
    h.close_and_join();
}

#[test]
fn a_failed_draw_ends_the_attachment() {
    let mut h = Harness::start(Next::Wait, true, None);
    attach(&h.surface, E);
    until("failed", || h.status().gpu == GpuState::Failed);
    assert_eq!(h.status().last_error.as_deref(), Some("draw: shader exploded"));
    assert_eq!(h.status().frames_presented, 0);
    h.close_and_join();
}

#[test]
fn a_lost_device_is_dropped_after_resources_and_swapchain_and_replaced_on_the_next_attachment() {
    let mut h = Harness::start(Next::Wait, false, None);
    let a = attach(&h.surface, E);
    until("presented", || h.status().frames_presented == 1);
    // The device-lost callback fires; the next frame sees it.
    h.script.lock().unwrap().fault = Some((1, "device lost (Unknown): gone".into(), true));
    h.shared.set_state(2);
    until("reset", || h.status().gpu == GpuState::Failed);
    until("lost device dropped", || count(&h.log, "drop device 1") == 1);
    let e = events(&h.log);
    let last = |w: &str| e.iter().rposition(|x| x == w).unwrap();
    assert!(last("drop resources") < last("drop target") && last("drop target") < last("drop device 1"), "{e:?}");
    assert_eq!(h.status().device_losses, 1);
    assert_eq!(platform::detach(h.surface.key(), a, LONG), Detached::Released);
    attach(&h.surface, E);
    until("new device presents", || h.status().frames_presented == 2);
    assert_eq!(count(&h.log, "device 2"), 1);
    h.close_and_join();
}

#[test]
fn hooks_may_set_state_and_close_from_inside_draw() {
    let shared_slot: Arc<Mutex<Option<Arc<Shared<u32>>>>> = Default::default();
    let slot = shared_slot.clone();
    let hook: Hook = Box::new(move |state| {
        let shared = slot.lock().unwrap().clone().unwrap();
        if state == 0 {
            assert!(shared.set_state(5), "set_state from a hook does not deadlock");
        } else {
            shared.close(); // close from a hook: the loop exits after this frame
        }
    });
    let mut h = Harness::start(Next::Wait, false, Some(hook));
    *shared_slot.lock().unwrap() = Some(h.shared.clone());
    attach(&h.surface, E);
    until("exited", || h.shared.exited());
    assert!(events(&h.log).contains(&"draw 5 100x50".to_string()));
    h.thread.take().unwrap().join().unwrap();
}

#[test]
fn close_and_drop_from_other_threads_never_wait_for_a_busy_render_thread() {
    let (entered_tx, entered) = std::sync::mpsc::channel();
    let release = Arc::new(Mutex::new(()));
    let held = release.lock().unwrap();
    let r = release.clone();
    let hook: Hook = Box::new(move |_| {
        entered_tx.send(()).unwrap();
        drop(r.lock().unwrap()); // blocks until the test releases it
    });
    let mut h = Harness::start(Next::Wait, false, Some(hook));
    attach(&h.surface, E);
    entered.recv_timeout(LONG).unwrap();
    let (s, sf) = (h.shared.clone(), h.surface.clone());
    let (closed_tx, closed) = std::sync::mpsc::channel();
    let closer = thread::spawn(move || {
        s.close();
        sf.close();
        closed_tx.send(()).unwrap();
    });
    closed.recv_timeout(LONG).expect("close must finish while the render hook remains blocked");
    closer.join().unwrap();
    assert!(!h.shared.set_state(1));
    drop(held);
    h.thread.take().unwrap().join().unwrap();
    assert_eq!(h.status().state, SurfaceState::Closed);
}

#[test]
fn touch_is_delivered_on_every_wake_also_after_detach() {
    let mut h = Harness::start(Next::Wait, false, None);
    let a = attach(&h.surface, E);
    until("presented", || h.status().frames_presented == 1);
    assert!(platform::touch(h.surface.key(), a, touch::Phase::Down, 1, 10.0, 10.0, 1));
    until("touch delivered", || events(&h.log).iter().any(|e| e.starts_with("touch ")));
    // Detach with the pointer down: the reset reaches the renderer although nothing is bound.
    let before = events(&h.log).iter().filter(|e| e.starts_with("touch ")).count();
    assert_eq!(platform::detach(h.surface.key(), a, LONG), Detached::Released);
    until("reset delivered while detached", || events(&h.log).iter().filter(|e| e.starts_with("touch ")).count() > before);
    until("detach status committed", || h.status().state == SurfaceState::Detached);
    assert_eq!(h.status().state, SurfaceState::Detached);
    h.close_and_join();
}

#[test]
fn pacing_idles_without_changes_and_caps_animation_and_skipped_presents() {
    // Wait: one frame, then no timed waits and no frames until a change.
    let clock = FakeClock::new();
    let mut h = Harness::start_with(Next::Wait, false, None, clock.clone(), frame_interval(60));
    attach(&h.surface, E);
    until("presented", || h.status().frames_presented == 1);
    thread::sleep(Duration::from_millis(30));
    assert_eq!(h.status().frames_presented, 1, "idle: nothing redrawn");
    let waits = clock.timed_waits.load(Ordering::SeqCst);
    h.shared.set_state(1);
    h.shared.set_state(2); // coalesced: the latest wins
    until("redrawn", || h.status().frames_presented >= 2);
    thread::sleep(Duration::from_millis(30));
    assert!(h.status().frames_presented <= 3);
    assert!(clock.timed_waits.load(Ordering::SeqCst) <= waits + 2, "no polling while idle");
    h.close_and_join();

    // Animate: frames are spaced by the cap on the virtual clock (no real sleeping).
    let clock = FakeClock::new();
    let start = clock.now();
    let stop: Arc<Mutex<Option<Arc<Shared<u32>>>>> = Default::default();
    let (c, s) = (clock.clone(), stop.clone());
    let hook: Hook = Box::new(move |_| {
        if c.now().duration_since(start) >= Duration::from_secs(1) {
            if let Some(shared) = s.lock().unwrap().as_ref() {
                shared.close();
            }
        }
    });
    let mut h = Harness::start_with(Next::Animate, false, Some(hook), clock.clone(), frame_interval(60));
    *stop.lock().unwrap() = Some(h.shared.clone());
    attach(&h.surface, E);
    until("a virtual second of animation", || h.shared.exited());
    h.thread.take().unwrap().join().unwrap();
    let frames = h.status().frames_presented;
    assert!((59..=62).contains(&frames), "about 60 frames in a virtual second at a 60 fps cap: {frames}");
    let waits = clock.timed_waits.load(Ordering::SeqCst);
    assert!(waits <= frames as usize + 2, "one timed wait per frame, no spinning: {waits} waits, {frames} frames");

    // Skipped presents are retried at the cap, not in a loop.
    let clock = FakeClock::new();
    let mut h = Harness::start_with(Next::Wait, false, None, clock.clone(), frame_interval(10));
    h.script.lock().unwrap().presents.extend(["skip"; 5]);
    let start = clock.now();
    attach(&h.surface, E);
    until("presented after the skips", || h.status().frames_presented == 1);
    assert_eq!(h.status().presents_skipped, 5);
    assert!(clock.now().duration_since(start) >= Duration::from_millis(500), "five retries 100 ms apart");
    h.close_and_join();
}

#[test]
fn frame_interval_is_clamped() {
    assert_eq!(frame_interval(0), Duration::from_secs(1));
    assert_eq!(frame_interval(60), Duration::from_secs_f64(1.0 / 60.0));
    assert_eq!(frame_interval(10_000), Duration::from_secs_f64(1.0 / 240.0));
}
