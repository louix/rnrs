//! Framework rendering surfaces (docs/surface.md).
//!
//! A [`Surface`] is created by a renderer (a module crate) and named to JS by an opaque
//! numeric key, never a pointer. The `<SurfaceView surfaceKey={...}>` component's platform
//! view attaches its window to that key while the platform surface exists, resizes it, and
//! detaches it before the platform destroys it. Surface lifetime is separate from component
//! lifetime: a mounted view can lose and regain its window, and a surface can exist without
//! a view.
//!
//! # Identities
//! Every module binary links its own copy of this crate. The app's surface host (the framework
//! C++, packages/runtime/cpp/RnrsSurfaceHost.h) binds each copy to an *owner* number
//! ([`host`]), and a key is `owner * 2^32 + local`: it names the binary that owns the surface,
//! and the host routes every platform call by it. Local keys come from a counter of this copy
//! and are never reused, so a key from a disposed surface or an earlier JS runtime matches
//! nothing. Each attachment gets its own number, so a late resize or detach for an earlier
//! attachment is ignored. A platform window is owned by at most one attachment process-wide:
//! the host claims it before handing it to a binary, and the binary returns the claim when the
//! last reference to that attachment's [`WindowCell`] is dropped (exactly once, after the window
//! itself), so no surface of any binary can attach the same window while an old renderer may
//! still use it.
//!
//! # Admission protocol (detach and revocation)
//! Renderers reach the window only through a [`WindowLease`]. Each GPU operation on the
//! window (acquire, present) must first be *admitted* with [`WindowLease::admit`]:
//! admission atomically checks that the attachment is not revoked and counts the operation
//! as in flight, then releases the lock; the operation itself runs without any lock.
//! [`platform::detach`] (the platform's synchronous "surface is being destroyed" callback)
//! revokes the attachment, which is permanent, wakes the renderer and waits, bounded by its
//! timeout, until every lease is dropped. Guarantees:
//! - After revocation no new operation is admitted, whether detach returned released or
//!   timed out.
//! - An operation admitted before revocation may still complete after a timed-out detach
//!   returns (at most the operations in flight at that moment; the renderer admits acquire
//!   and present separately, so a late acquire is not followed by a present).
//! - The window object stays retained (valid memory) until the last lease is dropped.
//! The platform's wait therefore includes whatever the renderer does to release the window
//! (finishing an admitted operation, destroying its swapchain, which can wait for the GPU).
//! That is a deliberate synchronous requirement of Android's `surfaceDestroyed`, bounded by
//! the timeout; it is not a non-blocking operation.
//!
//! # Lock order
//! Each lock is taken alone: the surface registry, a surface's state, a surface's touch queue
//! and a cell's admission state are never nested. Wakers run, and cells, windows and surfaces
//! are dropped, only with no lock held (dropping a cell returns its window claim to the host,
//! which takes the host's own claim lock).
//!
//! Native paths never call JS. Browser close/detach may notify a main-thread framework
//! listener after unlocking; that listener only queues work. [`Surface::close`] never waits.
use std::collections::HashMap;
#[cfg(not(target_arch = "wasm32"))]
use std::ffi::c_void;
#[cfg(not(target_arch = "wasm32"))]
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
#[cfg(not(target_arch = "wasm32"))]
use std::sync::Condvar;
#[cfg(not(target_arch = "wasm32"))]
use std::time::{Duration, Instant};

#[cfg(not(target_arch = "wasm32"))]
use raw_window_handle::{DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle, WindowHandle};

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "ios")]
pub mod ios;
#[cfg(not(target_arch = "wasm32"))]
pub mod host;
#[cfg(not(target_arch = "wasm32"))]
pub mod layer;
/// Android and iOS views and the browser host (web_host) deliver touches into this queue.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
pub mod touch;

#[cfg(not(target_arch = "wasm32"))]
use touch::ResetReason;
use touch::{TouchCounters, TouchQueue, TouchRecord};

/// A platform window that can be rendered to: on Android an `ANativeWindow` reference owned
/// by this value and released when it is dropped.
#[cfg(not(target_arch = "wasm32"))]
pub trait PlatformWindow: Send + Sync + 'static {
    /// Valid for as long as `self` is alive. A platform whose window must not be reached through
    /// a raw window handle from a render thread (iOS: wgpu's UIKit path requires the main
    /// thread) returns an error, and renderers use [`PlatformWindow::metal_layer`] instead.
    fn raw_window_handle(&self) -> Result<RawWindowHandle, HandleError>;
    fn raw_display_handle(&self) -> RawDisplayHandle;
    /// The window's `CAMetalLayer` (iOS), valid for as long as `self` is alive; None elsewhere.
    fn metal_layer(&self) -> Option<NonNull<c_void>> {
        None
    }
}

/// Size of the attached window in physical pixels, and the display scale (physical pixels per
/// layout unit, Android's `DisplayMetrics.density`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Extent {
    pub width: u32,
    pub height: u32,
    pub scale: f32,
}

impl Extent {
    pub fn is_empty(&self) -> bool {
        self.width == 0 || self.height == 0
    }
}

/// Lifecycle counters of one surface (since creation).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    pub attaches: u64,
    pub detaches: u64,
    pub resizes: u64,
    /// Attach requests refused: another window attached to this surface, or the surface closed.
    pub refused_attaches: u64,
    /// Detaches that returned before every lease was dropped.
    pub detach_timeouts: u64,
    /// Of those, timeouts with an admitted operation still in flight.
    pub detach_timeouts_in_flight: u64,
    /// Asynchronous revocations ([`platform::revoke_async`]) that returned with leases still
    /// held: the renderer retires the window afterwards. Not detach timeouts.
    pub retiring: u64,
}

/// A consistent view of a surface's state.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Snapshot {
    /// The current attachment's number, or 0 while no window is attached.
    pub attachment: u64,
    /// Zero while detached.
    pub extent: Extent,
    pub closed: bool,
    pub counters: Counters,
}

#[cfg(not(target_arch = "wasm32"))]
type Waker = Arc<dyn Fn() + Send + Sync>;

#[cfg(not(target_arch = "wasm32"))]
#[derive(Default)]
struct Admission {
    revoked: bool,
    in_flight: u32,
    leases: u32,
    /// Set by [`platform::revoke_async`]: the retirement time is measured from here to the
    /// cell's drop.
    retiring_since: Option<Instant>,
}

/// One attachment of one platform window. Owns the window reference (and, through it, the
/// host's claim on the window, [`host`]); both are released when the last `Arc` is dropped.
#[cfg(not(target_arch = "wasm32"))]
pub struct WindowCell {
    window: Box<dyn PlatformWindow>,
    admission: Mutex<Admission>,
    /// Signalled when a lease is dropped.
    released: Condvar,
}

#[cfg(not(target_arch = "wasm32"))]
impl WindowCell {
    fn admission(&self) -> MutexGuard<'_, Admission> {
        self.admission.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn revoke(&self) {
        self.admission().revoked = true;
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for WindowCell {
    fn drop(&mut self) {
        WINDOW_RELEASES.fetch_add(1, Ordering::SeqCst);
        // Retirement after an asynchronous revocation: atomics only, so no lock is taken here.
        // The window (then its claim) is dropped after this, with the cell's fields.
        let since = self.admission.get_mut().unwrap_or_else(|e| e.into_inner()).retiring_since;
        if let Some(since) = since {
            let elapsed = since.elapsed();
            RETIRED.fetch_add(1, Ordering::SeqCst);
            RETIRE_MAX_US.fetch_max(elapsed.as_micros() as u64, Ordering::SeqCst);
            if elapsed > RETIRE_WARN {
                RETIRE_OVER.fetch_add(1, Ordering::SeqCst);
                log::warn!("rnrs-surface: window retired {elapsed:?} after its asynchronous revocation");
            } else {
                log::info!("rnrs-surface: window retired {:.3} ms after its asynchronous revocation", elapsed.as_secs_f64() * 1e3);
            }
        }
    }
}

/// Retirements slower than this are logged and counted ([`platform::retirement_stats`]).
#[cfg(not(target_arch = "wasm32"))]
pub const RETIRE_WARN: Duration = Duration::from_millis(1500);
#[cfg(not(target_arch = "wasm32"))]
static RETIRED: AtomicU64 = AtomicU64::new(0);
#[cfg(not(target_arch = "wasm32"))]
static RETIRE_MAX_US: AtomicU64 = AtomicU64::new(0);
#[cfg(not(target_arch = "wasm32"))]
static RETIRE_OVER: AtomicU64 = AtomicU64::new(0);

struct State {
    #[cfg(not(target_arch = "wasm32"))]
    window: Option<Arc<WindowCell>>,
    attachment: u64,
    extent: Extent,
    closed: bool,
    #[cfg(not(target_arch = "wasm32"))]
    waker: Option<Waker>,
    counters: Counters,
}

struct Inner {
    key: u64,
    state: Mutex<State>,
    /// Touch input (touch.rs); taken alone, never with `state`.
    touch: Mutex<TouchQueue>,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn touch(&self) -> MutexGuard<'_, TouchQueue> {
        self.touch.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        {
            let mut map = registry();
            if map.get(&self.key).is_some_and(|w| w.strong_count() == 0) {
                map.remove(&self.key);
            }
        } // registry guard released before producer cleanup

        #[cfg(target_arch = "wasm32")]
        web_producer::remove(self.key);
        // The state (and any attached cell) is dropped after this, with no lock held.
    }
}

/// Version of the contract between this crate and the app's surface host, recorded in a surface
/// module's manifest: the native [`host::SurfaceTable`] (`RNRS_SURFACE_ABI` in RnrsAbi.h; the host
/// accepts a table only with exactly this number and its own struct size) and the browser exports
/// (`web_exports`, checked by @rnrs/surface's bootstrap). Any change to the table, its callback,
/// its codes or those exports bumps it everywhere.
pub const SURFACE_ABI: u32 = 1;

/// Local keys start at 1 (0 means "no surface" on the platform side) and stay below 2^32; with
/// the owner (< 2^21) in the high bits, keys stay below 2^53, so they are exact JS numbers.
static NEXT_KEY: AtomicU64 = AtomicU64::new(1);
/// Bits of a key below the owner number.
pub const OWNER_SHIFT: u32 = 32;
/// Owner numbers stay below this.
pub const OWNER_LIMIT: u32 = 1 << 21;
static NEXT_ATTACHMENT: AtomicU64 = AtomicU64::new(1);
#[cfg(not(target_arch = "wasm32"))]
static WINDOW_RELEASES: AtomicU64 = AtomicU64::new(0);

fn registry() -> MutexGuard<'static, HashMap<u64, Weak<Inner>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<u64, Weak<Inner>>>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// The browser owner number of this Wasm instance ([`bind_web`]), 0 until bound.
#[cfg(target_arch = "wasm32")]
static WEB_OWNER: AtomicU32 = AtomicU32::new(0);

/// Browser: binds this instance to `owner`, a number the app's surface bootstrap allocated,
/// unless it is already bound (by an earlier installation of the same instance, possibly through
/// another JS object for it). Returns the owner the instance is bound to: `owner`, the earlier
/// one, or 0 if it is unbound and `owner` is out of range. The binding never changes.
#[cfg(target_arch = "wasm32")]
pub(crate) fn bind_web(owner: u32) -> u32 {
    bind_once(&WEB_OWNER, owner)
}

/// [`bind_web`]'s rule on any cell (tested natively): stores `owner` if the cell is still 0 and
/// `owner` is in range; returns what the cell holds afterwards.
#[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
fn bind_once(cell: &AtomicU32, owner: u32) -> u32 {
    if owner == 0 || owner >= OWNER_LIMIT {
        return cell.load(Ordering::SeqCst);
    }
    match cell.compare_exchange(0, owner, Ordering::SeqCst, Ordering::SeqCst) {
        Ok(_) => owner,
        Err(bound) => bound,
    }
}

/// This copy's owner number for new keys (native: [`host::bind`]; browser: [`bind_web`]).
/// Android, iOS and the browser refuse to create a surface before the app's host bound this
/// binary, so an ordering bug fails loudly instead of producing keys no view can attach; host
/// tests use owner 0.
fn owner() -> Result<u64, String> {
    #[cfg(not(target_arch = "wasm32"))]
    let owner = host::owner();
    #[cfg(target_arch = "wasm32")]
    let owner = WEB_OWNER.load(Ordering::SeqCst);
    if owner == 0 && cfg!(target_arch = "wasm32") {
        return Err("rnrs-surface: this Wasm instance is not bound to the app's surface host; pass createSurfaceBootstrap (@rnrs/surface/browser) to initRnrs before creating surfaces".into());
    }
    if owner == 0 && cfg!(any(target_os = "android", target_os = "ios")) {
        return Err("rnrs-surface: this module binary is not bound to the app's surface host (packages/runtime/cpp/RnrsSurfaceHost.h); surfaces can be created only by modules the runtime registry has loaded".into());
    }
    Ok(owner.into())
}

fn lookup(key: u64) -> Option<Arc<Inner>> {
    registry().get(&key).and_then(Weak::upgrade)
}

#[cfg(not(target_arch = "wasm32"))]
fn wake(waker: Option<Waker>) {
    if let Some(waker) = waker {
        waker();
    }
}

/// A rendering surface: owned by a renderer, named to JS by [`Surface::key`]. Clones share
/// the surface; it is unregistered when the last clone is gone.
#[derive(Clone)]
pub struct Surface {
    inner: Arc<Inner>,
}

impl Surface {
    /// Fails if this binary has used 2^32 keys or, on Android and iOS, if the app's surface
    /// host has not bound it ([`host`]; it binds every binary before any module code runs).
    pub fn new() -> Result<Self, String> {
        let owner = owner()?;
        let local = NEXT_KEY.fetch_add(1, Ordering::Relaxed);
        if local >= 1 << OWNER_SHIFT {
            return Err("surface keys exhausted".into());
        }
        let key = (owner << OWNER_SHIFT) | local;
        let inner = Arc::new(Inner {
            key,
            state: Mutex::new(State {
                #[cfg(not(target_arch = "wasm32"))]
                window: None,
                attachment: 0, extent: Extent::default(), closed: false,
                #[cfg(not(target_arch = "wasm32"))]
                waker: None,
                counters: Counters::default(),
            }),
            touch: Mutex::new(TouchQueue::default()),
        });
        registry().insert(key, Arc::downgrade(&inner));
        Ok(Self { inner })
    }

    /// The opaque key passed to `<SurfaceView surfaceKey={...}>`.
    pub fn key(&self) -> u64 {
        self.inner.key
    }

    /// Called (on the platform UI thread or the closing thread, with no lock held) after every
    /// attach, resize, detach and close. It must not block: typically it notifies the render
    /// thread.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn set_waker(&self, waker: impl Fn() + Send + Sync + 'static) {
        self.inner.lock().waker = Some(Arc::new(waker));
    }

    /// Opts this surface in to touch input (touch.rs). Views still deliver touches only with
    /// `touchInput="rust"`; until both are set the view consumes nothing.
    pub fn enable_touch(&self) {
        self.inner.touch().enable();
    }

    /// Moves every queued touch record into `out` (cleared first; at most
    /// [`touch::QUEUE_CAPACITY`]). Call before every update, also while paused or detached, so
    /// resets are applied promptly. Holds the touch lock only for the move.
    pub fn drain_touch(&self, out: &mut Vec<TouchRecord>) {
        self.inner.touch().drain(out);
    }

    /// Touch counters, and the pointers currently down on the producer side.
    pub fn touch_counters(&self) -> (TouchCounters, usize) {
        let t = self.inner.touch();
        (t.counters, t.active())
    }

    pub fn snapshot(&self) -> Snapshot {
        let s = self.inner.lock();
        Snapshot { attachment: s.attachment, extent: s.extent, closed: s.closed, counters: s.counters }
    }

    /// A lease on the attached window, or None while detached, after close, or once the
    /// attachment is revoked.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn lease(&self) -> Option<WindowLease> {
        let (cell, attachment) = {
            let s = self.inner.lock();
            if s.closed {
                return None;
            }
            (s.window.clone()?, s.attachment)
        };
        let admitted = {
            let mut a = cell.admission();
            if !a.revoked {
                a.leases += 1;
            }
            !a.revoked
        };
        // A refused clone is dropped here, with no lock held.
        admitted.then(|| WindowLease { cell: Some(cell), attachment, surface: self.inner.clone() })
    }

    /// Refuses new attachments, leases and operations (revokes the current attachment) and
    /// wakes the renderer. Idempotent, never blocks, callable from any thread. An attached
    /// window stays retained until the platform detaches it, so that detach still waits for
    /// outstanding leases.
    pub fn close(&self) {
        #[cfg(target_arch = "wasm32")]
        {
            {
                let mut state = self.inner.lock();
                if state.closed { return; }
                state.closed = true;
            }
            web_producer::remove(self.key());
            web_exports::released(self.key(), self.snapshot().attachment);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
        let (waker, cell) = {
            let mut s = self.inner.lock();
            if s.closed {
                return;
            }
            s.closed = true;
            (s.waker.take(), s.window.clone())
        };
        self.inner.touch().close();
        if let Some(cell) = &cell {
            cell.revoke();
        }
        drop(cell);
        wake(waker);
        }
    }
}

/// Retains one attachment's platform window for rendering. Implements the raw-window-handle
/// traits; the handles stay valid while the lease is alive. Clones count as separate leases.
#[cfg(not(target_arch = "wasm32"))]
pub struct WindowLease {
    cell: Option<Arc<WindowCell>>,
    attachment: u64,
    /// Keeps the surface registered, so the platform detach can find it and wait for this
    /// lease even after the renderer dropped its own handle.
    surface: Arc<Inner>,
}

/// An admitted operation; dropping it ends the operation.
#[cfg(not(target_arch = "wasm32"))]
pub struct Admitted<'a> {
    cell: &'a WindowCell,
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for Admitted<'_> {
    fn drop(&mut self) {
        self.cell.admission().in_flight -= 1;
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl WindowLease {
    pub fn attachment(&self) -> u64 {
        self.attachment
    }

    fn cell(&self) -> &WindowCell {
        self.cell.as_ref().expect("lease is alive")
    }

    /// Admits one operation on the window (see the module docs), or None once the
    /// attachment is revoked. Hold the result only for the operation, without other locks.
    pub fn admit(&self) -> Option<Admitted<'_>> {
        let cell = self.cell();
        let mut a = cell.admission();
        if a.revoked {
            return None;
        }
        a.in_flight += 1;
        Some(Admitted { cell })
    }

    /// Whether the attachment has been revoked (detached or closed).
    pub fn is_revoked(&self) -> bool {
        self.cell().admission().revoked
    }

    /// The window's `CAMetalLayer` (iOS), valid while this lease is alive; None elsewhere.
    pub fn metal_layer(&self) -> Option<NonNull<c_void>> {
        self.cell().window.metal_layer()
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Clone for WindowLease {
    fn clone(&self) -> Self {
        let cell = self.cell.clone().expect("lease is alive");
        cell.admission().leases += 1;
        Self { cell: Some(cell), attachment: self.attachment, surface: self.surface.clone() }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for WindowLease {
    fn drop(&mut self) {
        let cell = self.cell.take().expect("dropped once");
        {
            let mut a = cell.admission();
            a.leases -= 1;
            cell.released.notify_all();
        }
        // Possibly the last reference: releases the window and its claim, no lock held.
        drop(cell);
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl HasWindowHandle for WindowLease {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let raw = self.cell().window.raw_window_handle()?;
        // SAFETY: the lease retains the window object for its own lifetime.
        Ok(unsafe { WindowHandle::borrow_raw(raw) })
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl HasDisplayHandle for WindowLease {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        // SAFETY: as above; Android's display handle carries no data.
        Ok(unsafe { DisplayHandle::borrow_raw(self.cell().window.raw_display_handle()) })
    }
}

/// Entry points for the platform view, reached through this binary's surface table ([`host`]).
/// Every function is safe to call with stale keys or attachments: they are refused or ignored,
/// never errors.
#[cfg(not(target_arch = "wasm32"))]
pub mod platform {
    use super::*;

    #[derive(Debug, PartialEq, Eq)]
    pub enum AttachError {
        /// No live surface has this key (disposed, or created by an earlier JS runtime).
        UnknownKey,
        Closed,
        /// This surface already has a window attached (first attached wins). The platform
        /// retries later; see the Kotlin view.
        SurfaceBusy,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub enum Detached {
        /// Every lease of the attachment was dropped.
        Released,
        /// The timeout passed with leases outstanding. The attachment is revoked (no new
        /// operation is admitted); `in_flight` operations admitted earlier may still finish.
        TimedOut { in_flight: u32 },
        /// The key or attachment is not current: nothing to do.
        Stale,
    }

    /// Attaches `window` (whose ownership passes here; released if refused). Returns the new
    /// attachment's number, always nonzero. That no other attachment of any binary holds the
    /// same window is the host's to check before (its claim travels inside `window`, [`host`]).
    pub fn attach(key: u64, window: Box<dyn PlatformWindow>, extent: Extent) -> Result<u64, AttachError> {
        let Some(inner) = lookup(key) else { return Err(AttachError::UnknownKey) };
        let cell = Arc::new(WindowCell { window, admission: Mutex::new(Admission::default()), released: Condvar::new() });
        let result = {
            let mut s = inner.lock();
            if s.closed || s.window.is_some() {
                s.counters.refused_attaches += 1;
                Err(if s.closed { AttachError::Closed } else { AttachError::SurfaceBusy })
            } else {
                let attachment = NEXT_ATTACHMENT.fetch_add(1, Ordering::Relaxed);
                s.window = Some(cell.clone());
                s.attachment = attachment;
                s.extent = extent;
                s.counters.attaches += 1;
                Ok((attachment, s.waker.clone()))
            }
        };
        drop(cell); // a refused cell releases its window and claim here, no lock held
        let (attachment, waker) = result?;
        inner.touch().begin(attachment, extent);
        wake(waker);
        Ok(attachment)
    }

    /// Updates the size or scale of the current attachment; false if it is not current.
    pub fn resize(key: u64, attachment: u64, extent: Extent) -> bool {
        let Some(inner) = lookup(key) else { return false };
        let waker = {
            let mut s = inner.lock();
            if s.window.is_none() || s.attachment != attachment {
                return false;
            }
            if s.extent == extent {
                return true;
            }
            s.extent = extent;
            s.counters.resizes += 1;
            s.waker.clone()
        };
        inner.touch().resize(attachment, extent);
        wake(waker);
        true
    }

    /// Detaches and revokes `attachment`, then waits up to `timeout` for its leases.
    pub fn detach(key: u64, attachment: u64, timeout: Duration) -> Detached {
        let Some(inner) = lookup(key) else { return Detached::Stale };
        let (cell, waker) = {
            let mut s = inner.lock();
            if s.window.is_none() || s.attachment != attachment {
                return Detached::Stale;
            }
            let cell = s.window.take().expect("checked");
            s.attachment = 0;
            s.extent = Extent::default();
            s.counters.detaches += 1;
            (cell, s.waker.clone())
        };
        cell.revoke();
        inner.touch().end(attachment, ResetReason::Detached);
        wake(waker);
        let deadline = Instant::now() + timeout;
        let outcome = {
            let mut a = cell.admission();
            loop {
                if a.leases == 0 {
                    break Detached::Released;
                }
                let now = Instant::now();
                if now >= deadline {
                    break Detached::TimedOut { in_flight: a.in_flight };
                }
                a = cell.released.wait_timeout(a, deadline - now).unwrap_or_else(|e| e.into_inner()).0;
            }
        };
        if let Detached::TimedOut { in_flight } = outcome {
            let mut s = inner.lock();
            s.counters.detach_timeouts += 1;
            s.counters.detach_timeouts_in_flight += (in_flight > 0) as u64;
            drop(s);
            log::warn!("rnrs-surface: surface {key}: leases still held {timeout:?} after detach ({in_flight} admitted operation(s) in flight); attachment revoked, window retained until released");
        }
        drop(cell); // releases the window and its claim if this was the last reference
        outcome
    }

    /// The result of [`revoke_async`].
    #[derive(Debug, PartialEq, Eq)]
    pub enum Revoked {
        /// No lease was held: the window is released (or will be with the last reference).
        Released,
        /// Leases are still held; the renderer retires the window when it drops them.
        /// `in_flight` operations admitted earlier may still finish.
        Retiring { in_flight: u32 },
        /// The key or attachment is not current: nothing to do.
        Stale,
    }

    /// Detaches and revokes `attachment` without waiting, for platforms that keep the window
    /// valid by reference (iOS retains the view). After it returns no new operation is
    /// admitted; the window is released when the renderer drops its last lease, and the time
    /// from here to that release is recorded ([`retirement_stats`]). Never blocks beyond the
    /// surface and admission locks, each taken alone. Android keeps the synchronous [`detach`].
    pub fn revoke_async(key: u64, attachment: u64) -> Revoked {
        let Some(inner) = lookup(key) else { return Revoked::Stale };
        let (cell, waker) = {
            let mut s = inner.lock();
            if s.window.is_none() || s.attachment != attachment {
                return Revoked::Stale;
            }
            let cell = s.window.take().expect("checked");
            s.attachment = 0;
            s.extent = Extent::default();
            s.counters.detaches += 1;
            (cell, s.waker.clone())
        };
        inner.touch().end(attachment, ResetReason::Detached);
        let outcome = {
            let mut a = cell.admission();
            a.revoked = true;
            a.retiring_since = Some(Instant::now());
            if a.leases == 0 {
                Revoked::Released
            } else {
                Revoked::Retiring { in_flight: a.in_flight }
            }
        };
        if matches!(outcome, Revoked::Retiring { .. }) {
            inner.lock().counters.retiring += 1;
        }
        wake(waker);
        drop(cell); // released here if no lease holds it, with no lock held
        outcome
    }

    /// One touch transition from the platform view (touch.rs) for `attachment` of surface
    /// `key`: component-local physical pixels, platform uptime in milliseconds. True if accepted
    /// (for a down: this surface takes the pointer; the view should then consume the gesture).
    /// Wakes the renderer whenever the queue changed. Never calls JS; never waits for rendering.
    pub fn touch(key: u64, attachment: u64, phase: touch::Phase, pointer: i32, x_px: f32, y_px: f32, time_ms: i64) -> bool {
        let Some(inner) = lookup(key) else { return false };
        let (accepted, changed) = {
            let mut t = inner.touch();
            let refused = t.counters.refused_stale;
            let accepted = t.push(attachment, phase, pointer, x_px, y_px, time_ms);
            (accepted, t.counters.refused_stale == refused)
        };
        if changed {
            let waker = inner.lock().waker.clone();
            wake(waker);
        }
        accepted
    }

    /// Windows retired after [`revoke_async`] since process start.
    #[derive(Clone, Copy, Debug, Default, PartialEq)]
    pub struct RetirementStats {
        pub retired: u64,
        /// The longest time from revocation to release.
        pub max_ms: f64,
        /// Retirements slower than [`RETIRE_WARN`].
        pub over_warn: u64,
    }

    /// Process-wide retirement diagnostics (lab runs and tests).
    pub fn retirement_stats() -> RetirementStats {
        RetirementStats {
            retired: RETIRED.load(Ordering::SeqCst),
            max_ms: RETIRE_MAX_US.load(Ordering::SeqCst) as f64 / 1000.0,
            over_warn: RETIRE_OVER.load(Ordering::SeqCst),
        }
    }

    /// Number of live surfaces in the registry (diagnostics and tests).
    pub fn live_surfaces() -> usize {
        registry().values().filter(|w| w.strong_count() > 0).count()
    }

    /// Total windows released since process start (diagnostics and tests).
    pub fn window_releases() -> u64 {
        WINDOW_RELEASES.load(Ordering::SeqCst)
    }
}

/// The wgpu adapter (feature `wgpu`): renderers implement [`gpu::Renderer`].
#[cfg(feature = "wgpu")]
pub mod gpu;

#[cfg(test)]
mod tests;

#[cfg(any(target_arch = "wasm32", test))]
pub mod web_producer;
#[cfg(any(target_arch = "wasm32", test))]
pub mod web_host;
#[cfg(target_arch = "wasm32")]
pub mod web_exports;
