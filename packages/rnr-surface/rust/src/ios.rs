//! iOS: the `CAMetalLayer`-backed window of `RnrSurfaceViewComponentView`
//! (packages/rnr-surface/ios), its C entry points, and the explicit Core Animation transaction
//! for configures (docs/research/ios-surface-c1-design.md).
//!
//! Threads: every entry point is called on the main thread (UIKit). The render thread reaches
//! the layer only through a lease (wgpu, under admission) and [`configure_in_transaction`].
//!
//! Layer: the window is a standalone `CAMetalLayer` (delegate nil, implicit actions disabled)
//! that `RnrMetalView` creates on the main thread and adds as a sublayer of its own (default)
//! backing layer. It is not view-backed: UIKit forbids off-main writes to a view's backing
//! layer (C1 S3 run 2), and the render thread must write the Metal properties. The main thread
//! owns the layer tree and the sublayer's geometry; the render thread writes only the Metal
//! properties, in its own explicit transaction ([`configure_in_transaction`]).
//!
//! Ownership: an [`IosWindow`] holds one retain on the view and one on the layer (both taken
//! synchronously on the main thread at attach). Dropping the window (possibly on the render
//! thread, with the last lease) schedules the release of *our* two references on the main
//! queue. Other references to the layer (wgpu-hal's own retain, drawables in flight) may be
//! released elsewhere; that is not claimed to happen on the main thread.
//!
//! Only libobjc and libdispatch are used, through `extern "C"` declarations (no crate). The
//! app links both (and QuartzCore, declared by the RnrSurface pod).
//!
//! Autorelease pools: the render thread is a plain thread with no pool, so Objective-C objects
//! autoreleased there would accumulate until the thread exits. [`configure_in_transaction`]
//! runs inside a pool, and the renderer wraps each present in [`autoreleasepool`].
//!
//! Objective-C exceptions: these `extern "C"` frames do not unwind, so an exception crossing
//! them aborts the process. None of the selectors messaged here throws in normal use.
use std::ffi::{c_char, c_void, CStr};
use std::ptr::NonNull;

use raw_window_handle::{HandleError, RawDisplayHandle, RawWindowHandle, UiKitDisplayHandle};

use crate::layer::{self, Configured, LayerTransaction};
use crate::platform::{self, AttachError, Revoked};
use crate::{Extent, PlatformWindow, WindowLease};

type Id = *mut c_void;
type Sel = *mut c_void;

extern "C" {
    fn objc_retain(obj: Id) -> Id;
    fn objc_release(obj: Id);
    fn objc_getClass(name: *const c_char) -> Id;
    fn sel_registerName(name: *const c_char) -> Sel;
    /// Called only through the typed casts below (arm64 requires the exact signature).
    fn objc_msgSend();
    /// The main queue (`dispatch_get_main_queue()` is `&_dispatch_main_q`).
    static _dispatch_main_q: c_void;
    fn dispatch_async_f(queue: *const c_void, context: *mut c_void, work: extern "C" fn(*mut c_void));
    fn pthread_main_np() -> i32;
    fn objc_autoreleasePoolPush() -> *mut c_void;
    fn objc_autoreleasePoolPop(pool: *mut c_void);
}

/// Runs `f` inside an Objective-C autorelease pool (`@autoreleasepool`), on any thread.
pub fn autoreleasepool<R>(f: impl FnOnce() -> R) -> R {
    struct Pool(*mut c_void);
    impl Drop for Pool {
        fn drop(&mut self) {
            // SAFETY: pops exactly the pool pushed below, on the same thread.
            unsafe { objc_autoreleasePoolPop(self.0) }
        }
    }
    // SAFETY: push and pop are paired by the guard on this thread.
    let _pool = Pool(unsafe { objc_autoreleasePoolPush() });
    f()
}

fn sel(name: &CStr) -> Sel {
    // SAFETY: a valid C string; selectors are registered process-wide and never freed.
    unsafe { sel_registerName(name.as_ptr()) }
}

/// `[obj sel]` returning nothing.
unsafe fn send_void(obj: Id, name: &CStr) {
    let f: unsafe extern "C" fn(Id, Sel) = unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
    unsafe { f(obj, sel(name)) }
}

/// `[obj sel:value]` with a `BOOL` argument (one byte on every Apple ABI; 1 is YES).
unsafe fn send_set_bool(obj: Id, name: &CStr, value: bool) {
    let f: unsafe extern "C" fn(Id, Sel, i8) = unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
    unsafe { f(obj, sel(name), value as i8) }
}

/// `[obj sel]` returning a `BOOL`.
unsafe fn send_get_bool(obj: Id, name: &CStr) -> bool {
    let f: unsafe extern "C" fn(Id, Sel) -> i8 = unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
    unsafe { f(obj, sel(name)) != 0 }
}

fn on_main_thread() -> bool {
    // SAFETY: no arguments; pure query.
    unsafe { pthread_main_np() == 1 }
}

extern "C" fn release_object(context: *mut c_void) {
    // SAFETY: `context` is the object whose retain was handed to this call.
    unsafe { objc_release(context) }
}

/// Releases one retain of `obj` on the main queue, asynchronously (never blocks).
fn release_on_main(obj: NonNull<c_void>) {
    // SAFETY: the main queue is a static object; the callback releases exactly the retain
    // passed as its context.
    unsafe { dispatch_async_f(std::ptr::addr_of!(_dispatch_main_q), obj.as_ptr(), release_object) }
}

/// `[CATransaction setDisableActions:YES]` on the calling thread's transaction.
fn disable_actions() {
    // SAFETY: a static class name and a class method with a BOOL argument; a nil class (no
    // QuartzCore) makes this a no-op.
    unsafe { send_set_bool(objc_getClass(c"CATransaction".as_ptr()), c"setDisableActions:", true) }
}

/// One retain of an `RnrMetalView` and one of its standalone `CAMetalLayer` sublayer.
pub struct IosWindow {
    view: NonNull<c_void>,
    layer: NonNull<c_void>,
}

// SAFETY: the view is only messaged on the main thread (retained at attach, released on the
// main queue). The layer is retained and released the same way; on the render thread it is
// messaged only by wgpu and configure_in_transaction for its Metal properties, never its layer
// tree. Core Animation takes its own lock for layer property access; off-main writes to this
// non-view-backed layer are an empirical item of the design.
unsafe impl Send for IosWindow {}
unsafe impl Sync for IosWindow {}

impl IosWindow {
    /// Retains `view` and `layer`. Main thread only.
    ///
    /// # Safety
    /// `view` is a live `UIView` and `layer` a live `CAMetalLayer` (its sublayer).
    unsafe fn retain(view: NonNull<c_void>, layer: NonNull<c_void>) -> Self {
        // SAFETY (caller): live objects; objc_retain returns the same pointer.
        unsafe {
            objc_retain(view.as_ptr());
            objc_retain(layer.as_ptr());
        }
        Self { view, layer }
    }
}

impl Drop for IosWindow {
    fn drop(&mut self) {
        release_on_main(self.layer);
        release_on_main(self.view);
    }
}

impl PlatformWindow for IosWindow {
    /// Refused: wgpu's UIKit path requires the main thread (raw-window-metal), so renderers use
    /// [`PlatformWindow::metal_layer`].
    fn raw_window_handle(&self) -> Result<RawWindowHandle, HandleError> {
        Err(HandleError::NotSupported)
    }
    fn raw_display_handle(&self) -> RawDisplayHandle {
        RawDisplayHandle::UiKit(UiKitDisplayHandle::new())
    }
    /// The layer address: stable while the view is retained.
    fn identity(&self) -> usize {
        self.layer.as_ptr() as usize
    }
    fn metal_layer(&self) -> Option<NonNull<c_void>> {
        Some(self.layer)
    }
}

/// `CATransaction` and the layer's drawable-timeout property, messaged on the configuring
/// (render) thread.
struct CaTransaction {
    class: Id,
    layer: Id,
}

impl LayerTransaction for CaTransaction {
    fn begin(&mut self) {
        // SAFETY: `+[CATransaction begin]` (a nil class makes this a no-op, and the read-back
        // below then reports NO, which refuses acquires).
        unsafe { send_void(self.class, c"begin") }
    }
    fn disable_actions(&mut self) {
        disable_actions();
    }
    fn allow_drawable_timeout(&mut self) {
        // SAFETY: `-[CAMetalLayer setAllowsNextDrawableTimeout:]` (iOS 11+).
        unsafe { send_set_bool(self.layer, c"setAllowsNextDrawableTimeout:", true) }
    }
    fn commit(&mut self) {
        // SAFETY: `+[CATransaction commit]`.
        unsafe { send_void(self.class, c"commit") }
    }
    fn drawable_timeout_allowed(&mut self) -> bool {
        // SAFETY: `-[CAMetalLayer allowsNextDrawableTimeout]`.
        unsafe { send_get_bool(self.layer, c"allowsNextDrawableTimeout") }
    }
}

/// Runs `configure` (wgpu's `Surface::configure` on the lease's layer) inside an explicit Core
/// Animation transaction, restores the documented drawable timeout, always commits, and reads
/// the property back ([`layer::configure_in_transaction`]). Without a Metal layer (not an iOS
/// window) acquires are refused.
pub fn configure_in_transaction<R, E>(lease: &WindowLease, configure: impl FnOnce() -> Result<R, E>) -> Configured<R, E> {
    match lease.metal_layer() {
        Some(layer) => autoreleasepool(|| {
            // SAFETY: a static class name; nil if QuartzCore is not loaded (see `begin`).
            let class = unsafe { objc_getClass(c"CATransaction".as_ptr()) };
            layer::configure_in_transaction(&mut CaTransaction { class, layer: layer.as_ptr() }, configure)
        }),
        None => Configured { result: configure(), acquire_allowed: false },
    }
}

/// Result codes of `rnr_surface_attach` when refused (an attachment number is always positive).
pub const REFUSED: i64 = 0;
/// Refused for now: the surface has another window, or this window is still owned by another
/// attachment. The view retries with backoff.
pub const BUSY: i64 = -1;

fn extent(width: u32, height: u32, scale: f32) -> Extent {
    Extent { width, height, scale: if scale.is_finite() && scale > 0.0 { scale } else { 1.0 } }
}

fn key(value: u64) -> Option<u64> {
    (value > 0).then_some(value)
}

/// Attaches `layer` (the standalone `CAMetalLayer` sublayer of `view`, an `RnrMetalView`) to
/// the surface `key`: the attachment number (positive), [`BUSY`], or [`REFUSED`]. Main thread
/// only (refused elsewhere). Both are retained before this returns; a refused attach releases
/// those retains on the main queue.
///
/// # Safety
/// `view` is null or a live `UIView`; `layer` is null or a live `CAMetalLayer`.
#[no_mangle]
pub unsafe extern "C" fn rnr_surface_attach(key_value: u64, view: *mut c_void, layer: *mut c_void, width: u32, height: u32, scale: f32) -> i64 {
    if !on_main_thread() {
        log::error!("rnr-surface: rnr_surface_attach called off the main thread; refused");
        return REFUSED;
    }
    let Some(key) = key(key_value) else { return REFUSED };
    let (Some(view), Some(layer)) = (NonNull::new(view), NonNull::new(layer)) else { return REFUSED };
    // SAFETY (caller): a live view and its live Metal layer.
    let window = unsafe { IosWindow::retain(view, layer) };
    match platform::attach(key, Box::new(window), extent(width, height, scale)) {
        Ok(attachment) => i64::try_from(attachment).unwrap_or(REFUSED),
        Err(AttachError::SurfaceBusy | AttachError::WindowBusy) => BUSY,
        Err(AttachError::UnknownKey) => {
            log::debug!("rnr-surface: no live surface {key} (disposed, or from an earlier JS runtime); not attached");
            REFUSED
        }
        Err(AttachError::Closed) => REFUSED,
    }
}

/// Updates the size or scale of the current attachment; false if it is not current. Main
/// thread only, like every entry point (refused elsewhere, so callers keep one thread order).
#[no_mangle]
pub extern "C" fn rnr_surface_resize(key_value: u64, attachment: u64, width: u32, height: u32, scale: f32) -> bool {
    if !on_main_thread() {
        log::error!("rnr-surface: rnr_surface_resize called off the main thread; refused");
        return false;
    }
    let Some(key) = key(key_value) else { return false };
    platform::resize(key, attachment, extent(width, height, scale))
}

/// Revokes the attachment without waiting ([`platform::revoke_async`]): 0 released, 1 retiring
/// (the renderer releases the window later), -1 stale. Main thread only (refused elsewhere,
/// returning -1; the attachment then stays current).
#[no_mangle]
pub extern "C" fn rnr_surface_revoke(key_value: u64, attachment: u64) -> i32 {
    if !on_main_thread() {
        log::error!("rnr-surface: rnr_surface_revoke called off the main thread; refused");
        return -1;
    }
    let Some(key) = key(key_value) else { return -1 };
    match platform::revoke_async(key, attachment) {
        Revoked::Released => 0,
        Revoked::Retiring { in_flight } => {
            log::debug!("rnr-surface: surface {key}: revoked #{attachment}, retiring ({in_flight} operation(s) in flight)");
            1
        }
        Revoked::Stale => -1,
    }
}

/// One touch transition from `RnrSurfaceViewComponentView` (crate::touch): `phase` 0 down,
/// 1 move, 2 up, 3 cancel, 4 cancel all; `slot` the view's per-attachment slot of the `UITouch`
/// (0..10, reused only after its touch ended); view-local physical pixels; `UITouch.timestamp`
/// in milliseconds. True if accepted. Main thread only (refused elsewhere).
#[no_mangle]
pub extern "C" fn rnr_surface_touch(key_value: u64, attachment: u64, phase: i32, slot: i32, x_px: f32, y_px: f32, time_ms: i64) -> bool {
    if !on_main_thread() {
        log::error!("rnr-surface: rnr_surface_touch called off the main thread; refused");
        return false;
    }
    let (Some(key), Some(phase)) = (key(key_value), crate::touch::Phase::from_code(phase)) else { return false };
    platform::touch(key, attachment, phase, slot, x_px, y_px, time_ms)
}

/// Diagnostics: live surfaces in the registry.
#[no_mangle]
pub extern "C" fn rnr_surface_live_surfaces() -> i32 {
    i32::try_from(platform::live_surfaces()).unwrap_or(i32::MAX)
}

/// Makes the linker keep the entry points above (the pod's view references them, but the
/// bundle is a static library member only linked when referenced).
pub(crate) fn keep_entry_points() {
    let entry_points: [*const (); 5] = [
        rnr_surface_attach as *const (),
        rnr_surface_resize as *const (),
        rnr_surface_revoke as *const (),
        rnr_surface_touch as *const (),
        rnr_surface_live_surfaces as *const (),
    ];
    std::hint::black_box(entry_points);
}
