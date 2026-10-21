//! Browser backend: a WebGPU [`Producer`] (web_producer.rs) driven by the host's
//! `requestAnimationFrame` on the main thread. WebGPU only: no WebGL, no Canvas 2D fallback, no
//! forced fallback adapter; a missing `navigator.gpu` or adapter is a terminal, reported failure
//! for the attachment.
//!
//! Main thread only, with no waits and no RefCell borrow held across an await or across a
//! renderer hook that could reach this producer again:
//! - The renderer, its state and its resources live in `gfx`; every hook runs inside one
//!   `try_borrow_mut` of it, and a reentrant host call that finds it busy changes nothing (a
//!   render reports `Unchanged`; a detach or close is applied when the hook returns).
//! - [`GpuSurface::set_state`] touches only `pending` (borrowed just to replace the value), so
//!   a hook may call it.
//! - Setup (adapter, device, swapchain, [`Renderer::create`]) is asynchronous and generation
//!   checked: every `bind_canvas`, `detach` and `close` advances `generation`; after each await
//!   setup continues only if its generation is current and otherwise drops what it built and
//!   counts the setup as discarded. `create` and `resized` run in one synchronous scope with the
//!   renderer taken out of `gfx` (so no borrow is held while they run, and a close from them applies
//!   at once); it is back before any await, so an overlapping setup (a detach and re-attach) never
//!   finds it missing. The resources wait in the setup's own frame across the validation await and
//!   are installed only if the generation is still current; touches stay queued meanwhile.
//! - Validation errors of `create` and `resized` come from an error scope; those of `draw`
//!   arrive through the device's uncaptured-error handler and fail the attachment at the next
//!   frame.
use std::cell::{Cell, RefCell};
use std::sync::{Arc, Weak};

use rnr_core::lifecycle::{Retire, TeardownScope};
use wasm_bindgen::JsCast;

use super::{adapter_label, describe, Frame, Gpu, GpuState, Next, Options, Renderer, Status, SurfaceState, TargetInfo};
use crate::touch::TouchRecord;
use crate::web_producer::{self, Canvas, GpuOutcome, Pixels, Presentation, Producer, Registration};
use crate::{Extent, Surface};

impl Drop for Gpu {
    /// Releases the device now rather than at garbage collection. Never waits.
    fn drop(&mut self) {
        self.device.destroy();
    }
}

/// The browser's preferred canvas format (wgpu lists it first), if it is 8-bit non-sRGB RGBA or
/// BGRA; no other format is tried (a browser may present only its preferred one efficiently).
pub(crate) fn preferred_canvas_format(formats: &[wgpu::TextureFormat]) -> Option<wgpu::TextureFormat> {
    formats.first().copied().filter(|f| matches!(f, wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Bgra8Unorm))
}

/// One attachment's GPU objects. **Field order is drop order**: the renderer's resources, then
/// the canvas swapchain, then the device.
struct Ready<R: Renderer> {
    resources: R::Resources,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    gpu: Gpu,
}

enum Phase<R: Renderer> {
    None,
    Initializing,
    Ready(Ready<R>),
    Failed(String),
}

struct Gfx<R: Renderer> {
    /// None only while setup validates the renderer's resources (an await).
    renderer: Option<R>,
    state: R::State,
    phase: Phase<R>,
    extent: Extent,
    dirty: bool,
    animate: bool,
}

struct Core<R: Renderer> {
    me: Weak<Core<R>>,
    surface: Surface,
    label: &'static str,
    closed: Cell<bool>,
    /// The attachment whose canvas is bound (0: none), and the setup generation.
    token: Cell<u64>,
    generation: Cell<u64>,
    /// A detach or close that found `gfx` busy (a reentrant host call), applied afterwards.
    deferred_reset: Cell<bool>,
    pending: RefCell<Option<R::State>>,
    gfx: RefCell<Gfx<R>>,
    status: RefCell<Status>,
    registration: RefCell<Option<Registration>>,
    touches: RefCell<Vec<TouchRecord>>,
}

impl<R: Renderer> Core<R> {
    fn update(&self, f: impl FnOnce(&mut Status)) {
        f(&mut self.status.borrow_mut());
    }

    /// Ends the current attachment's GPU state (keeping a failure visible until the next bind).
    /// Drops what it held after releasing the borrow; deferred if `gfx` is busy.
    fn reset(&self) {
        self.generation.set(self.generation.get() + 1);
        let Ok(mut gfx) = self.gfx.try_borrow_mut() else {
            self.deferred_reset.set(true);
            return;
        };
        let next = match &gfx.phase {
            Phase::Failed(message) => Phase::Failed(message.clone()),
            _ => Phase::None,
        };
        let old = std::mem::replace(&mut gfx.phase, next);
        drop(gfx);
        drop(old);
        self.update(|s| {
            s.presentation.clear();
            if s.gpu != GpuState::Failed {
                s.gpu = GpuState::None;
            }
        });
    }

    fn apply_deferred(&self) {
        if self.deferred_reset.replace(false) {
            self.reset();
        }
    }

    fn close(&self) {
        if self.closed.replace(true) {
            return;
        }
        self.token.set(0);
        self.reset();
        drop(self.registration.borrow_mut().take());
        self.surface.close();
        self.update(|s| {
            s.state = SurfaceState::Closed;
            s.gpu = GpuState::None;
            (s.width, s.height) = (0, 0);
        });
    }

    /// Records a terminal failure for `generation`, if it is still current.
    fn fail(&self, generation: u64, message: String) {
        if self.closed.get() || self.generation.get() != generation {
            return;
        }
        log::error!("{}: {message}", self.label);
        let old = match self.gfx.try_borrow_mut() {
            Ok(mut gfx) => std::mem::replace(&mut gfx.phase, Phase::Failed(message.clone())),
            Err(_) => return self.deferred_reset.set(true),
        };
        drop(old);
        self.update(|s| {
            s.gpu = GpuState::Failed;
            s.presentation.clear();
            s.last_error = Some(message);
        });
    }

    /// This producer, if `generation` is still its current setup; otherwise counts a discard.
    fn current(weak: &Weak<Core<R>>, generation: u64) -> Option<Arc<Core<R>>> {
        let core = weak.upgrade()?;
        if !core.closed.get() && core.generation.get() == generation {
            return Some(core);
        }
        core.update(|s| s.setups_discarded += 1);
        None
    }
}

fn browser_has_webgpu() -> bool {
    let Some(window) = web_sys::window() else { return false };
    js_sys::Reflect::get(&window.navigator(), &"gpu".into()).is_ok_and(|gpu| !gpu.is_undefined() && !gpu.is_null())
}

async fn setup<R: Renderer>(weak: Weak<Core<R>>, generation: u64, instance: wgpu::Instance, surface: wgpu::Surface<'static>) {
    let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions { compatible_surface: Some(&surface), ..Default::default() }).await;
    let Some(core) = Core::current(&weak, generation) else { return };
    let adapter = match adapter {
        Ok(adapter) => adapter,
        Err(error) => return core.fail(generation, format!("WebGPU unsupported: no adapter ({error})")),
    };
    core.update(|s| s.adapter = adapter_label(&adapter.get_info()));
    let label = core.label;
    drop(core);
    let device = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some(label),
            required_limits: wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
            ..Default::default()
        })
        .await;
    let Some(core) = Core::current(&weak, generation) else {
        if let Ok((device, _)) = device {
            device.destroy();
        }
        return;
    };
    let (device, queue) = match device {
        Ok(device) => device,
        Err(error) => return core.fail(generation, format!("WebGPU device request failed: {error}")),
    };
    let fault = Gpu::watch(&device, label);
    let gpu = Gpu { adapter, device, queue, instance, fault };
    let caps = surface.get_capabilities(&gpu.adapter);
    // configure() panics on PostMultiplied/Inherit alpha and non-FIFO present modes on the web.
    let alpha = [wgpu::CompositeAlphaMode::Opaque, wgpu::CompositeAlphaMode::PreMultiplied].into_iter().find(|m| caps.alpha_modes.contains(m));
    let format = preferred_canvas_format(&caps.formats);
    let extent = core.gfx.borrow().extent;
    let config = surface.get_default_config(&gpu.adapter, extent.width, extent.height);
    let (Some(alpha), Some(format), Some(mut config)) = (alpha, format, config) else {
        return core.fail(generation, format!("the canvas offers no usable format or alpha mode: {:?}", caps.formats));
    };
    config.format = format;
    config.view_formats = vec![];
    config.alpha_mode = alpha;
    config.present_mode = wgpu::PresentMode::Fifo;
    surface.configure(&gpu.device, &config);
    // The renderer's resources. The renderer leaves `gfx` only for this synchronous hook scope (no
    // gfx borrow is held while user code runs, so a hook may call set_state or close) and is
    // back before any await; the resources are held here across the validation await.
    let Some(mut renderer) = core.gfx.borrow_mut().renderer.take() else {
        return core.fail(generation, "the renderer is in use by a hook (a reentrant setup)".into());
    };
    let scope = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
    let created = renderer.create(&gpu, &TargetInfo { format }).and_then(|mut r| renderer.resized(&mut r, &gpu, extent).map(|()| r));
    let validation = scope.pop();
    core.gfx.borrow_mut().renderer = Some(renderer);
    // A hook (or anything else meanwhile) that closed or replaced the attachment: nothing is installed.
    if core.closed.get() || core.generation.get() != generation {
        core.update(|s| s.setups_discarded += 1);
        // In the documented order: resources, then the canvas swapchain, then the device.
        drop(created);
        drop(surface);
        drop(gpu);
        return;
    }
    drop(core);
    // Lab only (feature lab-hooks, rnr_surface_hold_gpu_setups_for_testing): a deterministic point for setups to interleave.
    super::super::web_exports::setup_gate().await;
    let validation = validation.await;
    let Some(core) = Core::current(&weak, generation) else {
        // Stale or closed: drop what was built (resources before swapchain before device).
        drop(created);
        drop(surface);
        drop(gpu);
        return;
    };
    let resources = match (validation, created) {
        (Some(error), _) => return core.fail(generation, format!("validation error in create: {error}")),
        (None, Err(error)) => return core.fail(generation, error),
        (None, Ok(resources)) => resources,
    };
    // A resize during setup only recorded the extent; configure at the current one.
    let extent = core.gfx.borrow().extent;
    if (config.width, config.height) != (extent.width, extent.height) {
        config.width = extent.width;
        config.height = extent.height;
        surface.configure(&gpu.device, &config);
    }
    let presentation = describe(&config);
    let ready = Ready { resources, surface, config, gpu };
    let old = {
        let mut gfx = core.gfx.borrow_mut();
        gfx.dirty = true;
        std::mem::replace(&mut gfx.phase, Phase::Ready(ready))
    };
    drop(old);
    core.update(|s| {
        s.gpu = GpuState::Ready;
        s.presentation = presentation;
    });
}

impl<R: Renderer> Producer for Core<R> {
    fn presentation(&self) -> Presentation {
        Presentation::WebGpu
    }

    fn render(&self, _: Extent, _: bool) -> Result<Option<Pixels>, String> {
        Err("a GPU surface has no pixel output".into())
    }

    /// Before attachment (no token yet) and on resize: record only; render reconfigures.
    fn configure(&self, extent: Extent) -> Result<(), String> {
        if self.closed.get() {
            return Err("renderer closed".into());
        }
        if let Ok(mut gfx) = self.gfx.try_borrow_mut() {
            gfx.extent = extent;
            gfx.dirty = true;
        }
        self.update(|s| (s.width, s.height) = (extent.width, extent.height));
        Ok(())
    }

    fn detach(&self) {
        self.token.set(0);
        self.reset();
        self.update(|s| {
            s.state = SurfaceState::Detached;
            (s.width, s.height) = (0, 0);
        });
    }

    fn bind_canvas(&self, token: u64, canvas: &Canvas, extent: Extent) -> Result<(), String> {
        let canvas: web_sys::HtmlCanvasElement = canvas.clone().dyn_into().map_err(|_| "surface canvas is not an HTMLCanvasElement".to_string())?;
        if self.closed.get() {
            return Err("renderer closed".into());
        }
        self.token.set(token);
        self.reset(); // a new attachment: new resources
        let generation = self.generation.get();
        {
            let mut gfx = self.gfx.try_borrow_mut().map_err(|_| "renderer busy".to_string())?;
            gfx.extent = extent;
            gfx.dirty = true;
            gfx.animate = false;
            gfx.phase = Phase::Initializing;
        }
        self.update(|s| {
            s.state = SurfaceState::Attached;
            s.gpu = GpuState::Initializing;
            (s.width, s.height) = (extent.width, extent.height);
            s.setups_started += 1;
        });
        if !browser_has_webgpu() {
            self.fail(generation, "WebGPU unsupported: navigator.gpu is not available here".into());
            return Ok(());
        }
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::BROWSER_WEBGPU, ..wgpu::InstanceDescriptor::new_without_display_handle() });
        match instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas)) {
            Ok(surface) => wasm_bindgen_futures::spawn_local(setup(self.me.clone(), generation, instance, surface)),
            Err(error) => self.fail(generation, format!("WebGPU canvas context unavailable: {error}")),
        }
        Ok(())
    }

    fn render_gpu(&self, token: u64, extent: Extent, redraw: bool) -> Result<GpuOutcome, String> {
        if self.closed.get() || self.token.get() != token {
            return Ok(GpuOutcome::Failed("attachment has no bound canvas".into()));
        }
        let outcome = self.frame(extent, redraw);
        self.apply_deferred();
        Ok(outcome)
    }
}

impl<R: Renderer> Core<R> {
    /// One host frame: latest state, touch, then (if anything changed or the renderer animates)
    /// one draw. All hooks run inside the one `gfx` borrow.
    fn frame(&self, extent: Extent, redraw: bool) -> GpuOutcome {
        let Ok(mut gfx) = self.gfx.try_borrow_mut() else { return GpuOutcome::Unchanged };
        let gfx = &mut *gfx;
        let latest = self.pending.borrow_mut().take();
        if let Some(state) = latest {
            gfx.state = state;
            gfx.dirty = true;
        }
        // Touch only while the renderer is here: records stay queued otherwise, never dropped.
        if let Some(renderer) = gfx.renderer.as_mut() {
            let mut touches = self.touches.borrow_mut();
            self.surface.drain_touch(&mut touches);
            if !touches.is_empty() {
                renderer.touch(&touches);
            }
        }
        let ready = match &mut gfx.phase {
            Phase::None => return GpuOutcome::Failed("attachment has no bound canvas".into()),
            Phase::Initializing => return GpuOutcome::Pending,
            Phase::Failed(message) => return GpuOutcome::Failed(message.clone()),
            Phase::Ready(ready) => ready,
        };
        let generation = self.generation.get();
        let terminal = |gfx: &mut Gfx<R>, message: String, loss: bool| {
            let old = std::mem::replace(&mut gfx.phase, Phase::Failed(message.clone()));
            drop(old);
            log::error!("{}: {message}", self.label);
            self.update(|s| {
                s.gpu = GpuState::Failed;
                s.presentation.clear();
                s.device_losses += loss as u64;
                s.last_error = Some(message.clone());
            });
            GpuOutcome::Failed(message)
        };
        if let Some(fault) = ready.gpu.fault() {
            let loss = fault.starts_with("device lost");
            return terminal(gfx, fault, loss);
        }
        let Some(renderer) = gfx.renderer.as_mut() else { return GpuOutcome::Pending };
        gfx.extent = extent;
        if (ready.config.width, ready.config.height) != (extent.width, extent.height) {
            ready.config.width = extent.width;
            ready.config.height = extent.height;
            ready.surface.configure(&ready.gpu.device, &ready.config);
            if let Err(error) = renderer.resized(&mut ready.resources, &ready.gpu, extent) {
                return terminal(gfx, error, false);
            }
            gfx.dirty = true;
        }
        if !(gfx.dirty || redraw || gfx.animate) {
            return GpuOutcome::Unchanged;
        }
        let texture = match ready.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                gfx.dirty = true;
                self.update(|s| s.presents_skipped += 1);
                return GpuOutcome::Unchanged;
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                ready.surface.configure(&ready.gpu.device, &ready.config);
                gfx.dirty = true;
                self.update(|s| s.presents_skipped += 1);
                return GpuOutcome::Unchanged;
            }
            other => return terminal(gfx, format!("canvas texture unavailable: {other:?}"), false),
        };
        let view = texture.texture.create_view(&wgpu::TextureViewDescriptor { format: Some(ready.config.format), ..Default::default() });
        let mut encoder = ready.gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some(self.label) });
        let drawn = renderer.draw(
            &mut ready.resources,
            &mut Frame { device: &ready.gpu.device, queue: &ready.gpu.queue, view: &view, encoder: &mut encoder, format: ready.config.format, extent },
            &gfx.state,
        );
        let next = match drawn {
            Ok(next) => next,
            Err(error) => return terminal(gfx, format!("draw: {error}"), false),
        };
        // A hook that closed or replaced the attachment: nothing is submitted for it.
        if self.closed.get() || self.generation.get() != generation {
            return GpuOutcome::Unchanged;
        }
        ready.gpu.queue.submit([encoder.finish()]);
        drop(view);
        ready.gpu.queue.present(texture);
        gfx.dirty = false;
        gfx.animate = next == Next::Animate;
        self.update(|s| s.frames_presented += 1);
        GpuOutcome::Submitted
    }
}

impl<R: Renderer> Retire for Core<R> {
    fn retire(&self) {
        self.close();
    }
}

/// A rendering surface driven by a [`Renderer`] on the browser's main thread. Closes when
/// dropped (never waiting).
pub struct GpuSurface<R: Renderer> {
    core: Arc<Core<R>>,
}

impl<R: Renderer> GpuSurface<R> {
    /// Creates the surface, registers its producer and registers it with `scope` (the runtime
    /// teardown scope of the module that creates it). `make` builds the renderer now.
    pub fn spawn(scope: &TeardownScope, options: Options, initial: R::State, make: impl FnOnce() -> R + 'static) -> Result<Self, String> {
        let surface = Surface::new()?;
        if options.touch {
            surface.enable_touch();
        }
        let core = Arc::new_cyclic(|me| Core {
            me: me.clone(),
            surface: surface.clone(),
            label: options.label,
            closed: Cell::new(false),
            token: Cell::new(0),
            generation: Cell::new(0),
            deferred_reset: Cell::new(false),
            pending: RefCell::new(None),
            gfx: RefCell::new(Gfx { renderer: Some(make()), state: initial, phase: Phase::None, extent: Extent::default(), dirty: true, animate: false }),
            status: RefCell::new(Status::default()),
            registration: RefCell::new(None),
            touches: RefCell::new(Vec::new()),
        });
        let producer: Arc<dyn Producer> = core.clone();
        match web_producer::register(&surface, &producer) {
            Ok(registration) => *core.registration.borrow_mut() = Some(registration),
            Err(error) => {
                surface.close();
                return Err(error);
            }
        }
        let retire: Arc<dyn Retire> = core.clone();
        scope.register(Arc::downgrade(&retire));
        Ok(Self { core })
    }

    pub fn key(&self) -> u64 {
        self.core.surface.key()
    }

    /// Replaces the latest state and requests a redraw; the replaced value is dropped after the
    /// slot is released. Callable from a hook. False once closed.
    pub fn set_state(&self, state: R::State) -> bool {
        if self.core.closed.get() {
            return false;
        }
        let old = self.core.pending.borrow_mut().replace(state);
        drop(old);
        true
    }

    pub fn status(&self) -> Status {
        self.core.status.borrow().clone()
    }

    pub fn close(&self) {
        self.core.close();
    }

    /// Lab only: destroys the current device, which the browser reports as a device loss.
    #[doc(hidden)]
    pub fn destroy_device_for_testing(&self) -> bool {
        match self.core.gfx.try_borrow().as_deref().map(|g| &g.phase) {
            Ok(Phase::Ready(ready)) => {
                ready.gpu.device.destroy();
                true
            }
            _ => false,
        }
    }
}

impl<R: Renderer> Drop for GpuSurface<R> {
    fn drop(&mut self) {
        self.core.close();
    }
}
