//! The native render loop, independent of wgpu: generic over a [`Backend`] (the GPU side; the
//! wgpu one is `native.rs`, tests use a fake) and a [`Client`] (the renderer's hooks).
//!
//! Invariants:
//! - Only the render thread touches the backend, the client, the device, the swapchain, the
//!   resources and the lease. Other threads only replace the latest state, set flags and notify.
//! - No lock is held while calling the backend or the client. The inbox lock is held only to
//!   move the latest state and flags; the status lock only to copy counters.
//! - The device is created before a lease is taken. Each attachment gets new resources; drop
//!   order is resources, then swapchain (which holds the lease), then (after a loss) the device.
//! - A failure ends rendering for the current attachment (`failed_for`); only a different
//!   attachment is tried again, once. Nothing retries in a loop.
//! - Frames are rate-limited: at most one per `interval` (the native frame cap), whether the
//!   renderer animates, a redraw was requested, or a present was skipped. While there is
//!   nothing to draw the thread waits for a notification without a timeout.
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::{GpuState, Next, Status, SurfaceState};
use crate::touch::TouchRecord;
use crate::{Extent, Surface, WindowLease};

/// The outcome of one present.
pub(crate) enum Presented {
    Done(Next),
    /// Nothing presented this time (timeout, occluded, outdated and reconfigured).
    Skipped(String),
    /// The attachment was revoked before acquire or present: the next snapshot shows why.
    Revoked,
    /// The attachment ends (a failed draw, lost swapchain, validation error).
    Failed(String),
    /// The device is unusable (lost, or an uncaptured error): the attachment ends and the
    /// device is replaced on the next one. `loss`: an actual device loss (counted).
    Reset { error: String, loss: bool },
}

/// The GPU side, called only on the render thread.
pub(crate) trait Backend: 'static {
    type Device;
    type Target;
    type Info;
    type Frame<'a>;
    /// Runs one render-thread step (iOS: inside an autorelease pool).
    fn pool<R>(f: impl FnOnce() -> R) -> R {
        f()
    }
    fn create_device(&mut self) -> Result<Self::Device, String>;
    /// A device fault (loss or uncaptured error): (message, whether it is a loss).
    fn fault(&self, device: &Self::Device) -> Option<(String, bool)>;
    fn adapter(&self, device: &Self::Device) -> String;
    /// Creates and configures the swapchain on `lease` (held by the target until dropped).
    fn bind(&mut self, device: &Self::Device, lease: WindowLease, extent: Extent) -> Result<Self::Target, String>;
    fn info(&self, target: &Self::Target) -> Self::Info;
    fn describe(&self, target: &Self::Target) -> String;
    fn resize(&mut self, device: &Self::Device, target: &mut Self::Target, extent: Extent) -> Result<(), String>;
    /// Runs a renderer hook with validation errors captured into its result.
    fn scoped<T>(&mut self, device: &Self::Device, f: impl FnOnce() -> Result<T, String>) -> Result<T, String>;
    /// Acquires, lets `draw` record (no admission or lock held), submits and presents, each GPU
    /// step on the window under its own admission.
    fn present(
        &mut self,
        device: &Self::Device,
        target: &mut Self::Target,
        extent: Extent,
        draw: &mut dyn FnMut(&mut Self::Frame<'_>) -> Result<Next, String>,
    ) -> Presented;
}

/// The renderer's hooks as the loop calls them.
pub(crate) trait Client<B: Backend> {
    type State;
    type Resources;
    fn create(&mut self, device: &B::Device, info: &B::Info) -> Result<Self::Resources, String>;
    fn resized(&mut self, resources: &mut Self::Resources, device: &B::Device, extent: Extent) -> Result<(), String>;
    fn draw(&mut self, resources: &mut Self::Resources, frame: &mut B::Frame<'_>, state: &Self::State) -> Result<Next, String>;
    fn touch(&mut self, records: &[TouchRecord]);
}

/// Time and waiting, injectable so tests run the pacing on a virtual clock.
pub(crate) trait Clock: Send + 'static {
    fn now(&self) -> Instant;
    /// Waits on `wake` until notified or (with `until`) that time.
    fn wait<'a, T>(&self, wake: &Condvar, guard: MutexGuard<'a, T>, until: Option<Instant>) -> MutexGuard<'a, T>;
}

pub(crate) struct RealClock;

impl Clock for RealClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
    fn wait<'a, T>(&self, wake: &Condvar, guard: MutexGuard<'a, T>, until: Option<Instant>) -> MutexGuard<'a, T> {
        match until {
            None => wake.wait(guard).unwrap_or_else(|e| e.into_inner()),
            Some(at) => {
                let left = at.saturating_duration_since(Instant::now());
                wake.wait_timeout(guard, left).unwrap_or_else(|e| e.into_inner()).0
            }
        }
    }
}

struct Inbox<S> {
    /// The latest state not yet taken by the render thread.
    pending: Option<S>,
    dirty: bool,
    surface_changed: bool,
    closed: bool,
    exited: bool,
}

/// What other threads share with the render thread.
pub(crate) struct Shared<S> {
    inbox: Mutex<Inbox<S>>,
    wake: Condvar,
    status: Mutex<Status>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl<S> Shared<S> {
    pub(crate) fn new() -> Self {
        Self {
            inbox: Mutex::new(Inbox { pending: None, dirty: false, surface_changed: true, closed: false, exited: false }),
            wake: Condvar::new(),
            status: Mutex::new(Status::default()),
        }
    }

    /// Replaces the latest state and wakes the render thread: one short critical section on the
    /// inbox (shared with the render thread's own brief take), so it can wait briefly but never
    /// for rendering. The replaced value is dropped after unlocking. False once closed.
    pub(crate) fn set_state(&self, state: S) -> bool {
        let old = {
            let mut inbox = lock(&self.inbox);
            if inbox.closed || inbox.exited {
                return false; // `state` is dropped by the caller's frame, unlocked
            }
            inbox.dirty = true;
            inbox.pending.replace(state)
        };
        self.wake.notify_one();
        drop(old);
        true
    }

    pub(crate) fn surface_changed(&self) {
        lock(&self.inbox).surface_changed = true;
        self.wake.notify_one();
    }

    /// Idempotent; never blocks beyond the inbox lock.
    pub(crate) fn close(&self) {
        let pending = {
            let mut inbox = lock(&self.inbox);
            inbox.closed = true;
            inbox.pending.take()
        };
        self.wake.notify_one();
        drop(pending);
    }

    pub(crate) fn status(&self) -> Status {
        lock(&self.status).clone()
    }

    pub(crate) fn exited(&self) -> bool {
        lock(&self.inbox).exited
    }

    fn update(&self, f: impl FnOnce(&mut Status)) {
        f(&mut lock(&self.status));
    }
}

/// The frame interval for a cap in frames per second (clamped to 1..=240).
pub(crate) fn frame_interval(max_frame_rate: u32) -> Duration {
    Duration::from_secs_f64(1.0 / f64::from(max_frame_rate.clamp(1, 240)))
}

/// The render loop: returns when the surface or the shared state is closed, after dropping the
/// resources, the swapchain (and lease), the client and the device, in that order.
pub(crate) fn run<B: Backend, C: Client<B>>(
    shared: &Shared<C::State>,
    surface: &Surface,
    mut backend: B,
    mut client: C,
    mut state: C::State,
    clock: &impl Clock,
    interval: Duration,
) {
    let mut device: Option<B::Device> = None;
    let mut resources: Option<C::Resources> = None;
    let mut target: Option<B::Target> = None;
    // (attachment, extent) the target is bound to; the attachment that failed.
    let mut bound: Option<(u64, Extent)> = None;
    let mut failed_for: Option<u64> = None;
    let mut redraw = false;
    let mut animate = false;
    let mut last_frame: Option<Instant> = None;
    let mut touches = Vec::with_capacity(crate::touch::QUEUE_CAPACITY);
    'run: loop {
        let pending = {
            let mut inbox = lock(&shared.inbox);
            loop {
                if inbox.closed {
                    break 'run;
                }
                if inbox.surface_changed {
                    break;
                }
                let want = bound.is_some() && (redraw || animate || inbox.dirty);
                if !want && inbox.dirty {
                    break; // a state change while nothing is bound: take it, nothing to draw
                }
                if !want {
                    inbox = clock.wait(&shared.wake, inbox, None);
                    continue;
                }
                let due = last_frame.map_or_else(|| clock.now(), |t| t + interval);
                if clock.now() >= due {
                    break;
                }
                inbox = clock.wait(&shared.wake, inbox, Some(due));
            }
            redraw |= inbox.dirty;
            inbox.dirty = false;
            inbox.surface_changed = false;
            inbox.pending.take()
        };
        if let Some(latest) = pending {
            state = latest; // the previous state is dropped here, unlocked
        }
        // Touch first, on every wake (also detached or failed), so resets arrive promptly.
        surface.drain_touch(&mut touches);
        if !touches.is_empty() {
            B::pool(|| client.touch(&touches));
        }
        let snap = surface.snapshot();
        if snap.closed {
            break;
        }
        let current = (snap.attachment != 0 && !snap.extent.is_empty()).then_some((snap.attachment, snap.extent));
        // The bound attachment ended or changed: resources first, then the swapchain and lease.
        if bound.is_some_and(|(a, _)| Some(a) != current.map(|c| c.0)) {
            B::pool(|| {
                resources = None;
                target = None;
            });
            bound = None;
            shared.update(|s| s.presentation.clear());
        }
        let Some((attachment, extent)) = current else {
            shared.update(|s| {
                s.state = SurfaceState::Detached;
                (s.width, s.height) = (0, 0);
                if s.gpu != GpuState::Failed {
                    s.gpu = GpuState::None;
                }
            });
            continue;
        };
        shared.update(|s| {
            s.state = SurfaceState::Attached;
            (s.width, s.height) = (extent.width, extent.height);
        });
        if failed_for.is_some_and(|a| a != attachment) {
            failed_for = None; // a new attachment gets one fresh attempt
        }
        if failed_for.is_some() {
            continue;
        }
        let step = B::pool(|| -> Result<(), String> {
            if bound.is_none() {
                // A device lost while unbound (backgrounded) is replaced before any lease.
                if let Some((error, loss)) = device.as_ref().and_then(|d| backend.fault(d)) {
                    shared.update(|s| s.device_losses += loss as u64);
                    log::warn!("rnr-surface gpu: replacing the device: {error}");
                    device = None;
                }
                shared.update(|s| {
                    s.setups_started += 1;
                    s.gpu = GpuState::Initializing;
                });
                if device.is_none() {
                    let d = backend.create_device()?;
                    let adapter = backend.adapter(&d);
                    shared.update(|s| s.adapter = adapter);
                    device = Some(d);
                }
                let d = device.as_ref().expect("created above");
                let lease = match surface.lease() {
                    Some(lease) if lease.attachment() == attachment => lease,
                    _ => return Ok(()), // changed again meanwhile: the waker fires once more
                };
                let t = backend.bind(d, lease, extent)?;
                let info = backend.info(&t);
                let presentation = backend.describe(&t);
                target = Some(t);
                let mut r = backend.scoped(d, || client.create(d, &info))?;
                backend.scoped(d, || client.resized(&mut r, d, extent))?;
                resources = Some(r);
                bound = Some((attachment, extent));
                redraw = true;
                shared.update(|s| {
                    s.gpu = GpuState::Ready;
                    s.presentation = presentation;
                });
            } else if bound.is_some_and(|(_, old)| old != extent) {
                let d = device.as_ref().ok_or("no device")?;
                let t = target.as_mut().ok_or("no swapchain")?;
                backend.resize(d, t, extent)?;
                let r = resources.as_mut().ok_or("no resources")?;
                backend.scoped(d, || client.resized(r, d, extent))?;
                bound = Some((attachment, extent));
                redraw = true;
            }
            Ok(())
        });
        let fail = |resources: &mut Option<C::Resources>, target: &mut Option<B::Target>, error: String| {
            log::error!("rnr-surface gpu: attachment {attachment}: {error}");
            B::pool(|| {
                *resources = None;
                *target = None;
            });
            shared.update(|s| {
                s.gpu = GpuState::Failed;
                s.presentation.clear();
                s.last_error = Some(error);
            });
        };
        if let Err(error) = step {
            fail(&mut resources, &mut target, error);
            bound = None;
            failed_for = Some(attachment);
            continue;
        }
        if bound.is_none() {
            continue;
        }
        let due = last_frame.is_none_or(|t| clock.now() >= t + interval);
        if !(redraw || animate) || !due {
            continue; // the wait above sleeps until due
        }
        let (Some(d), Some(t), Some(r)) = (device.as_ref(), target.as_mut(), resources.as_mut()) else { continue };
        let presented = B::pool(|| backend.present(d, t, extent, &mut |frame| client.draw(r, frame, &state)));
        last_frame = Some(clock.now());
        match presented {
            Presented::Done(next) => {
                redraw = false;
                animate = next == Next::Animate;
                shared.update(|s| s.frames_presented += 1);
            }
            // Retried at the frame cap (redraw stays set).
            Presented::Skipped(why) => {
                log::debug!("rnr-surface gpu: present skipped: {why}");
                shared.update(|s| s.presents_skipped += 1);
            }
            Presented::Revoked => {}
            Presented::Failed(error) => {
                fail(&mut resources, &mut target, error);
                bound = None;
                failed_for = Some(attachment);
            }
            Presented::Reset { error, loss } => {
                fail(&mut resources, &mut target, error);
                shared.update(|s| s.device_losses += loss as u64);
                B::pool(|| device = None);
                bound = None;
                failed_for = Some(attachment);
            }
        }
    }
    // Teardown on this thread: resources, swapchain and lease, the renderer, then the device.
    B::pool(|| {
        drop(resources.take());
        drop(target.take());
        drop(client);
        drop(device.take());
    });
    shared.update(|s| {
        s.state = SurfaceState::Closed;
        s.gpu = GpuState::None;
        s.presentation.clear();
        (s.width, s.height) = (0, 0);
    });
    let pending = {
        let mut inbox = lock(&shared.inbox);
        inbox.exited = true;
        inbox.pending.take()
    };
    drop(pending);
    drop(state);
}

#[cfg(test)]
mod tests;
