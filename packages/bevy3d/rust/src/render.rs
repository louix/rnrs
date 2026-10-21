//! The render thread: owns the GPU device, the Bevy app and the window lease, and runs the
//! simulation and rendering. JS threads only set controls and read stats.
//!
//! Invariants (the surface contract of docs/surface.md, simplified for a prototype):
//! - Only this thread touches the presenter, the Bevy app and the lease. `close` and `Drop`
//!   only set a flag and notify; the thread drops everything itself and is never joined.
//! - The device is created before a lease is taken, so a platform detach never waits for
//!   device creation. Acquire, present and configure are each admitted through the lease.
//! - Failure policy (no recovery machinery): a failed device creation, bind, resize, or a
//!   lost surface or device ends rendering for the current attachment (`gpuState` "failed",
//!   error kept). Only a new attachment gets one fresh attempt, so nothing retries in a loop.
//!   A skipped present (timeout, occluded, outdated, revoked) waits [`SKIP_WAIT`] before the
//!   next frame, so a window that stops presenting does not spin the thread.
//! - Frames are paced by FIFO presentation while animating; when paused (or detached) the
//!   thread waits for a control or surface change.
//!
//! Locks: the inbox and stats locks are each taken alone; no lock is held while rendering.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rnrs_surface::{Extent, Surface};

use crate::gpu::{Gpu, PresentError, Target};
use crate::scene::{BevyScene, TouchStats};

/// Runs one render-thread step inside an Objective-C autorelease pool on iOS (the render
/// thread has no pool of its own, so autoreleased objects would accumulate until it exits).
#[cfg(target_os = "ios")]
fn pool<R>(f: impl FnOnce() -> R) -> R {
    rnrs_surface::ios::autoreleasepool(f)
}
#[cfg(not(target_os = "ios"))]
fn pool<R>(f: impl FnOnce() -> R) -> R {
    f()
}

const SKIP_WAIT: Duration = Duration::from_millis(50);

pub use crate::scene::Controls;

#[derive(Default)]
struct Inbox {
    controls: Controls,
    controls_changed: bool,
    surface_changed: bool,
    closed: bool,
    exited: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub gpu: &'static str,
    pub frames_rendered: u64,
    pub frames_presented: u64,
    pub presents_skipped: u64,
    pub angle: f32,
    pub input_applied: u64,
    pub touch: TouchStats,
    /// Pressed in Bevy's `Touches` after the last update.
    pub touches_pressed: u64,
    pub device_init_ms: f64,
    pub first_update_ms: f64,
    pub presentation: String,
    pub last_error: Option<String>,
}

#[derive(Default)]
pub struct Shared {
    inbox: Mutex<Inbox>,
    wake: Condvar,
    stats: Mutex<Stats>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Shared {
    pub fn stats(&self) -> Stats {
        let mut s = lock(&self.stats).clone();
        if s.gpu.is_empty() {
            s.gpu = "none";
        }
        s
    }

    pub fn controls(&self) -> Controls {
        lock(&self.inbox).controls
    }

    pub fn is_closed(&self) -> bool {
        let inbox = lock(&self.inbox);
        inbox.closed || inbox.exited
    }

    /// Applies `f` to the controls; false (nothing changed) once closed.
    pub fn control(&self, f: impl FnOnce(&mut Controls)) -> bool {
        let mut inbox = lock(&self.inbox);
        if inbox.closed || inbox.exited {
            return false;
        }
        f(&mut inbox.controls);
        inbox.controls_changed = true;
        drop(inbox);
        self.wake.notify_one();
        true
    }

    /// UI input never waits for the inbox. Rendering holds no inbox lock.
    pub fn try_control(&self, f: impl FnOnce(&mut Controls)) -> bool {
        let mut inbox = match self.inbox.try_lock() {
            Ok(inbox) => inbox,
            Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return false,
        };
        if inbox.closed || inbox.exited { return false; }
        f(&mut inbox.controls);
        inbox.controls_changed = true;
        drop(inbox);
        self.wake.notify_one();
        true
    }

    fn surface_changed(&self) {
        lock(&self.inbox).surface_changed = true;
        self.wake.notify_one();
    }

    /// Idempotent; never blocks beyond the inbox lock.
    pub fn close(&self) {
        lock(&self.inbox).closed = true;
        self.wake.notify_one();
    }
}

static THREADS: AtomicUsize = AtomicUsize::new(0);
static OPEN: AtomicUsize = AtomicUsize::new(0);

/// (open scenes, render threads still running or retiring).
pub fn process_counts() -> (usize, usize) {
    (OPEN.load(Ordering::SeqCst), THREADS.load(Ordering::SeqCst))
}

/// Marks one scene closed for [`process_counts`] (call once per scene).
pub fn note_closed() {
    OPEN.fetch_sub(1, Ordering::SeqCst);
}

struct ThreadSlot;
impl Drop for ThreadSlot {
    fn drop(&mut self) {
        THREADS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Starts the render thread for `surface` if fewer than `cap` are alive (retiring included).
/// Fails immediately at the cap; never waits for a slot.
pub fn spawn(surface: &Surface, cap: usize) -> Result<Arc<Shared>, String> {
    if let Err(n) = THREADS.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < cap).then_some(n + 1)) {
        let open = OPEN.load(Ordering::SeqCst);
        return Err(format!("scene limit reached: {n} of {cap} render threads alive ({open} open, {} closed and still releasing GPU resources)", n.saturating_sub(open)));
    }
    let slot = ThreadSlot;
    let shared = Arc::new(Shared::default());
    let waker = Arc::downgrade(&shared);
    surface.set_waker(move || {
        if let Some(shared) = waker.upgrade() {
            shared.surface_changed();
        }
    });
    let (thread_shared, thread_surface) = (shared.clone(), surface.clone());
    std::thread::Builder::new()
        .name("rnr-bevy3d".into())
        .spawn(move || {
            let _slot = slot; // released after run() has dropped every GPU resource
            run(&thread_shared, &thread_surface);
            lock(&thread_shared.inbox).exited = true;
        })
        .map_err(|e| format!("cannot start the render thread: {e}"))?;
    OPEN.fetch_add(1, Ordering::SeqCst);
    Ok(shared)
}

/// Ends touch input for a failed attachment: no update runs until the next one.
fn fail_touch(gfx: &mut Gfx, shared: &Shared, attachment: u64) {
    if let Some(scene) = gfx.scene.as_mut() {
        scene.fail_touch(attachment);
        lock(&shared.stats).touch = scene.touch_stats();
    }
}

fn fail(shared: &Shared, error: String) {
    log::error!("rnr-bevy3d: {error}");
    let mut stats = lock(&shared.stats);
    stats.gpu = "failed";
    stats.last_error = Some(error);
}

/// GPU-side state, dropped in field order on exit: the window first (swapchain and lease), then
/// the Bevy app (its render world holds device clones), then the device.
#[derive(Default)]
struct Gfx {
    target: Option<Target>,
    scene: Option<BevyScene>,
    gpu: Option<Gpu>,
}

impl Gfx {
    fn drop_device(&mut self) {
        self.target = None;
        self.scene = None;
        self.gpu = None;
    }

    /// Device and Bevy app, created before any lease is taken.
    fn prepare(&mut self, shared: &Shared, extent: Extent) -> Result<(), String> {
        if self.gpu.as_ref().is_some_and(Gpu::lost) {
            self.drop_device();
        }
        if self.gpu.is_none() {
            let started = Instant::now();
            self.gpu = Some(Gpu::new()?);
            lock(&shared.stats).device_init_ms = started.elapsed().as_secs_f64() * 1e3;
        }
        if self.scene.is_none() {
            let gpu = self.gpu.as_ref().ok_or("no device")?;
            let started = Instant::now();
            self.scene = Some(BevyScene::new(gpu.parts(), (extent.width, extent.height))?);
            lock(&shared.stats).first_update_ms = started.elapsed().as_secs_f64() * 1e3;
        }
        Ok(())
    }
}

fn run(shared: &Shared, surface: &Surface) {
    let mut gfx = Gfx::default();
    // (attachment, extent) the target is bound to, and the attachment that failed (if any).
    let mut bound: Option<(u64, Extent)> = None;
    let mut failed_for: Option<u64> = None;
    let mut redraw = false;
    let mut wait_until: Option<Instant> = None;
    let mut touches = Vec::with_capacity(rnrs_surface::touch::QUEUE_CAPACITY);
    loop {
        let controls = {
            let mut inbox = lock(&shared.inbox);
            loop {
                if inbox.closed {
                    return;
                }
                let animating = bound.is_some() && (!inbox.controls.paused || redraw);
                if inbox.surface_changed || inbox.controls_changed {
                    break;
                }
                match wait_until {
                    Some(at) if animating => {
                        let now = Instant::now();
                        if now >= at {
                            break;
                        }
                        inbox = shared.wake.wait_timeout(inbox, at - now).unwrap_or_else(|e| e.into_inner()).0;
                    }
                    None if animating => break,
                    _ => inbox = shared.wake.wait(inbox).unwrap_or_else(|e| e.into_inner()),
                }
            }
            wait_until = None;
            redraw |= inbox.controls_changed;
            inbox.surface_changed = false;
            inbox.controls_changed = false;
            inbox.controls
        };
        // Touch first, every wake (also paused, detached or failed), so resets are applied
        // before any later update; without a Bevy app there is nothing to cancel.
        surface.drain_touch(&mut touches);
        if !touches.is_empty() {
            if let Some(scene) = gfx.scene.as_mut() {
                scene.feed_touch(&touches);
                lock(&shared.stats).touch = scene.touch_stats();
            }
        }
        let snap = surface.snapshot();
        if snap.closed {
            return;
        }
        let target = (snap.attachment != 0 && !snap.extent.is_empty()).then_some((snap.attachment, snap.extent));
        if bound.is_some_and(|(a, _)| Some(a) != target.map(|t| t.0)) {
            gfx.target = None;
            bound = None;
            lock(&shared.stats).presentation.clear();
        }
        let Some((attachment, extent)) = target else { continue };
        if failed_for.is_some_and(|a| a != attachment) {
            failed_for = None; // a new attachment gets one fresh attempt
        }
        if failed_for.is_some() {
            continue;
        }
        let step = pool(|| -> Result<(), String> {
            if bound.is_none() {
                gfx.prepare(shared, extent)?;
                let lease = match surface.lease() {
                    Some(lease) if lease.attachment() == attachment => lease,
                    _ => return Ok(()), // changed again meanwhile: the waker fires once more
                };
                let gpu = gfx.gpu.as_ref().ok_or("no device")?;
                gfx.target = Some(Target::bind(gpu, lease, extent)?);
                let scene = gfx.scene.as_mut().ok_or("no scene")?;
                scene.resize(&gpu.device, (extent.width, extent.height))?;
                scene.begin_attachment(attachment);
                bound = Some((attachment, extent));
                redraw = true;
                let mut stats = lock(&shared.stats);
                stats.touch = scene.touch_stats();
                stats.gpu = "ready";
                stats.presentation = gfx.target.as_ref().map(Target::describe).unwrap_or_default();
            } else if bound.is_some_and(|(_, old)| old != extent) {
                let gpu = gfx.gpu.as_ref().ok_or("no device")?;
                gfx.target.as_mut().ok_or("no window")?.resize(gpu, extent)?;
                gfx.scene.as_mut().ok_or("no scene")?.resize(&gpu.device, (extent.width, extent.height))?;
                bound = Some((attachment, extent));
                redraw = true;
            }
            Ok(())
        });
        if let Err(e) = step {
            gfx.target = None;
            bound = None;
            failed_for = Some(attachment);
            fail(shared, e);
            fail_touch(&mut gfx, shared, attachment);
            continue;
        }
        if bound.is_none() {
            continue;
        }
        let (Some(gpu), Some(scene), Some(window)) = (gfx.gpu.as_ref(), gfx.scene.as_mut(), gfx.target.as_mut()) else { continue };
        let stepped = pool(|| scene.update(controls).map(|angle| (angle, window.present(gpu, scene.view()))));
        let touches_pressed = scene.touches_pressed() as u64;
        let (angle, presented) = match stepped {
            Ok(step) => step,
            // Bevy stopped rendering: end this attachment; the next one gets a new Bevy app.
            Err(e) => {
                gfx.target = None;
                gfx.scene = None;
                bound = None;
                failed_for = Some(attachment);
                fail(shared, e);
                fail_touch(&mut gfx, shared, attachment);
                continue;
            }
        };
        {
            let mut s = lock(&shared.stats);
            s.frames_rendered += 1;
            s.angle = angle;
            s.input_applied = controls.rotation.map_or(0, |r| r.0);
            s.touches_pressed = touches_pressed;
        }
        match presented {
            Ok(()) => {
                redraw = false;
                lock(&shared.stats).frames_presented += 1;
            }
            Err(PresentError::Skipped(why)) => {
                log::debug!("rnr-bevy3d: present skipped: {why}");
                wait_until = Some(Instant::now() + SKIP_WAIT);
                lock(&shared.stats).presents_skipped += 1;
            }
            Err(PresentError::Fatal(e)) => {
                gfx.target = None;
                bound = None;
                failed_for = Some(attachment);
                fail(shared, e);
                fail_touch(&mut gfx, shared, attachment);
            }
        }
    }
}

#[cfg(test)]
mod input_tests {
    use super::*;

    #[test]
    fn input_drops_on_contention_and_close_without_overwriting() {
        let shared = Shared::default();
        let held = lock(&shared.inbox);
        assert!(!shared.try_control(|c| c.rotation = Some((1, 1.0))));
        drop(held);
        assert!(shared.try_control(|c| c.rotation = Some((1, 1.0))));
        assert!(shared.try_control(|c| c.rotation = Some((2, 2.0))));
        assert_eq!(shared.controls().rotation, Some((2, 2.0)));
        shared.close();
        assert!(!shared.try_control(|c| c.rotation = Some((3, 3.0))));
        assert_eq!(shared.controls().rotation, Some((2, 2.0)));
    }
}
