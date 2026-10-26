//! Native wgpu backend (Android: Vulkan, iOS: Metal, host tests: Vulkan) and the public handle.
//!
//! The window is used only through admitted operations (the admission protocol in lib.rs):
//! configure, acquire and present are each admitted separately, with no lock held during the
//! GPU calls; after a revocation no acquire starts and an acquired texture is dropped
//! unpresented. On iOS the swapchain is made from the lease's `CAMetalLayer` (wgpu's UIKit path
//! needs the main thread), each configure runs in `ios::configure_in_transaction`, acquires are
//! refused unless its read-back confirmed the drawable timeout, and every render-thread step
//! runs in an autorelease pool.
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use rnrs_core::lifecycle::{Retire, TeardownScope};

use super::driver::{self, Backend, Client, Presented, RealClock, Shared};
use super::{adapter_label, describe, Frame, Gpu, Next, Options, Renderer, Status, TargetInfo};
use crate::touch::TouchRecord;
use crate::{Extent, Surface, WindowLease};

#[cfg(target_os = "ios")]
const BACKENDS: wgpu::Backends = wgpu::Backends::METAL;
#[cfg(not(target_os = "ios"))]
const BACKENDS: wgpu::Backends = wgpu::Backends::VULKAN;

/// Render threads of this adapter alive at once in the process (running or still releasing GPU
/// resources). Separate from any renderer's own threads (vello2d, bevy3d keep theirs).
pub const MAX_RENDER_THREADS: usize = 4;
static THREADS: AtomicUsize = AtomicUsize::new(0);

const ACQUIRE_REFUSED: &str = "acquire refused: the drawable timeout was not confirmed after configure";

/// The checked downlevel limits with the adapter's texture sizes and alignments: every limit
/// above the adapter's is named in one error (the iOS simulator allows fewer inter-stage
/// variables than `Limits::default()`).
fn required_limits(supported: &wgpu::Limits) -> Result<wgpu::Limits, String> {
    let requested = wgpu::Limits::downlevel_defaults().using_resolution(supported.clone()).using_alignment(supported.clone());
    let mut over = Vec::new();
    requested.check_limits_with_fail_fn(supported, false, |name, want, allowed| over.push(format!("{name} {want} > {allowed}")));
    if over.is_empty() {
        Ok(requested)
    } else {
        Err(format!("the adapter does not support the requested limits: {}", over.join(", ")))
    }
}

/// The swapchain on one attachment. **Field order is drop order**: the wgpu surface (on
/// Android also holding a lease clone as its window-handle source) before the admission lease.
pub(crate) struct Target {
    surface: wgpu::Surface<'static>,
    lease: WindowLease,
    config: wgpu::SurfaceConfiguration,
    /// Whether the last configure allows acquires (always after a successful one off iOS).
    acquire_allowed: bool,
}

pub(crate) struct WgpuBackend {
    label: &'static str,
}

impl WgpuBackend {
    /// Configures under its own admission; validation errors are returned.
    fn configure(gpu: &Gpu, target: &mut Target) -> Result<(), String> {
        let run = || {
            let scope = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
            target.surface.configure(&gpu.device, &target.config);
            match pollster::block_on(scope.pop()) {
                Some(e) => Err(format!("configure {}x{} {:?}: {e}", target.config.width, target.config.height, target.config.format)),
                None => Ok(()),
            }
        };
        let configured = {
            let Some(_admission) = target.lease.admit() else {
                target.acquire_allowed = false;
                return Err("the attachment was revoked before configure".into());
            };
            #[cfg(target_os = "ios")]
            let configured = {
                let c = crate::ios::configure_in_transaction(&target.lease, run);
                (c.result, c.acquire_allowed)
            };
            #[cfg(not(target_os = "ios"))]
            let configured = (run(), true);
            configured
        };
        let (result, allowed) = configured;
        target.acquire_allowed = allowed && result.is_ok();
        result
    }
}

impl Backend for WgpuBackend {
    type Device = Gpu;
    type Target = Target;
    type Info = TargetInfo;
    type Frame<'a> = Frame<'a>;

    #[cfg(target_os = "ios")]
    fn pool<R>(f: impl FnOnce() -> R) -> R {
        crate::ios::autoreleasepool(f)
    }

    fn create_device(&mut self) -> Result<Gpu, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: BACKENDS, ..wgpu::InstanceDescriptor::new_without_display_handle() });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).map_err(|e| format!("no {BACKENDS:?} adapter: {e}"))?;
        let required_limits = required_limits(&adapter.limits())?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some(self.label), required_limits, ..Default::default() }))
            .map_err(|e| format!("request_device: {e}"))?;
        let fault = Gpu::watch(&device, self.label);
        log::info!("{}: {}", self.label, adapter_label(&adapter.get_info()));
        Ok(Gpu { adapter, device, queue, instance, fault })
    }

    fn fault(&self, gpu: &Gpu) -> Option<(String, bool)> {
        gpu.fault().map(|f| {
            let loss = f.starts_with("device lost");
            (f, loss)
        })
    }

    fn adapter(&self, gpu: &Gpu) -> String {
        adapter_label(&gpu.adapter.get_info())
    }

    fn bind(&mut self, gpu: &Gpu, lease: WindowLease, extent: Extent) -> Result<Target, String> {
        let admission = lease.clone();
        // iOS: the window's CAMetalLayer, kept alive by `admission`, which the Target drops after
        // the surface.
        #[cfg(target_os = "ios")]
        let surface = {
            let layer = lease.metal_layer().ok_or("the window has no Metal layer")?;
            drop(lease);
            // SAFETY: a CAMetalLayer that `admission` keeps alive for the surface's lifetime.
            unsafe { gpu.instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer.as_ptr())) }.map_err(|e| format!("create_surface: {e}"))?
        };
        #[cfg(not(target_os = "ios"))]
        let surface = gpu.instance.create_surface(lease).map_err(|e| format!("create_surface: {e}"))?;
        if !gpu.adapter.is_surface_supported(&surface) {
            return Err("the adapter cannot present to this window".into());
        }
        let caps = surface.get_capabilities(&gpu.adapter);
        let format = [wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureFormat::Bgra8Unorm]
            .into_iter()
            .find(|f| caps.formats.contains(f))
            .ok_or_else(|| format!("the window offers no 8-bit non-sRGB RGBA/BGRA format: {:?}", caps.formats))?;
        let alpha_mode = if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
            wgpu::CompositeAlphaMode::Opaque
        } else {
            caps.alpha_modes.first().copied().ok_or("the window reports no alpha modes")?
        };
        let mut config = surface.get_default_config(&gpu.adapter, extent.width, extent.height).ok_or("the window is not supported by the adapter")?;
        config.format = format;
        config.view_formats = vec![];
        config.present_mode = wgpu::PresentMode::Fifo;
        config.alpha_mode = alpha_mode;
        config.desired_maximum_frame_latency = 2;
        let mut target = Target { surface, lease: admission, config, acquire_allowed: false };
        Self::configure(gpu, &mut target)?;
        log::info!("{}: bound {}x{} {}", self.label, extent.width, extent.height, describe(&target.config));
        Ok(target)
    }

    fn info(&self, target: &Target) -> TargetInfo {
        TargetInfo { format: target.config.format }
    }

    fn describe(&self, target: &Target) -> String {
        describe(&target.config)
    }

    fn resize(&mut self, gpu: &Gpu, target: &mut Target, extent: Extent) -> Result<(), String> {
        target.config.width = extent.width;
        target.config.height = extent.height;
        Self::configure(gpu, target)
    }

    fn scoped<T>(&mut self, gpu: &Gpu, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let scope = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let result = f();
        match (pollster::block_on(scope.pop()), result) {
            (Some(e), _) => Err(format!("validation error: {e}")),
            (None, result) => result,
        }
    }

    fn present(&mut self, gpu: &Gpu, target: &mut Target, extent: Extent, draw: &mut dyn FnMut(&mut Frame<'_>) -> Result<Next, String>) -> Presented {
        if let Some((error, loss)) = self.fault(gpu) {
            return Presented::Reset { error, loss };
        }
        if !target.acquire_allowed {
            return Presented::Failed(ACQUIRE_REFUSED.into());
        }
        let acquired = {
            let Some(_acquire) = target.lease.admit() else { return Presented::Revoked };
            target.surface.get_current_texture()
        };
        let texture = match acquired {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Timeout => return Presented::Skipped("acquire timed out".into()),
            wgpu::CurrentSurfaceTexture::Occluded => return Presented::Skipped("occluded".into()),
            wgpu::CurrentSurfaceTexture::Outdated => {
                return match Self::configure(gpu, target) {
                    Ok(()) => Presented::Skipped("swapchain outdated; reconfigured".into()),
                    Err(e) if e.contains("revoked") => Presented::Revoked,
                    Err(e) => Presented::Failed(e),
                }
            }
            wgpu::CurrentSurfaceTexture::Lost => return Presented::Failed("swapchain lost".into()),
            other => return Presented::Failed(format!("cannot acquire a swapchain image: {other:?}")),
        };
        // Recording: no admission and no lock held. The acquired texture, its view and the
        // encoder are locals, dropped before this returns (and so before the swapchain).
        let view = texture.texture.create_view(&wgpu::TextureViewDescriptor { format: Some(target.config.format), ..Default::default() });
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some(self.label) });
        let scope = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let drawn = draw(&mut Frame { device: &gpu.device, queue: &gpu.queue, view: &view, encoder: &mut encoder, format: target.config.format, extent });
        let commands = encoder.finish();
        drop(view);
        let next = match drawn {
            Ok(next) => next,
            Err(e) => {
                let _ = pollster::block_on(scope.pop());
                return Presented::Failed(format!("draw: {e}"));
            }
        };
        // Admitted separately: after a revocation the acquired texture is dropped unpresented.
        let Some(_present) = target.lease.admit() else {
            let _ = pollster::block_on(scope.pop());
            return Presented::Revoked;
        };
        gpu.queue.submit([commands]);
        if let Some(e) = pollster::block_on(scope.pop()) {
            return Presented::Failed(format!("validation error: {e}"));
        }
        gpu.queue.present(texture);
        Presented::Done(next)
    }
}

impl Drop for Gpu {
    /// On the render thread: waits for submitted work, so the device is released here.
    fn drop(&mut self) {
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
    }
}

/// The renderer's hooks, called by the loop with wgpu types.
struct Hooks<R>(R);

impl<R: Renderer> Client<WgpuBackend> for Hooks<R> {
    type State = R::State;
    type Resources = R::Resources;
    fn create(&mut self, gpu: &Gpu, info: &TargetInfo) -> Result<R::Resources, String> {
        self.0.create(gpu, info)
    }
    fn resized(&mut self, resources: &mut R::Resources, gpu: &Gpu, extent: Extent) -> Result<(), String> {
        self.0.resized(resources, gpu, extent)
    }
    fn draw(&mut self, resources: &mut R::Resources, frame: &mut Frame<'_>, state: &R::State) -> Result<Next, String> {
        self.0.draw(resources, frame, state)
    }
    fn touch(&mut self, records: &[TouchRecord]) {
        self.0.touch(records)
    }
}

/// What teardown, [`GpuSurface::close`] and `Drop` close.
struct Core<S> {
    shared: Arc<Shared<S>>,
    surface: Surface,
    closed: AtomicBool,
}

impl<S> Core<S> {
    /// Idempotent and non-blocking: flags, revocation and notifications only. The render thread
    /// releases everything itself.
    fn close(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            self.shared.close();
            self.surface.close();
        }
    }
}

impl<S: Send + 'static> Retire for Core<S> {
    fn retire(&self) {
        self.close();
    }
}

struct ThreadSlot;
impl Drop for ThreadSlot {
    fn drop(&mut self) {
        THREADS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A rendering surface driven by a [`Renderer`] on its own render thread. Closes when
/// dropped (never waiting); the thread releases the GPU resources and exits.
pub struct GpuSurface<R: Renderer> {
    core: Arc<Core<R::State>>,
}

impl<R: Renderer> GpuSurface<R> {
    /// Creates the surface, registers it with `scope` (the runtime teardown scope of the module
    /// that creates it: an RN reload closes it even if JS keeps a reference) and starts the
    /// render thread, which builds the renderer with `make`. Fails at once when
    /// [`MAX_RENDER_THREADS`] are alive.
    pub fn spawn(scope: &TeardownScope, options: Options, initial: R::State, make: impl FnOnce() -> R + Send + 'static) -> Result<Self, String>
    where
        R::State: Send,
    {
        if THREADS.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < MAX_RENDER_THREADS).then_some(n + 1)).is_err() {
            return Err(format!("{}: renderer limit reached ({MAX_RENDER_THREADS} render threads alive, counting closed ones still releasing GPU resources)", options.label));
        }
        let slot = ThreadSlot;
        let surface = Surface::new()?;
        if options.touch {
            surface.enable_touch();
        }
        let shared = Arc::new(Shared::new());
        let waker = Arc::downgrade(&shared);
        surface.set_waker(move || {
            if let Some(shared) = waker.upgrade() {
                shared.surface_changed();
            }
        });
        let core = Arc::new(Core { shared: shared.clone(), surface: surface.clone(), closed: AtomicBool::new(false) });
        let interval = driver::frame_interval(options.max_frame_rate);
        let label = options.label;
        let spawned = std::thread::Builder::new().name(label.into()).spawn(move || {
            let _slot = slot; // released after every GPU resource is dropped
            let hooks = WgpuBackend::pool(|| Hooks(make()));
            driver::run(&shared, &surface, WgpuBackend { label }, hooks, initial, &RealClock, interval);
        });
        if let Err(e) = spawned {
            core.close();
            return Err(format!("{label}: cannot start the render thread: {e}"));
        }
        // Registered before the key reaches JS; after teardown this retires it at once.
        let retire: Arc<dyn Retire> = core.clone();
        scope.register(Arc::downgrade(&retire));
        Ok(Self { core })
    }

    /// The opaque key for `<SurfaceView surfaceKey={...}>`.
    pub fn key(&self) -> u64 {
        self.core.surface.key()
    }

    /// Replaces the latest state and requests a redraw. A short critical section shared with
    /// the render thread (it may wait for that thread's brief take, never for rendering); the
    /// replaced value is dropped after unlocking. False once closed.
    pub fn set_state(&self, state: R::State) -> bool {
        self.core.shared.set_state(state)
    }

    pub fn status(&self) -> Status {
        let mut status = self.core.shared.status();
        status.detach_timeouts = self.core.surface.snapshot().counters.detach_timeouts;
        if self.core.closed.load(Ordering::SeqCst) || self.core.shared.exited() {
            status.state = super::SurfaceState::Closed;
        }
        status
    }

    /// Idempotent; never waits.
    pub fn close(&self) {
        self.core.close();
    }

    /// Lab only: not available natively (the browser fixture destroys its device).
    #[doc(hidden)]
    pub fn destroy_device_for_testing(&self) -> bool {
        false
    }
}

impl<R: Renderer> Drop for GpuSurface<R> {
    fn drop(&mut self) {
        self.core.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::{self, AttachError};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// The thread cap is process-wide: these tests run one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());

    struct Nothing;
    impl Renderer for Nothing {
        type State = u32;
        type Resources = ();
        fn create(&mut self, _: &Gpu, _: &TargetInfo) -> Result<(), String> {
            Ok(())
        }
        fn draw(&mut self, _: &mut (), _: &mut Frame<'_>, _: &u32) -> Result<Next, String> {
            Ok(Next::Wait)
        }
    }

    fn threads_drain() {
        let end = Instant::now() + Duration::from_secs(5);
        while THREADS.load(Ordering::SeqCst) != 0 {
            assert!(Instant::now() < end, "render threads still alive");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// No GPU is touched: without an attachment the render thread never creates a device.
    #[test]
    fn teardown_closes_surfaces_whose_handles_survive_and_threads_exit() {
        let _s = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let scope = TeardownScope::new();
        let kept = GpuSurface::<Nothing>::spawn(&scope, Options::default(), 0, || Nothing).unwrap();
        let key = kept.key();
        assert!(kept.set_state(1));
        scope.retire_all();
        assert_eq!(kept.status().state, super::super::SurfaceState::Closed);
        assert!(!kept.set_state(2), "closed: false");
        struct W;
        impl crate::PlatformWindow for W {
            fn raw_window_handle(&self) -> Result<raw_window_handle::RawWindowHandle, raw_window_handle::HandleError> {
                Err(raw_window_handle::HandleError::Unavailable)
            }
            fn raw_display_handle(&self) -> raw_window_handle::RawDisplayHandle {
                raw_window_handle::RawDisplayHandle::Android(raw_window_handle::AndroidDisplayHandle::new())
            }
        }
        assert_eq!(platform::attach(key, Box::new(W), Extent { width: 1, height: 1, scale: 1.0 }), Err(AttachError::Closed));
        threads_drain();
        // A surface created after teardown (a create racing it) is retired at once.
        let late = GpuSurface::<Nothing>::spawn(&scope, Options::default(), 0, || Nothing).unwrap();
        assert_eq!(late.status().state, super::super::SurfaceState::Closed);
        drop((kept, late));
        threads_drain();
    }

    #[test]
    fn the_thread_cap_fails_at_once_and_dropping_closes_without_waiting() {
        let _s = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let scope = TeardownScope::new();
        let open: Vec<_> = (0..MAX_RENDER_THREADS).map(|_| GpuSurface::<Nothing>::spawn(&scope, Options::default(), 0, || Nothing).unwrap()).collect();
        let err = GpuSurface::<Nothing>::spawn(&scope, Options { label: "capped", ..Options::default() }, 0, || Nothing).err().unwrap();
        assert!(err.contains("capped: renderer limit reached (4 render threads alive"), "{err}");
        let started = Instant::now();
        drop(open);
        assert!(started.elapsed() < Duration::from_millis(200), "Drop only closes");
        threads_drain();
        assert!(GpuSurface::<Nothing>::spawn(&scope, Options::default(), 0, || Nothing).is_ok(), "slots are released when threads exit");
        threads_drain();
    }

    #[test]
    fn limits_fit_the_adapter_or_name_what_is_missing() {
        let simulator = wgpu::Limits { max_inter_stage_shader_variables: 15, max_texture_dimension_2d: 16384, ..wgpu::Limits::default() };
        let ok = required_limits(&simulator).unwrap();
        assert_eq!((ok.max_inter_stage_shader_variables, ok.max_texture_dimension_2d), (15, 16384));
        let weak = wgpu::Limits { max_inter_stage_shader_variables: 8, max_bind_groups: 2, ..simulator };
        let err = required_limits(&weak).unwrap_err();
        assert!(err.contains("max_inter_stage_shader_variables 15 > 8") && err.contains("max_bind_groups 4 > 2"), "{err}");
    }
}
