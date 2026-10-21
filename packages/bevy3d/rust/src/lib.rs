//! The module author's implementation of packages/bevy3d/bevy3d.spec.ts: a bounded Bevy example
//! on an rnrs-surface (Android; iOS simulator; browser WebGPU prototype). Rust owns the scene, its simulation and the render loop on one
//! render thread ([`render`]; in the browser, the host's frame callback on the main thread, see `web.rs`); TypeScript only sets latest-value controls. No JS, JSI or
//! platform code: the window comes from rnrs-surface, and Bevy never sees it ([`gpu`]).
//!
//! Ownership and teardown (as vello2d): each scene's [`SceneCore`] is registered with the
//! runtime teardown scope of the adapter generation that created the module, so an RN reload
//! closes it even if JS or native references survive. Closing only sets flags and notifies; the
//! render thread drops the window lease, the Bevy app and the device itself, and its
//! process-wide slot ([`MAX_RENDER_THREADS`]) stays taken until it has exited.
//!
//! Panics abort the process (the bundle's `panic = "abort"`), including panics inside Bevy.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rnrs_core::lifecycle::{Retire, TeardownScope};
use rnrs_core::Native;
use rnrs_surface::Surface;

#[cfg(not(target_arch = "wasm32"))]
mod gpu;
#[cfg(not(target_arch = "wasm32"))]
mod render;
/// Browser: the same interface as the native render thread, driven by the host's frame callback.
#[cfg(target_arch = "wasm32")]
#[path = "web.rs"]
mod render;
mod canvas;
pub mod rnr_interface;
mod scene;

use render::Shared;
use rnr_interface as spec;

/// Render threads alive at once in the process, each with its own GPU device and Bevy app,
/// counting closed scenes still releasing their resources. Only one at a time has been run.
pub const MAX_RENDER_THREADS: usize = 2;

/// One instance per JS runtime (adapter generation).
pub struct Module {
    /// The adapter generation's teardown scope; None only when created outside an adapter.
    scope: Option<TeardownScope>,
}

impl Default for Module {
    fn default() -> Self {
        Self { scope: TeardownScope::current() }
    }
}

impl spec::Bevy3DModule for Module {
    type SceneImpl = Scene;

    fn create(&self) -> Result<Native<Scene>, String> {
        let surface = Surface::new()?;
        // Android delivers touches only to views with touchInput="rust" (docs/bevy3d.md).
        surface.enable_touch();
        let shared = match render::spawn(&surface, MAX_RENDER_THREADS) {
            Ok(shared) => shared,
            Err(error) => {
                surface.close();
                return Err(error);
            }
        };
        let core = Arc::new(SceneCore { shared, surface, closed: AtomicBool::new(false) });
        // Registered before the scene reaches JS; after teardown this retires it at once.
        if let Some(scope) = &self.scope {
            let retire: Arc<dyn Retire> = core.clone();
            scope.register(Arc::downgrade(&retire));
        }
        Ok(Native::new(Scene { core, owned: self.scope.is_some() }))
    }
}

/// What teardown, `close()` and `Drop` close: the render state and the surface (so an old
/// mounted view cannot attach a window to a scene that no longer exists).
pub struct SceneCore {
    shared: Arc<Shared>,
    surface: Surface,
    closed: AtomicBool,
}

impl SceneCore {
    /// Idempotent and non-blocking: flags, revocation and notifications only.
    fn close(&self) {
        self.shared.close();
        self.surface.close();
        if !self.closed.swap(true, Ordering::SeqCst) {
            render::note_closed();
        }
    }
}

impl Retire for SceneCore {
    fn retire(&self) {
        self.close();
    }
}

/// Dropped with its last owner, possibly late and on a UI or finalizer thread: only closes.
pub struct Scene {
    core: Arc<SceneCore>,
    owned: bool,
}

impl Drop for Scene {
    fn drop(&mut self) {
        self.core.close();
    }
}

fn unit(name: &str, v: f64) -> Result<f32, String> {
    if (0.0..=1.0).contains(&v) {
        Ok(v as f32)
    } else {
        Err(format!("{name} must be between 0 and 1, got {v}"))
    }
}

impl spec::Scene for Scene {
    fn surface_key(&self) -> Result<f64, String> {
        Ok(self.core.surface.key() as f64)
    }

    fn set_paused(&self, paused: bool) -> Result<bool, String> {
        Ok(self.core.shared.control(|c| c.paused = paused))
    }

    fn set_color(&self, r: f64, g: f64, b: f64) -> Result<bool, String> {
        let color = [unit("r", r)?, unit("g", g)?, unit("b", b)?];
        Ok(self.core.shared.control(|c| c.color = color))
    }

    fn set_speed(&self, radians_per_second: f64) -> Result<bool, String> {
        if !(-20.0..=20.0).contains(&radians_per_second) {
            return Err(format!("radiansPerSecond must be between -20 and 20, got {radians_per_second}"));
        }
        Ok(self.core.shared.control(|c| c.speed = radians_per_second as f32))
    }

    fn set_rotation(&self, radians: f64) -> Result<bool, String> {
        if !(-1_000_000.0..=1_000_000.0).contains(&radians) {
            return Err("rotation must be finite and between -1000000 and 1000000".into());
        }
        let angle = (radians.rem_euclid(std::f64::consts::TAU) as f32).rem_euclid(std::f32::consts::TAU);
        Ok(self.core.shared.try_control(|c| {
            c.rotation = Some((c.rotation.map_or(1, |r| r.0 + 1), angle));
        }))
    }

    fn stats(&self) -> Result<spec::SceneStats, String> {
        let s = self.core.shared.stats();
        let (queue, _) = self.core.surface.touch_counters();
        let controls = self.core.shared.controls();
        let snap = self.core.surface.snapshot();
        let closed = self.core.shared.is_closed() || snap.closed;
        let (open, threads) = render::process_counts();
        let n = |v: u64| v as f64;
        Ok(spec::SceneStats {
            state: if closed { "closed" } else if snap.attachment != 0 { "attached" } else { "detached" }.into(),
            surface_width: snap.extent.width.into(),
            surface_height: snap.extent.height.into(),
            gpu_state: s.gpu.into(),
            frames_rendered: n(s.frames_rendered),
            frames_presented: n(s.frames_presented),
            presents_skipped: n(s.presents_skipped),
            attaches: n(snap.counters.attaches),
            detaches: n(snap.counters.detaches),
            detach_timeouts: n(snap.counters.detach_timeouts),
            angle: s.angle.into(),
            paused: controls.paused,
            input_received: n(controls.rotation.map_or(0, |r| r.0)),
            input_applied: n(s.input_applied),
            touches_started: n(s.touch.started),
            touches_ended: n(s.touch.ended),
            touches_canceled: n(s.touch.canceled),
            touch_resets: n(s.touch.resets),
            touches_active: n(s.touch.active),
            touches_pressed: n(s.touches_pressed),
            last_touch_x: s.touch.last_x.into(),
            last_touch_y: s.touch.last_y.into(),
            touch_accepted: n(queue.accepted),
            touch_coalesced: n(queue.coalesced),
            touch_overflows: n(queue.overflows),
            touch_refused: n(queue.refused_stale + queue.refused_capacity),
            touch_dropped: n(queue.dropped),
            device_init_ms: s.device_init_ms,
            first_update_ms: s.first_update_ms,
            presentation: s.presentation,
            last_error: s.last_error,
            scenes_open: open as f64,
            render_threads_alive: threads as f64,
            owned_by_runtime: self.owned,
        })
    }

    fn close(&self) -> Result<(), String> {
        self.core.close();
        Ok(())
    }
}

/// android-activity (pulled in by bevy_asset → bevy_android) is built with `native-activity`
/// only so that it compiles; its `ANativeActivity_onCreate` export references this symbol.
/// Nothing calls it: Android invokes that export only for a `NativeActivity` declared in the
/// manifest, and the React Native app has none. Reaching it is a bug, so it aborts loudly.
#[cfg(target_os = "android")]
#[no_mangle]
fn android_main(_app: android_activity::AndroidApp) {
    log::error!("rnr-bevy3d: android_main was invoked; this module does not own an Android activity");
    std::process::abort();
}

/// Tests that create scenes share the process-wide render-thread cap: run them one at a time,
/// each after earlier scenes' threads have exited (bounded wait).
#[cfg(test)]
pub(crate) fn exclusive_scenes() -> std::sync::MutexGuard<'static, ()> {
    static SCENES: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let guard = SCENES.lock().unwrap_or_else(|e| e.into_inner());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while render::process_counts().1 != 0 {
        assert!(std::time::Instant::now() < deadline, "earlier scenes' render threads did not exit within 5 s");
        std::thread::yield_now();
    }
    guard
}

#[cfg(test)]
mod tests {
    use super::spec::{Bevy3DModule as _, Scene as _};
    use super::*;

    /// No GPU is touched: a scene that never attaches only parks its render thread.
    #[test]
    fn controls_validate_and_close_is_idempotent_and_contained() {
        let _scenes = exclusive_scenes();
        let m = Module::default();
        assert!(m.scope.is_none());
        let s = m.create().unwrap();
        assert!((1.0..9007199254740992.0).contains(&s.surface_key().unwrap()));
        assert!(s.set_color(2.0, 0.0, 0.0).is_err());
        assert!(s.set_speed(100.0).is_err());
        assert!(s.set_paused(true).unwrap());
        assert!(s.stats().unwrap().paused);
        let st = s.stats().unwrap();
        assert_eq!((st.state.as_str(), st.gpu_state.as_str(), st.owned_by_runtime), ("detached", "none", false));
        s.close().unwrap();
        s.close().unwrap();
        assert!(!s.set_speed(1.0).unwrap(), "closed: false, never an error");
        assert_eq!(s.stats().unwrap().state, "closed");
    }

    #[test]
    fn teardown_closes_scenes_whose_references_survive() {
        let _scenes = exclusive_scenes();
        let scope = TeardownScope::new();
        let m = Module { scope: Some(scope.clone()) };
        let retained = m.create().unwrap();
        assert!(retained.stats().unwrap().owned_by_runtime);
        scope.retire_all();
        assert_eq!(retained.stats().unwrap().state, "closed");
        assert!(!retained.set_paused(false).unwrap());
    }
}

#[cfg(test)]
mod input_tests {
    use super::*;
    use spec::{Bevy3DModule as _, Scene as _};

    #[test]
    fn rotation_is_finite_wrapped_latest_and_refused_after_close() {
        let _scenes = exclusive_scenes();
        let scene = Module::default().create().unwrap();
        for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 1_000_001.0] {
            assert!(scene.set_rotation(invalid).is_err());
        }
        // A render-thread inbox snapshot can briefly contend; retry only in this test.
        for i in 1..=100 {
            while !scene.set_rotation(-(i as f64)).unwrap() { std::thread::yield_now(); }
        }
        let controls = scene.core.shared.controls();
        let (sequence, angle) = controls.rotation.unwrap();
        assert_eq!(sequence, 100);
        assert!((0.0..std::f32::consts::TAU).contains(&angle));
        assert_eq!(scene.stats().unwrap().input_received, 100.0);
        assert_eq!(scene.stats().unwrap().input_applied, 0.0); // detached, no GPU
        scene.close().unwrap();
        assert!(!scene.set_rotation(0.5).unwrap());
        assert_eq!(scene.stats().unwrap().input_received, 100.0);
    }
}
