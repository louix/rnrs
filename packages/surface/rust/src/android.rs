//! Android: `ANativeWindow` ownership and the JNI entry points of
//! `dev.rustjsilab.rnrs.surface.RnrsSurfaceNative` (packages/surface/android). All of them run
//! on the platform UI thread (SurfaceHolder callbacks); none touches JS.
//!
//! They are exported from the app's `librnrs.so`, which contains this crate through the Rust
//! bundle. A static library member is only linked if something references it, so
//! [`keep_entry_points`] (called by `Surface::new`) references every entry point.
use std::ffi::c_void;
use std::ptr::NonNull;
use std::time::Duration;

use raw_window_handle::{AndroidDisplayHandle, AndroidNdkWindowHandle, HandleError, RawDisplayHandle, RawWindowHandle};

use crate::platform::{self, AttachError, Detached};
use crate::{Extent, PlatformWindow};

type JniEnv = c_void;
type JObject = *mut c_void;

#[link(name = "android")]
extern "C" {
    /// Returns a new reference (released with `ANativeWindow_release`), or null.
    fn ANativeWindow_fromSurface(env: *mut JniEnv, surface: JObject) -> *mut c_void;
    fn ANativeWindow_release(window: *mut c_void);
}

/// One reference to an `ANativeWindow`, released on drop. `ANativeWindow` is reference
/// counted and its acquire/release are thread-safe, so the reference may move between threads.
pub struct AndroidWindow(NonNull<c_void>);

// SAFETY: see above; the pointer is only passed to thread-safe NDK and graphics APIs.
unsafe impl Send for AndroidWindow {}
unsafe impl Sync for AndroidWindow {}

impl Drop for AndroidWindow {
    fn drop(&mut self) {
        // SAFETY: we own exactly one reference.
        unsafe { ANativeWindow_release(self.0.as_ptr()) }
    }
}

impl PlatformWindow for AndroidWindow {
    fn raw_window_handle(&self) -> Result<RawWindowHandle, HandleError> {
        Ok(RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(self.0)))
    }
    fn raw_display_handle(&self) -> RawDisplayHandle {
        RawDisplayHandle::Android(AndroidDisplayHandle::new())
    }
    /// The `ANativeWindow` address: stable while this reference keeps the object alive.
    fn identity(&self) -> usize {
        self.0.as_ptr() as usize
    }
}

fn key(value: i64) -> Option<u64> {
    u64::try_from(value).ok().filter(|k| *k > 0)
}

fn extent(width: i32, height: i32, density: f32) -> Extent {
    Extent { width: width.max(0).unsigned_abs(), height: height.max(0).unsigned_abs(), scale: if density.is_finite() && density > 0.0 { density } else { 1.0 } }
}

/// Result codes of `nativeAttach` when refused (an attachment number is always positive).
pub const REFUSED: i64 = 0;
/// Refused for now: the surface has another window (first attached wins), or this window is
/// still owned by another attachment. The view retries with backoff.
pub const BUSY: i64 = -1;

/// `nativeAttach(key, surface, width, height, density)`: the attachment number (positive),
/// [`BUSY`], or [`REFUSED`] (unknown or closed key, no window for the Surface).
#[no_mangle]
pub extern "system" fn Java_dev_rustjsilab_rnrs_surface_RnrsSurfaceNative_nativeAttach(
    env: *mut JniEnv,
    _class: JObject,
    key_value: i64,
    surface: JObject,
    width: i32,
    height: i32,
    density: f32,
) -> i64 {
    let Some(key) = key(key_value) else { return REFUSED };
    // SAFETY: env and surface are the JNI arguments of this call.
    let Some(window) = NonNull::new(unsafe { ANativeWindow_fromSurface(env, surface) }) else {
        log::warn!("rnrs-surface: surface {key}: ANativeWindow_fromSurface returned null");
        return 0;
    };
    match platform::attach(key, Box::new(AndroidWindow(window)), extent(width, height, density)) {
        Ok(attachment) => i64::try_from(attachment).unwrap_or(REFUSED),
        Err(AttachError::SurfaceBusy | AttachError::WindowBusy) => BUSY,
        Err(AttachError::UnknownKey) => {
            log::debug!("rnrs-surface: no live surface {key} (disposed, or from an earlier JS runtime); not attached");
            REFUSED
        }
        Err(AttachError::Closed) => REFUSED,
    }
}

/// `nativeResize(key, attachment, width, height, density)`: false if not current.
#[no_mangle]
pub extern "system" fn Java_dev_rustjsilab_rnrs_surface_RnrsSurfaceNative_nativeResize(
    _env: *mut JniEnv,
    _class: JObject,
    key_value: i64,
    attachment: i64,
    width: i32,
    height: i32,
    density: f32,
) -> bool {
    let Some(key) = key(key_value) else { return false };
    platform::resize(key, attachment as u64, extent(width, height, density))
}

/// `nativeDetach(key, attachment, timeoutMs)`: waits (bounded) for the renderer to drop the
/// window. Returns false only if the timeout passed with the window still leased.
#[no_mangle]
pub extern "system" fn Java_dev_rustjsilab_rnrs_surface_RnrsSurfaceNative_nativeDetach(
    _env: *mut JniEnv,
    _class: JObject,
    key_value: i64,
    attachment: i64,
    timeout_ms: i32,
) -> bool {
    let Some(key) = key(key_value) else { return true };
    let timeout = Duration::from_millis(timeout_ms.clamp(0, 10_000) as u64);
    !matches!(platform::detach(key, attachment as u64, timeout), Detached::TimedOut { .. })
}

/// `nativeTouch(key, attachment, phase, pointerId, xPx, yPx, eventTimeMs)`: one pointer
/// transition (crate::touch). `phase` is the view's code (0 down, 1 move, 2 up, 3 cancel,
/// 4 cancel all); positions are view-local physical pixels; the time is the MotionEvent's
/// `SystemClock.uptimeMillis` time. True if accepted.
#[no_mangle]
pub extern "system" fn Java_dev_rustjsilab_rnrs_surface_RnrsSurfaceNative_nativeTouch(
    _env: *mut JniEnv,
    _class: JObject,
    key_value: i64,
    attachment: i64,
    phase: i32,
    pointer: i32,
    x_px: f32,
    y_px: f32,
    time_ms: i64,
) -> bool {
    let (Some(key), Some(phase)) = (key(key_value), crate::touch::Phase::from_code(phase)) else { return false };
    let Ok(attachment) = u64::try_from(attachment) else { return false };
    platform::touch(key, attachment, phase, pointer, x_px, y_px, time_ms)
}

/// `nativeLiveSurfaces()`: diagnostics.
#[no_mangle]
pub extern "system" fn Java_dev_rustjsilab_rnrs_surface_RnrsSurfaceNative_nativeLiveSurfaces(_env: *mut JniEnv, _class: JObject) -> i32 {
    i32::try_from(platform::live_surfaces()).unwrap_or(i32::MAX)
}

/// Makes the linker keep the entry points above (see the module comment).
pub(crate) fn keep_entry_points() {
    let entry_points: [*const (); 5] = [
        Java_dev_rustjsilab_rnrs_surface_RnrsSurfaceNative_nativeAttach as *const (),
        Java_dev_rustjsilab_rnrs_surface_RnrsSurfaceNative_nativeResize as *const (),
        Java_dev_rustjsilab_rnrs_surface_RnrsSurfaceNative_nativeDetach as *const (),
        Java_dev_rustjsilab_rnrs_surface_RnrsSurfaceNative_nativeLiveSurfaces as *const (),
        Java_dev_rustjsilab_rnrs_surface_RnrsSurfaceNative_nativeTouch as *const (),
    ];
    std::hint::black_box(entry_points);
}
