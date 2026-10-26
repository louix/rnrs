//! This binary's surface table: the C boundary between the app's surface host (the framework
//! C++, packages/runtime/cpp/RnrsSurfaceHost.h; `RnrsSurfaceV1` in RnrsAbi.h) and this copy of
//! rnrs-surface. Every module binary links its own copy, with its own registry, renderers and
//! GPU objects; the host reaches each only through its table (from the module table's `surface`
//! slot, `rnrs_android::ModuleTable::with_surface(table())`) and routes by the owner number in
//! the key. The host is the only definer of the platform entry points (JNI, `rnrs_surface_*`).
//!
//! Windows: the host claims a platform window before [`SurfaceTable::attach`] hands it here,
//! together with the claim. From then on this binary owns both, accepted or refused: the claim
//! travels with the window ([`Claimed`]) and goes back to the host exactly once, right after the
//! window reference itself is released, from whichever thread drops the last lease, with no lock
//! of this crate held. Until then no surface of any binary can attach that window.
use std::ffi::c_void;
use std::sync::OnceLock;

use raw_window_handle::{HandleError, RawDisplayHandle, RawWindowHandle};

use crate::{Extent, PlatformWindow, OWNER_LIMIT};

pub use crate::SURFACE_ABI;

/// `RnrsSurfaceRelease`: ends one claim of the host.
pub type ReleaseFn = extern "C" fn(u64);

/// `RnrsSurfaceV1` (RnrsAbi.h). Immutable static; see the C declaration for each entry.
#[repr(C)]
pub struct SurfaceTable {
    pub abi: u32,
    pub size: u32,
    pub bind: extern "C" fn(u32, ReleaseFn) -> bool,
    pub attach: unsafe extern "C" fn(u64, *mut c_void, *mut c_void, u32, u32, f32, u64) -> i64,
    pub resize: extern "C" fn(u64, u64, u32, u32, f32) -> bool,
    pub detach: extern "C" fn(u64, u64, u32) -> bool,
    pub revoke: extern "C" fn(u64, u64) -> i32,
    pub touch: extern "C" fn(u64, u64, i32, i32, f32, f32, i64) -> bool,
    pub live_surfaces: extern "C" fn() -> u32,
}

static TABLE: SurfaceTable = SurfaceTable {
    abi: SURFACE_ABI,
    size: std::mem::size_of::<SurfaceTable>() as u32,
    bind,
    attach,
    resize,
    detach,
    revoke,
    touch,
    live_surfaces,
};

/// This binary's table, for the generated module tables (opaque to rnrs-android).
pub const fn table() -> *const c_void {
    &TABLE as *const SurfaceTable as *const c_void
}

/// Result codes of `attach` when refused (an attachment number is always positive).
pub const REFUSED: i64 = 0;
/// Refused for now: the surface has another window. The view retries with backoff.
pub const BUSY: i64 = -1;

struct Binding {
    owner: u32,
    release: ReleaseFn,
}

static BINDING: OnceLock<Binding> = OnceLock::new();

/// The owner number this binary was bound to, or 0 before [`bind`].
pub(crate) fn owner() -> u32 {
    BINDING.get().map_or(0, |b| b.owner)
}

/// Once, by the host's registry, before any module code of this binary runs. Binding again to
/// the same owner is accepted; to another owner (or an out-of-range one) refused.
extern "C" fn bind(owner: u32, release: ReleaseFn) -> bool {
    if owner == 0 || owner >= OWNER_LIMIT {
        return false;
    }
    let bound = BINDING.get_or_init(|| Binding { owner, release });
    bound.owner == owner && bound.release as usize == release as usize
}

/// The host's claim on one platform window: returned exactly once, when dropped.
pub struct WindowClaim(u64);

impl Drop for WindowClaim {
    fn drop(&mut self) {
        // Claims only come from attach, which only a bound binary's host calls.
        match BINDING.get() {
            Some(binding) => (binding.release)(self.0),
            None => log::error!("rnrs-surface: window claim {} dropped by an unbound binary; no host to return it to", self.0),
        }
    }
}

/// A platform window and the host's claim on it. Fields drop in order: the window reference
/// first, then the claim, so the host never sees a window free while this binary still holds it.
pub struct Claimed<W> {
    window: W,
    _claim: WindowClaim,
}

impl<W: PlatformWindow> PlatformWindow for Claimed<W> {
    fn raw_window_handle(&self) -> Result<RawWindowHandle, HandleError> {
        self.window.raw_window_handle()
    }
    fn raw_display_handle(&self) -> RawDisplayHandle {
        self.window.raw_display_handle()
    }
    fn metal_layer(&self) -> Option<std::ptr::NonNull<c_void>> {
        self.window.metal_layer()
    }
}

fn extent(width: u32, height: u32, scale: f32) -> Extent {
    Extent { width, height, scale: if scale.is_finite() && scale > 0.0 { scale } else { 1.0 } }
}

/// The attachment number, [`BUSY`] or [`REFUSED`].
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
fn attached(key: u64, window: Box<dyn PlatformWindow>, extent: Extent) -> i64 {
    use crate::platform::{self, AttachError};
    match platform::attach(key, window, extent) {
        Ok(attachment) => i64::try_from(attachment).unwrap_or(REFUSED),
        Err(AttachError::SurfaceBusy) => BUSY,
        Err(AttachError::UnknownKey) => {
            log::debug!("rnrs-surface: no live surface {key} (disposed, or from an earlier JS runtime); not attached");
            REFUSED
        }
        Err(AttachError::Closed) => REFUSED,
    }
}

/// Android: `window` is one `ANativeWindow` reference, now ours. UI thread.
#[cfg(target_os = "android")]
unsafe extern "C" fn attach(key: u64, window: *mut c_void, _layer: *mut c_void, width: u32, height: u32, scale: f32, claim: u64) -> i64 {
    let claim = WindowClaim(claim);
    let Some(window) = std::ptr::NonNull::new(window) else { return REFUSED };
    // SAFETY (host contract): one reference, transferred to this call.
    let window = unsafe { crate::android::AndroidWindow::adopt(window) };
    attached(key, Box::new(Claimed { window, _claim: claim }), extent(width, height, scale))
}

/// iOS: `window` is the `RnrsMetalView`, `layer` its standalone `CAMetalLayer`; both are
/// retained here. Main thread only (refused elsewhere).
#[cfg(target_os = "ios")]
unsafe extern "C" fn attach(key: u64, view: *mut c_void, layer: *mut c_void, width: u32, height: u32, scale: f32, claim: u64) -> i64 {
    let claim = WindowClaim(claim);
    if !crate::ios::on_main_thread() {
        log::error!("rnrs-surface: attach called off the main thread; refused");
        return REFUSED;
    }
    let (Some(view), Some(layer)) = (std::ptr::NonNull::new(view), std::ptr::NonNull::new(layer)) else { return REFUSED };
    // SAFETY (host contract): a live view and its live Metal layer, on the main thread.
    let window = unsafe { crate::ios::IosWindow::retain(view, layer) };
    attached(key, Box::new(Claimed { window, _claim: claim }), extent(width, height, scale))
}

/// Other targets (host tests) have no platform window: refused, the claim returned.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
unsafe extern "C" fn attach(_key: u64, _window: *mut c_void, _layer: *mut c_void, _width: u32, _height: u32, _scale: f32, claim: u64) -> i64 {
    drop(WindowClaim(claim));
    REFUSED
}

/// Whether a main-thread-only entry may run here (iOS: the main thread; elsewhere always).
fn on_ui_thread(entry: &str) -> bool {
    #[cfg(target_os = "ios")]
    if !crate::ios::on_main_thread() {
        log::error!("rnrs-surface: {entry} called off the main thread; refused");
        return false;
    }
    let _ = entry;
    true
}

extern "C" fn resize(key: u64, attachment: u64, width: u32, height: u32, scale: f32) -> bool {
    on_ui_thread("resize") && crate::platform::resize(key, attachment, extent(width, height, scale))
}

/// Android's synchronous detach: false only if the timeout (at most 10 s) passed with the
/// window still leased.
extern "C" fn detach(key: u64, attachment: u64, timeout_ms: u32) -> bool {
    use crate::platform::{self, Detached};
    let timeout = std::time::Duration::from_millis(timeout_ms.min(10_000).into());
    !matches!(platform::detach(key, attachment, timeout), Detached::TimedOut { .. })
}

/// iOS's revocation without waiting: 0 released, 1 retiring, -1 stale (also off the main thread).
extern "C" fn revoke(key: u64, attachment: u64) -> i32 {
    use crate::platform::{self, Revoked};
    if !on_ui_thread("revoke") {
        return -1;
    }
    match platform::revoke_async(key, attachment) {
        Revoked::Released => 0,
        Revoked::Retiring { in_flight } => {
            log::debug!("rnrs-surface: surface {key}: revoked #{attachment}, retiring ({in_flight} operation(s) in flight)");
            1
        }
        Revoked::Stale => -1,
    }
}

/// One touch transition (touch.rs `Phase::from_code`); true if accepted.
extern "C" fn touch(key: u64, attachment: u64, phase: i32, pointer: i32, x_px: f32, y_px: f32, time_ms: i64) -> bool {
    let Some(phase) = crate::touch::Phase::from_code(phase) else { return false };
    on_ui_thread("touch") && crate::platform::touch(key, attachment, phase, pointer, x_px, y_px, time_ms)
}

extern "C" fn live_surfaces() -> u32 {
    u32::try_from(crate::platform::live_surfaces()).unwrap_or(u32::MAX)
}

/// Test support: binds this copy as the host would and records every claim release.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    pub const OWNER: u32 = 7;

    /// Per claim: the window's release counter (registered by the test), and for each release
    /// of the claim, that counter's value at the time.
    static CLAIMS: Mutex<Option<HashMap<u64, (Arc<AtomicUsize>, Vec<usize>)>>> = Mutex::new(None);
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

    extern "C" fn record(claim: u64) {
        let mut claims = CLAIMS.lock().unwrap_or_else(|e| e.into_inner());
        // Claims not made by `claimed` (host_test_targets_refuse_attach...) are not tracked.
        if let Some(entry) = claims.get_or_insert_with(HashMap::new).get_mut(&claim) {
            let window_releases = entry.0.load(Ordering::SeqCst);
            entry.1.push(window_releases);
        }
    }

    pub fn bind_for_tests() {
        assert!(bind(OWNER, record), "bound once, to the test owner");
    }

    /// `window` (whose drops `window_released` counts) with a new claim, as the host hands it.
    pub fn claimed<W: PlatformWindow>(window: W, window_released: Arc<AtomicUsize>) -> (Box<dyn PlatformWindow>, u64) {
        bind_for_tests();
        let claim = NEXT.fetch_add(1, Ordering::SeqCst);
        CLAIMS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(claim, (window_released, Vec::new()));
        (Box::new(Claimed { window, _claim: WindowClaim(claim) }), claim)
    }

    /// For each release of `claim` so far: how many times its window had been released then.
    pub fn releases(claim: u64) -> Vec<usize> {
        CLAIMS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|c| c.get(&claim)).map(|e| e.1.clone()).unwrap_or_default()
    }
}

/// The contract pinned identically by the static_asserts in packages/runtime/cpp/RnrsAbi.h.
#[cfg(test)]
mod contract {
    use super::*;
    use std::mem::{offset_of, size_of};

    #[test]
    fn surface_table_layout() {
        const P: usize = size_of::<usize>();
        assert_eq!(SURFACE_ABI, 1);
        assert_eq!((offset_of!(SurfaceTable, abi), offset_of!(SurfaceTable, size)), (0, 4), "frozen prefix");
        let slots = [
            offset_of!(SurfaceTable, bind), offset_of!(SurfaceTable, attach), offset_of!(SurfaceTable, resize),
            offset_of!(SurfaceTable, detach), offset_of!(SurfaceTable, revoke), offset_of!(SurfaceTable, touch),
            offset_of!(SurfaceTable, live_surfaces),
        ];
        for (i, offset) in slots.into_iter().enumerate() {
            assert_eq!(offset, 8 + i * P, "SurfaceTable slot {i}");
        }
        assert_eq!(size_of::<SurfaceTable>(), 8 + 7 * P);
        assert_eq!(TABLE.size as usize, size_of::<SurfaceTable>());
        // kAttachRefused, kAttachBusy; kSurfaceOwnerShift, kSurfaceOwnerLimit.
        assert_eq!((REFUSED, BUSY), (0, -1));
        assert_eq!((crate::OWNER_SHIFT, OWNER_LIMIT), (32, 1 << 21));
    }

    #[test]
    fn bind_once_and_keys_name_the_owner() {
        use super::testing::{bind_for_tests, OWNER};
        bind_for_tests();
        bind_for_tests();
        extern "C" fn other(_: u64) {}
        assert!(!bind(OWNER + 1, other), "already bound to another owner");
        assert!(!bind(0, other) && !bind(OWNER_LIMIT, other), "owner out of range");
        assert_eq!(owner(), OWNER);
        let s = crate::Surface::new().unwrap();
        assert_eq!(s.key() >> crate::OWNER_SHIFT, OWNER as u64, "the key carries the owner");
        assert!(s.key() & 0xffff_ffff > 0 && s.key() < 1 << 53);
    }

    #[test]
    fn host_test_targets_refuse_attach_and_return_the_claim() {
        // No platform window on host targets: refused, and the claim goes back (no binding
        // needed: an unbound binary has no host to return it to).
        // SAFETY: null pointers; nothing is dereferenced.
        assert_eq!(unsafe { (TABLE.attach)(1, std::ptr::null_mut(), std::ptr::null_mut(), 1, 1, 1.0, 0) }, REFUSED);
    }
}
