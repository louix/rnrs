//! Android: `ANativeWindow` ownership. The JNI entry points of
//! `dev.rustjsilab.rnrs.surface.RnrsSurfaceNative` are the framework C++'s
//! (packages/runtime/android/src/main/jni/RnrsSurfaceJni.cpp), which takes the window reference
//! and hands it to the owning binary through [`crate::host`].
use std::ffi::c_void;
use std::ptr::NonNull;

use raw_window_handle::{AndroidDisplayHandle, AndroidNdkWindowHandle, HandleError, RawDisplayHandle, RawWindowHandle};

use crate::PlatformWindow;

#[link(name = "android")]
extern "C" {
    fn ANativeWindow_release(window: *mut c_void);
}

/// One reference to an `ANativeWindow`, released on drop. `ANativeWindow` is reference
/// counted and its acquire/release are thread-safe, so the reference may move between threads.
pub struct AndroidWindow(NonNull<c_void>);

// SAFETY: see above; the pointer is only passed to thread-safe NDK and graphics APIs.
unsafe impl Send for AndroidWindow {}
unsafe impl Sync for AndroidWindow {}

impl AndroidWindow {
    /// # Safety
    /// `window` is one `ANativeWindow` reference, whose ownership passes to the result.
    pub(crate) unsafe fn adopt(window: NonNull<c_void>) -> Self {
        Self(window)
    }
}

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
}
