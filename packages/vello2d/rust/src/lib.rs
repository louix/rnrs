//! The module author's implementation of packages/vello2d/vello2d.spec.ts: a 2D renderer on
//! an rnrs-surface. TypeScript owns all state and submits whole frames ([`frame`]); this crate
//! owns only the render thread, raster context, GPU resources and the latest frame
//! ([`render`]). No JS, JSI or platform code: the window comes from rnrs-surface.
//!
//! Ownership and teardown: each renderer's [`RendererCore`] (its shared render state and its
//! surface) is registered with the runtime teardown scope of the adapter generation that
//! created the module, so an RN reload closes it even if JS or native references survive.
//! Closing (from `close()`, `Drop`, or the teardown hook) only sets flags and notifies: the
//! render thread releases the window and GPU resources itself, and its process-wide slot
//! ([`MAX_RENDER_THREADS`]) stays taken until it has exited.
//!
//! Panics abort the process (the bundle's `panic = "abort"`): a panic in this renderer or any
//! module's Rust code is fatal. Input-dependent paths return errors instead.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rnrs_core::lifecycle::{Retire, TeardownScope};
use rnrs_core::Native;
use rnrs_surface::Surface;

pub mod frame;
mod cpu;
#[cfg(not(target_arch = "wasm32"))]
mod gpu;
#[cfg(not(target_arch = "wasm32"))]
mod render;
#[cfg(target_arch = "wasm32")]
#[path = "web_render.rs"]
mod render;
mod render_state;
pub mod rnr_interface;
mod timing;

use render::Shared;
use rnr_interface as spec;

/// Render threads alive at once in the process (each with its own Vulkan device), counting
/// closed renderers still releasing their resources.
pub const MAX_RENDER_THREADS: usize = 4;

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

impl spec::Vello2DModule for Module {
    type RendererImpl = Renderer;

    fn create(&self, options: spec::RendererOptions) -> Result<Native<Renderer>, String> {
        let scale = options.resolution_scale;
        if !(0.25..=1.0).contains(&scale) {
            return Err(format!("resolutionScale must be between 0.25 and 1, got {scale}"));
        }
        let records = match options.timing_records {
            None => 0,
            Some(n) if n.fract() == 0.0 && (0.0..=timing::MAX_RECORDS as f64).contains(&n) => n as usize,
            Some(n) => return Err(format!("timingRecords must be an integer from 0 to {}, got {n}", timing::MAX_RECORDS)),
        };
        let events = timing::EventRing::new(records)?;
        let surface = Surface::new()?;
        #[cfg(not(target_arch = "wasm32"))]
        let started = render::spawn_with(&surface, gpu::WgpuPresenter::new(scale as f32), MAX_RENDER_THREADS, events);
        #[cfg(target_arch = "wasm32")]
        let started = render::spawn_with(&surface, scale as f32, events);
        let shared = match started {
            Ok(shared) => shared,
            Err(error) => { surface.close(); return Err(error); }
        };
        let core = Arc::new(RendererCore { shared, surface, closed: AtomicBool::new(false) });
        // Registered before the renderer reaches JS; after teardown this retires it at once.
        if let Some(scope) = &self.scope {
            let retire: Arc<dyn Retire> = core.clone();
            scope.register(Arc::downgrade(&retire));
        }
        Ok(Native::new(Renderer { core, owned: self.scope.is_some() }))
    }
}

/// What teardown, `close()` and `Drop` close: the render state and the surface (so an old
/// mounted view cannot attach a window to a renderer that no longer exists).
pub struct RendererCore {
    shared: Arc<Shared>,
    surface: Surface,
    closed: AtomicBool,
}

impl RendererCore {
    /// Idempotent and non-blocking: flags, revocation and notifications only.
    fn close(&self) {
        self.shared.close();
        self.surface.close();
        if !self.closed.swap(true, Ordering::SeqCst) {
            render::note_closed();
        }
    }
}

impl Retire for RendererCore {
    fn retire(&self) {
        self.close();
    }
}

/// Dropped with its last owner (JS wrapper, Worklets box, ...), possibly late and on a UI or
/// finalizer thread: dropping only closes, which never blocks.
pub struct Renderer {
    core: Arc<RendererCore>,
    owned: bool,
}

impl Drop for Renderer {
    fn drop(&mut self) {
        self.core.close();
    }
}

impl spec::Renderer for Renderer {
    fn surface_key(&self) -> Result<f64, String> {
        Ok(self.core.surface.key() as f64)
    }

    fn submit(&self, frame: Vec<u8>) -> Result<bool, String> {
        frame::check_size(frame.len())?;
        Ok(self.core.shared.submit(frame))
    }

    fn stats(&self) -> Result<spec::RendererStats, String> {
        let s = self.core.shared.stats();
        let snap = self.core.surface.snapshot();
        let closed = self.core.shared.is_closed() || snap.closed;
        let (raster_width, raster_height) = s.bound.unwrap_or((0, 0));
        let (open, threads) = render::process_counts();
        let n = |v: u64| v as f64;
        Ok(spec::RendererStats {
            state: if closed { "closed" } else if snap.attachment != 0 { "attached" } else { "detached" }.into(),
            surface_width: snap.extent.width.into(),
            surface_height: snap.extent.height.into(),
            scale: snap.extent.scale.into(),
            raster_width: raster_width.into(),
            raster_height: raster_height.into(),
            frames_submitted: n(s.frames_submitted),
            frames_presented: n(s.frames_presented),
            frames_replaced: n(s.frames_replaced),
            frames_invalid: n(s.frames_invalid),
            attaches: n(snap.counters.attaches),
            detaches: n(snap.counters.detaches),
            resizes: n(snap.counters.resizes),
            detach_timeouts: n(snap.counters.detach_timeouts),
            detach_timeouts_in_flight: n(snap.counters.detach_timeouts_in_flight),
            refused_attaches: n(snap.counters.refused_attaches),
            surface_errors: n(s.surface_errors),
            gpu_state: s.gpu.name().into(),
            device_losses: n(s.device_losses),
            surface_recreations: n(s.surface_recreations),
            recovery_attempts: n(s.recovery_attempts),
            presentation: s.presentation,
            last_raster_ms: s.last.raster_ms,
            last_upload_ms: s.last.upload_ms,
            last_acquire_ms: s.last.acquire_ms,
            last_present_ms: s.last.present_ms,
            last_submit_to_present_return_ms: s.last_submit_to_present_ms,
            device_init_ms: s.device_init_ms,
            last_error: s.last_error,
            renderers_open: open as f64,
            render_threads_alive: threads as f64,
            owned_by_runtime: self.owned,
        })
    }

    fn close(&self) -> Result<(), String> {
        self.core.close();
        Ok(())
    }

    fn drain_timings(&self) -> Result<Vec<u8>, String> {
        Ok(self.core.shared.drain_timings())
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::spec::{Renderer as _, RendererOptions, Vello2DModule as _};
    use super::*;

    fn frame_bytes() -> Vec<u8> {
        [1.0f32, 0.0].iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    #[test]
    fn create_validates_options_and_close_is_idempotent_and_contained() {
        let _s = render::tests::serial();
        let m = Module::default();
        assert!(m.scope.is_none(), "outside an adapter: unowned, and reported as such");
        assert!(m.create(RendererOptions { resolution_scale: 2.0, timing_records: None }).is_err());
        assert!(m.create(RendererOptions { resolution_scale: 1.0, timing_records: Some(1.5) }).is_err());
        let r = m.create(RendererOptions { resolution_scale: 0.5, timing_records: None }).unwrap();
        assert!(r.drain_timings().unwrap().is_empty(), "diagnostics off by default");
        let key = r.surface_key().unwrap();
        assert!((1.0..9007199254740992.0).contains(&key));
        let st = r.stats().unwrap();
        assert_eq!((st.state.as_str(), st.gpu_state.as_str(), st.owned_by_runtime), ("detached", "none", false));
        assert!(r.submit(vec![0; 3]).is_err(), "size errors are programmer errors and throw");
        assert!(r.submit(frame_bytes()).unwrap());
        r.close().unwrap();
        r.close().unwrap();
        assert!(!r.submit(frame_bytes()).unwrap(), "closed: false, never an error");
        assert_eq!(r.stats().unwrap().state, "closed");
        // Dropping on another thread (a finalizer) returns immediately.
        let other = m.create(RendererOptions { resolution_scale: 1.0, timing_records: None }).unwrap();
        let started = std::time::Instant::now();
        std::thread::spawn(move || drop(other)).join().unwrap();
        assert!(started.elapsed() < std::time::Duration::from_millis(200));
    }

    /// Runtime teardown with references retained (a JS wrapper or Worklets box that survives
    /// the reload): the scope closes the renderer and its surface; a late view cannot attach.
    #[test]
    fn teardown_closes_renderers_whose_references_survive() {
        let _s = render::tests::serial();
        let scope = TeardownScope::new();
        let m = Module { scope: Some(scope.clone()) };
        let retained = m.create(RendererOptions { resolution_scale: 1.0, timing_records: None }).unwrap();
        let key = retained.surface_key().unwrap() as u64;
        assert!(retained.stats().unwrap().owned_by_runtime);
        scope.retire_all();
        assert_eq!(retained.stats().unwrap().state, "closed");
        assert!(!retained.submit(frame_bytes()).unwrap());
        struct W;
        impl rnrs_surface::PlatformWindow for W {
            fn raw_window_handle(&self) -> Result<raw_window_handle::RawWindowHandle, raw_window_handle::HandleError> {
                Ok(raw_window_handle::RawWindowHandle::AndroidNdk(raw_window_handle::AndroidNdkWindowHandle::new(std::ptr::NonNull::<u8>::dangling().cast())))
            }
            fn raw_display_handle(&self) -> raw_window_handle::RawDisplayHandle {
                raw_window_handle::RawDisplayHandle::Android(raw_window_handle::AndroidDisplayHandle::new())
            }
            fn identity(&self) -> usize {
                0x7e57
            }
        }
        assert_eq!(rnrs_surface::platform::attach(key, Box::new(W), rnrs_surface::Extent { width: 1, height: 1, scale: 1.0 }), Err(rnrs_surface::platform::AttachError::Closed));
        // A renderer created after teardown (a create that raced it) is retired at once.
        let late = m.create(RendererOptions { resolution_scale: 1.0, timing_records: None }).unwrap();
        assert_eq!(late.stats().unwrap().state, "closed");
    }
}
