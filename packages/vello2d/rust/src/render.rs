//! Keeps one pending frame and one being drawn; newer submissions replace pending frames.
//! Only the render thread owns the presenter, lease and GPU resources.
//! Create the device before leasing the window, and admit GPU operations through the lease.
//! Failed presentations retry with bounded backoff; close() wakes the thread to release resources.
//! Inbox and stats locks are taken separately and released before calling the presenter.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rnrs_surface::{Extent, Surface, WindowLease};

pub use crate::render_state::{GpuState, Stats, Timings};
use crate::frame::{self, Cmd};
use crate::timing::{EventRing, Kind};

#[derive(Debug, PartialEq)]
pub enum PresentError {
    /// Nothing was presented this time (timeout, occluded); try again on the next frame.
    Skipped(String),
    /// The attachment was revoked (detach or close) before the operation was admitted.
    Revoked,
    /// The window's swapchain is lost: drop the surface and create a new one.
    SurfaceLost(String),
    /// The GPU device is lost: drop every GPU resource and create a new device.
    DeviceLost(String),
    /// Unusable for another reason: unbind and retry with backoff.
    Failed(String),
}

/// A presentation surface and the lease that keeps its window alive. **Field order is drop
/// order**: the surface (and whatever it retains of the window, e.g. wgpu-hal's layer
/// reference) is dropped before the lease. On iOS wgpu does not hold the lease
/// (`SurfaceTargetUnsafe::CoreAnimationLayer`), so this lease is what keeps the window alive
/// for as long as the surface exists.
pub struct SurfaceLease<S> {
    pub surface: S,
    pub lease: WindowLease,
}

/// Treat an unconfirmed drawable timeout as a failure so the window is rebound.
pub const ACQUIRE_REFUSED: &str = "acquire refused: the drawable timeout was not confirmed after configure";

/// One present on a leased window, in the order the admission protocol requires:
/// refuse unless acquires are allowed; admit and acquire; prepare with no admission held;
/// admit again and submit. After a revocation no acquire is started, and an acquired frame
/// is dropped unsubmitted. Returns `acquire`'s error unchanged.
pub fn present_admitted<F, W>(
    lease: &WindowLease,
    acquire_allowed: bool,
    acquire: impl FnOnce() -> Result<F, PresentError>,
    prepare: impl FnOnce(F) -> W,
    submit: impl FnOnce(W),
) -> Result<(), PresentError> {
    if !acquire_allowed {
        return Err(PresentError::Failed(ACQUIRE_REFUSED.into()));
    }
    let frame = {
        let Some(_acquire) = lease.admit() else { return Err(PresentError::Revoked) };
        acquire()?
    };
    let work = prepare(frame);
    let Some(_present) = lease.admit() else { return Err(PresentError::Revoked) };
    submit(work);
    Ok(())
}

/// After an acquire reported the swapchain outdated: reconfigure under its own admission, so
/// no configure (on iOS: layer writes) starts on a revoked attachment, and a revocation waits
/// for (or times out on) the configure in flight. Returns the present's outcome.
pub fn reconfigure_outdated(lease: &WindowLease, reconfigure: impl FnOnce() -> Result<(), String>) -> PresentError {
    match admitted(lease, reconfigure) {
        None => PresentError::Revoked,
        Some(Ok(())) => PresentError::Skipped("swapchain outdated; reconfigured".into()),
        Some(Err(e)) => PresentError::SurfaceLost(e),
    }
}

/// Runs `f` (a configure) under one admission on `lease`, released when `f` returns; None,
/// without running `f`, once the attachment is revoked.
pub fn admitted<R>(lease: &WindowLease, f: impl FnOnce() -> R) -> Option<R> {
    let _admission = lease.admit()?;
    Some(f())
}

/// Runs one GPU step inside an Objective-C autorelease pool on iOS (the render thread has no
/// pool of its own, so autoreleased objects would otherwise accumulate until it exits).
#[cfg(target_os = "ios")]
fn pool<R>(f: impl FnOnce() -> R) -> R {
    rnrs_surface::ios::autoreleasepool(f)
}
#[cfg(not(target_os = "ios"))]
fn pool<R>(f: impl FnOnce() -> R) -> R {
    f()
}

/// Owns the GPU side. Called only on the render thread, never with a lock held.
pub trait Presenter: Send + 'static {
    /// Creates the GPU device if there is none. Called before a lease is taken.
    fn prepare(&mut self) -> Result<(), String>;
    /// Whether the device has been reported lost (checked before binding, also while unbound).
    fn device_lost(&self) -> bool;
    /// Starts rendering to a newly attached window. Holds `lease` until `unbind` or drop, and
    /// admits each acquire/present through it.
    fn bind(&mut self, lease: WindowLease, extent: Extent) -> Result<(), String>;
    fn resize(&mut self, extent: Extent) -> Result<(), String>;
    /// Drops the window (swapchain and lease); keeps the device.
    fn unbind(&mut self);
    /// Drops every GPU resource including the device (after a device loss).
    fn reset_device(&mut self);
    fn present(&mut self, cmds: &[Cmd], extent: Extent) -> Result<Timings, PresentError>;
    /// Raster size used for `extent` (for stats).
    fn raster_size(&self, extent: Extent) -> (u32, u32);
    fn device_init_ms(&self) -> f64;
    /// What is presented (swapchain format, view format, alpha mode), for stats.
    fn describe(&self) -> String;
}

pub const MAX_RECOVERY_ATTEMPTS: u32 = 6;
const FIRST_BACKOFF: Duration = Duration::from_millis(100);
const MAX_BACKOFF: Duration = Duration::from_millis(3200);

#[derive(Default)]
struct Inbox {
    /// (frame bytes, submit time, frame ID).
    pending: Option<(Vec<u8>, Instant, u32)>,
    /// The last frame ID assigned (IDs count accepted submits from 1).
    last_frame: u32,
    closed: bool,
    surface_changed: bool,
    exited: bool,
}

#[derive(Default)]
pub struct Shared {
    inbox: Mutex<Inbox>,
    wake: Condvar,
    stats: Mutex<Stats>,
    /// Optional timing history.
    events: EventRing,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Shared {
    pub fn stats(&self) -> Stats {
        lock(&self.stats).clone()
    }

    /// Timing events since the last drain; empty when disabled.
    pub fn drain_timings(&self) -> Vec<u8> {
        self.events.drain()
    }

    pub fn is_closed(&self) -> bool {
        let inbox = lock(&self.inbox);
        inbox.closed || inbox.exited
    }

    fn surface_changed(&self) {
        lock(&self.inbox).surface_changed = true;
        self.wake.notify_one();
    }

    /// Stores `frame` as the pending frame. False (nothing stored) only once closed or after
    /// the render thread exited.
    pub fn submit(&self, frame: Vec<u8>) -> bool {
        let mut inbox = lock(&self.inbox);
        if inbox.closed || inbox.exited {
            return false;
        }
        inbox.last_frame = inbox.last_frame.wrapping_add(1);
        let id = inbox.last_frame;
        let replaced = inbox.pending.replace((frame, Instant::now(), id));
        // Recorded under the inbox lock, so submit records are in frame-ID order.
        self.events.record(Kind::Submit, id, 0);
        drop(inbox);
        self.wake.notify_one();
        {
            let mut stats = lock(&self.stats);
            stats.frames_submitted += 1;
            stats.frames_replaced += replaced.is_some() as u64;
        }
        drop(replaced); // freed outside the locks
        true
    }

    /// Idempotent; never blocks beyond the inbox lock. Returns true the first time.
    pub fn close(&self) -> bool {
        let (first, pending) = {
            let mut inbox = lock(&self.inbox);
            let first = !inbox.closed;
            inbox.closed = true;
            (first, inbox.pending.take())
        };
        self.wake.notify_one();
        drop(pending);
        first
    }
}

/// Process-wide count of render threads alive (running or retiring), and of renderers not yet
/// closed. A renderer's slot is reserved before its thread is spawned and released only when
/// that thread has dropped every GPU resource and exited.
static THREADS: AtomicUsize = AtomicUsize::new(0);
static OPEN: AtomicUsize = AtomicUsize::new(0);

/// (open renderers, render threads still running or retiring).
pub fn process_counts() -> (usize, usize) {
    (OPEN.load(Ordering::SeqCst), THREADS.load(Ordering::SeqCst))
}

/// Marks one renderer closed for [`process_counts`] (call once per renderer).
pub fn note_closed() {
    OPEN.fetch_sub(1, Ordering::SeqCst);
}

struct ThreadSlot;
impl Drop for ThreadSlot {
    fn drop(&mut self) {
        THREADS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Starts the render thread for `surface`, if fewer than `cap` render threads are alive
/// (retiring ones included). Fails immediately at the cap; never waits for a slot.
#[cfg_attr(not(test), allow(dead_code))]
pub fn spawn<P: Presenter>(surface: &Surface, presenter: P, cap: usize) -> Result<Arc<Shared>, String> {
    spawn_with(surface, presenter, cap, EventRing::default())
}

/// [`spawn`] with a diagnostics event ring.
pub fn spawn_with<P: Presenter>(surface: &Surface, presenter: P, cap: usize, events: EventRing) -> Result<Arc<Shared>, String> {
    let reserved = THREADS.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < cap).then_some(n + 1));
    if let Err(n) = reserved {
        let open = OPEN.load(Ordering::SeqCst);
        return Err(format!("renderer limit reached: {n} of {cap} render threads alive ({open} open, {} closed and still releasing GPU resources)", n.saturating_sub(open)));
    }
    let slot = ThreadSlot;
    let shared = Arc::new(Shared { events, ..Shared::default() });
    let waker = Arc::downgrade(&shared);
    surface.set_waker(move || {
        if let Some(shared) = waker.upgrade() {
            shared.surface_changed();
        }
    });
    let (thread_shared, thread_surface) = (shared.clone(), surface.clone());
    std::thread::Builder::new()
        .name("rnrs-vello2d".into())
        .spawn(move || {
            let _slot = slot; // released after run() has dropped the presenter
            run(thread_shared, thread_surface, presenter);
        })
        .map_err(|e| format!("cannot start the render thread: {e}"))?; // the closure (and slot) is dropped on failure
    OPEN.fetch_add(1, Ordering::SeqCst);
    Ok(shared)
}

fn record_error(shared: &Shared, error: String) {
    log::warn!("rnrs-vello2d: {error}");
    let mut stats = lock(&shared.stats);
    stats.surface_errors += 1;
    stats.last_error = Some(error);
}

fn set_gpu(shared: &Shared, state: GpuState) {
    lock(&shared.stats).gpu = state;
}

/// Recovery bookkeeping: attempts since the last success and when to retry.
#[derive(Default)]
struct Recovery {
    attempts: u32,
    retry_at: Option<Instant>,
    failed: bool,
}

impl Recovery {
    fn fail(&mut self, shared: &Shared, error: String) {
        record_error(shared, error);
        self.attempts += 1;
        lock(&shared.stats).recovery_attempts += 1;
        if self.attempts >= MAX_RECOVERY_ATTEMPTS {
            self.failed = true;
            self.retry_at = None;
            set_gpu(shared, GpuState::Failed);
        } else {
            let backoff = FIRST_BACKOFF.saturating_mul(1 << (self.attempts - 1)).min(MAX_BACKOFF);
            self.retry_at = Some(Instant::now() + backoff);
            set_gpu(shared, GpuState::Recovering);
        }
    }

    fn succeed(&mut self, shared: &Shared) {
        *self = Recovery::default();
        set_gpu(shared, GpuState::Ready);
    }

    fn may_try(&self) -> bool {
        !self.failed && self.retry_at.is_none_or(|t| Instant::now() >= t)
    }
}

fn run<P: Presenter>(shared: Arc<Shared>, surface: Surface, mut presenter: P) {
    // (attachment, extent) of the window the presenter is bound to.
    let mut bound: Option<(u64, Extent)> = None;
    let mut cmds: Vec<Cmd> = Vec::new();
    let mut decoded: Vec<Cmd> = Vec::new();
    let mut have_frame = false;
    let mut current_frame: u32 = 0;
    let mut fresh: Option<Instant> = None;
    let mut recovery = Recovery::default();
    // The attachment/extent the recovery state applies to: a new one resets a failure.
    let mut recovery_for: Option<(u64, Extent)> = None;
    loop {
        let pending = {
            let mut inbox = lock(&shared.inbox);
            loop {
                if inbox.closed || inbox.pending.is_some() || inbox.surface_changed {
                    break;
                }
                match recovery.retry_at {
                    Some(at) => {
                        let now = Instant::now();
                        if now >= at {
                            break;
                        }
                        inbox = shared.wake.wait_timeout(inbox, at - now).unwrap_or_else(|e| e.into_inner()).0;
                    }
                    None => inbox = shared.wake.wait(inbox).unwrap_or_else(|e| e.into_inner()),
                }
            }
            if inbox.closed {
                break;
            }
            inbox.surface_changed = false;
            inbox.pending.take()
        };
        let snap = surface.snapshot();
        if snap.closed {
            break;
        }
        let target = (snap.attachment != 0 && !snap.extent.is_empty()).then_some((snap.attachment, snap.extent));
        if target.is_some() && recovery_for.map(|r| r.0) != target.map(|t| t.0) || recovery.failed && recovery_for != target {
            // A new attachment (or, after a terminal failure, a new size) gets fresh attempts.
            recovery = Recovery::default();
        }
        recovery_for = target;
        // Unbind a window that is no longer the current attachment or has no size.
        if bound.is_some_and(|(a, _)| Some(a) != target.map(|t| t.0)) {
            presenter.unbind();
            bound = None;
            lock(&shared.stats).bound = None;
        }
        if let Some((attachment, extent)) = target {
            if bound.is_none() && recovery.may_try() {
                // Device first (no lease held), then the lease and the swapchain. A device
                // lost while unbound (backgrounded) is replaced here, before any bind.
                if presenter.device_lost() {
                    lock(&shared.stats).device_losses += 1;
                    presenter.reset_device();
                }
                match pool(|| presenter.prepare()) {
                    Err(e) => recovery.fail(&shared, format!("cannot create the GPU device: {e}")),
                    Ok(()) => match surface.lease() {
                        Some(lease) if lease.attachment() == attachment => match pool(|| presenter.bind(lease, extent)) {
                            Ok(()) => {
                                bound = Some((attachment, extent));
                                if recovery.attempts == 0 {
                                    set_gpu(&shared, GpuState::Ready);
                                }
                            }
                            Err(e) => recovery.fail(&shared, format!("cannot render to the attached window: {e}")),
                        },
                        _ => {} // changed again meanwhile: the waker fires once more
                    },
                }
            } else if let Some((a, old)) = bound {
                if old != extent {
                    match pool(|| presenter.resize(extent)) {
                        Ok(()) => bound = Some((a, extent)),
                        Err(e) => {
                            presenter.unbind();
                            bound = None;
                            recovery.fail(&shared, format!("cannot resize: {e}"));
                        }
                    }
                }
            }
        }
        {
            let mut stats = lock(&shared.stats);
            stats.bound = bound.map(|(_, e)| presenter.raster_size(e));
            stats.device_init_ms = presenter.device_init_ms();
            stats.presentation = if bound.is_some() { presenter.describe() } else { String::new() };
        }
        if let Some((bytes, submitted, id)) = pending {
            match frame::parse(&bytes, &mut decoded) {
                Ok(()) => {
                    std::mem::swap(&mut cmds, &mut decoded);
                    have_frame = true;
                    fresh = Some(submitted);
                    current_frame = id;
                }
                Err(e) => {
                    let mut stats = lock(&shared.stats);
                    stats.frames_invalid += 1;
                    stats.last_error = Some(format!("invalid frame: {e}"));
                }
            }
            drop(bytes);
        }
        let Some((attachment, extent)) = bound else { continue };
        if !have_frame {
            continue;
        }
        let presented = pool(|| presenter.present(&cmds, extent));
        let kind = if presented.is_ok() { Kind::Present } else { Kind::PresentUnsuccessful };
        shared.events.record(kind, current_frame, attachment as u32);
        match presented {
            Ok(timings) => {
                if recovery.attempts > 0 {
                    recovery.succeed(&shared); // only a presented frame ends a recovery
                }
                let mut stats = lock(&shared.stats);
                stats.frames_presented += 1;
                stats.last = timings;
                if let Some(submitted) = fresh.take() {
                    stats.last_submit_to_present_ms = submitted.elapsed().as_secs_f64() * 1e3;
                }
            }
            Err(PresentError::Skipped(reason)) => log::debug!("rnrs-vello2d: frame skipped: {reason}"),
            // Detached or closed: the snapshot shows it on the next iteration (the waker fired).
            Err(PresentError::Revoked) => {}
            // The state is recorded first, then old resources are dropped here, on this
            // thread, before any new surface or device is created (next iteration).
            Err(PresentError::SurfaceLost(e)) => {
                lock(&shared.stats).surface_recreations += 1;
                recovery.fail(&shared, format!("surface lost: {e}"));
                presenter.unbind();
                bound = None;
            }
            Err(PresentError::DeviceLost(e)) => {
                lock(&shared.stats).device_losses += 1;
                recovery.fail(&shared, format!("GPU device lost: {e}"));
                presenter.unbind();
                presenter.reset_device();
                bound = None;
            }
            Err(PresentError::Failed(e)) => {
                recovery.fail(&shared, format!("present failed: {e}"));
                presenter.unbind();
                bound = None;
            }
        }
    }
    // Teardown on this thread: release the window first, then GPU resources.
    if bound.is_some() {
        presenter.unbind();
    }
    drop(presenter);
    {
        let mut stats = lock(&shared.stats);
        stats.bound = None;
        stats.gpu = GpuState::None;
    }
    let pending = {
        let mut inbox = lock(&shared.inbox);
        inbox.exited = true;
        inbox.pending.take()
    };
    drop(pending);
}

#[cfg(test)]
pub(crate) mod tests;
