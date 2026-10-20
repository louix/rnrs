//! Browser presentation (wasm32 only): the same interface as the native render thread
//! (`render.rs`), but there is no thread. The scene is a `WebGpu` producer of rnr-surface's
//! browser host; the host's requestAnimationFrame loop calls [`Producer::render_gpu`], which runs
//! one Bevy update and blits Bevy's offscreen texture into the canvas texture. Rust owns the
//! simulation (Bevy's world); TypeScript only sets controls. No pixels cross the bridge and there
//! is no CPU copy or Canvas 2D fallback.
//!
//! Lifecycle (as the webgpu-triangle fixture, docs/surface.md "Browser presentation"):
//! - Every `bind_canvas`, `detach` and `close` advances `generation`. Setup (adapter, device,
//!   canvas configure, Bevy app) is asynchronous; after each await it continues only if its
//!   generation is still current, and otherwise destroys the device it created and counts a
//!   discarded setup. Configure and the first submit happen only for the current generation.
//! - No RefCell borrow is held across an await, and GPU state is always dropped (which destroys
//!   the device) after the borrow is released.
//! - Detach, close and runtime teardown drop the Bevy app and destroy the device at once. A new
//!   attachment builds a new device and Bevy app (pipelines compile again); the cube's angle is
//!   carried over.
//! - Failures (unsupported browser, device request, configure validation, a Bevy render error,
//!   device loss) are terminal for the attachment: the host reports them once and does not retry.
//! - Time: Bevy's clock advances by the measured frame delta, clamped to [`MAX_STEP_MS`]. Any
//!   frame that does not step (paused, a detach, a new attachment) resets the baseline. Hiding
//!   the tab detaches through the host (visibilitychange), so it resets too; when the browser
//!   only throttles or stops frames without hiding, the first frame after is clamped instead.
//!   Either way resuming does not catch up on the time spent paused or hidden.
//! - Readiness: Bevy loads its shaders asynchronously here, so the first frames show only the
//!   clear colour. `gpuState` stays "warming" (and the scene keeps stepping, even while paused,
//!   without advancing the angle) until a frame has been submitted after Bevy's cube pipeline
//!   was created; only then is it "ready". Neither is proof of display.
//!
//! The Bevy update runs on the browser's main thread inside the frame callback.
use std::cell::{Cell, RefCell};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use rnr_surface::web_producer::{self, Canvas, GpuOutcome, Pixels, Presentation, Producer, Registration};
use rnr_surface::{Extent, Surface};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use crate::scene::{BevyScene, CubePipeline, Device};
pub use crate::scene::Controls;

/// The longest step Bevy's clock takes in one frame.
const MAX_STEP_MS: f64 = 50.0;

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub gpu: &'static str,
    pub frames_rendered: u64,
    pub frames_presented: u64,
    pub presents_skipped: u64,
    pub angle: f32,
    pub input_applied: u64,
    /// No touch input in the browser: always zero.
    pub touch: crate::scene::TouchStats,
    pub touches_pressed: u64,
    pub device_init_ms: f64,
    pub first_update_ms: f64,
    pub presentation: String,
    pub last_error: Option<String>,
}

#[derive(Default)]
struct Counters {
    open: Cell<usize>,
    inits_started: Cell<u64>,
    inits_discarded: Cell<u64>,
    devices_created: Cell<u64>,
    devices_destroyed: Cell<u64>,
    gfx_alive: Cell<u64>,
}

thread_local! {
    static COUNTERS: Counters = Counters::default();
}

fn count(f: impl FnOnce(&Counters)) {
    COUNTERS.with(f);
}

fn bump(cell: &Cell<u64>) {
    cell.set(cell.get() + 1);
}

/// (open scenes, scenes holding browser GPU state). The second takes the place of the native
/// "render threads alive".
pub fn process_counts() -> (usize, usize) {
    COUNTERS.with(|c| (c.open.get(), c.gfx_alive.get() as usize))
}

pub fn note_closed() {
    count(|c| c.open.set(c.open.get().saturating_sub(1)));
}

/// Test diagnostics for the browser fixture: setups started and discarded (stale after an
/// await), devices created and destroyed, and scenes currently holding GPU state.
#[wasm_bindgen]
pub fn rnr_bevy3d_web_diagnostics() -> Vec<f64> {
    COUNTERS.with(|c| {
        vec![c.inits_started.get() as f64, c.inits_discarded.get() as f64, c.devices_created.get() as f64,
             c.devices_destroyed.get() as f64, c.gfx_alive.get() as f64, c.open.get() as f64]
    })
}

fn destroy_device(device: &wgpu::Device) {
    device.destroy();
    count(|c| bump(&c.devices_destroyed));
}

/// `GPUCanvasContext.unconfigure()` on the canvas's WebGPU context, releasing its textures before
/// the device is destroyed (wgpu has no call for it, and dropping a wgpu web surface leaves the
/// context configured). Cleanup only: never fails.
fn unconfigure(canvas: &web_sys::HtmlCanvasElement) {
    let Ok(Some(context)) = canvas.get_context("webgpu") else { return };
    if let Ok(unconfigure) = js_sys::Reflect::get(&context, &"unconfigure".into()).and_then(|f| f.dyn_into::<js_sys::Function>()) {
        let _ = unconfigure.call0(&context);
    }
}

fn now_ms() -> f64 {
    web_sys::window().and_then(|w| w.performance()).map(|p| p.now()).unwrap_or(0.0)
}

/// One attachment's GPU state. Dropping it drops the Bevy app, then destroys the device (never
/// waits).
struct Gfx {
    scene: Option<BevyScene>,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    view_format: wgpu::TextureFormat,
    blitter: wgpu::util::TextureBlitter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    /// Device loss (any time: lost-promise handlers are added, not replaced), or an uncaptured
    /// error before Bevy replaced that handler with its own.
    fault: Arc<Mutex<Option<String>>>,
    /// Bevy's cube pipeline existed after the previous update.
    pipeline_ready: bool,
    /// A frame was submitted with the cube pipeline in place.
    ready: bool,
    /// The canvas whose context `surface` configured.
    canvas: web_sys::HtmlCanvasElement,
    /// Set only when this state is installed as the current attachment's `Running` phase. The
    /// canvas context is then ours to unconfigure on drop: a newer attachment's setup (possibly
    /// on the same canvas element, e.g. after hide/show) is spawned only after this state is
    /// dropped. Never set for a stale setup, since a newer setup may already have configured the
    /// same context; that one only destroys its device.
    owns_context: bool,
}

impl Drop for Gfx {
    fn drop(&mut self) {
        self.scene = None;
        if self.owns_context {
            unconfigure(&self.canvas);
        }
        destroy_device(&self.device);
        count(|c| c.gfx_alive.set(c.gfx_alive.get().saturating_sub(1)));
    }
}

enum Phase {
    None,
    Initializing,
    Running(Box<Gfx>),
    Failed(String),
}

struct State {
    closed: bool,
    /// The attachment whose canvas is bound (0: none).
    token: u64,
    generation: u64,
    phase: Phase,
    extent: Extent,
    controls: Controls,
    controls_changed: bool,
    /// performance.now() of the last Bevy step; None resets the time baseline.
    last_step_ms: Option<f64>,
    stats: Stats,
}

pub struct Shared {
    me: Weak<Shared>,
    state: RefCell<State>,
    registration: RefCell<Option<Registration>>,
}

/// Registers the scene's producer for `surface`. Fails at `cap` open scenes.
pub fn spawn(surface: &Surface, cap: usize) -> Result<Arc<Shared>, String> {
    let open = COUNTERS.with(|c| c.open.get());
    if open >= cap {
        return Err(format!("scene limit reached: {open} of {cap} scenes open"));
    }
    let shared = Arc::new_cyclic(|me| Shared {
        me: me.clone(),
        state: RefCell::new(State {
            closed: false, token: 0, generation: 0, phase: Phase::None, extent: Extent::default(),
            controls: Controls::default(), controls_changed: false, last_step_ms: None, stats: Stats::default(),
        }),
        registration: RefCell::new(None),
    });
    let producer: Arc<dyn Producer> = shared.clone();
    // No key reaches JS until registration succeeds; the caller closes the surface otherwise.
    *shared.registration.borrow_mut() = Some(web_producer::register(surface, &producer)?);
    count(|c| c.open.set(c.open.get() + 1));
    Ok(shared)
}

impl Shared {
    pub fn stats(&self) -> Stats {
        let s = self.state.borrow();
        let mut stats = s.stats.clone();
        stats.gpu = match &s.phase {
            Phase::None => "none",
            Phase::Initializing => "initializing",
            Phase::Running(gfx) if gfx.ready => "ready",
            Phase::Running(_) => "warming",
            Phase::Failed(_) => "failed",
        };
        stats
    }

    pub fn controls(&self) -> Controls {
        self.state.borrow().controls
    }

    pub fn is_closed(&self) -> bool {
        self.state.borrow().closed
    }

    /// Applies `f` to the controls; false once closed. The next frame applies them.
    pub fn control(&self, f: impl FnOnce(&mut Controls)) -> bool {
        let mut s = self.state.borrow_mut();
        if s.closed {
            return false;
        }
        f(&mut s.controls);
        s.controls_changed = true;
        true
    }

    // Browser compatibility only; no worklet runtime is supported here.
    pub fn try_control(&self, f: impl FnOnce(&mut Controls)) -> bool {
        self.control(f)
    }

    /// Idempotent; drops the Bevy app and destroys the device now.
    pub fn close(&self) {
        let old = {
            let mut s = self.state.borrow_mut();
            if s.closed {
                return;
            }
            s.closed = true;
            s.token = 0;
            Self::reset(&mut s, Phase::None)
        };
        drop(old);
        drop(self.registration.borrow_mut().take());
    }

    /// Ends the current attachment's GPU state; the caller drops the result unborrowed.
    fn reset(s: &mut State, phase: Phase) -> Phase {
        s.generation += 1;
        s.last_step_ms = None;
        s.stats.presentation.clear();
        std::mem::replace(&mut s.phase, phase)
    }

    /// Records a terminal failure for `generation`, if it is still current.
    fn fail(&self, generation: u64, message: String) {
        let old = {
            let mut s = self.state.borrow_mut();
            if s.closed || s.generation != generation {
                return;
            }
            Self::failed(&mut s, message)
        };
        drop(old);
    }

    fn failed(s: &mut State, message: String) -> Phase {
        log::error!("rnr-bevy3d: {message}");
        s.last_step_ms = None;
        s.stats.last_error = Some(message.clone());
        s.stats.presentation.clear();
        std::mem::replace(&mut s.phase, Phase::Failed(message))
    }
}

/// The scene, if `generation` is still its current attachment; otherwise counts a discard.
fn current(weak: &Weak<Shared>, generation: u64) -> Option<Arc<Shared>> {
    let shared = weak.upgrade();
    let live = shared.as_ref().is_some_and(|shared| {
        let s = shared.state.borrow();
        !s.closed && s.generation == generation
    });
    if live {
        return shared;
    }
    count(|c| bump(&c.inits_discarded));
    None
}

fn browser_has_webgpu() -> bool {
    let Some(window) = web_sys::window() else { return false };
    js_sys::Reflect::get(&window.navigator(), &"gpu".into()).is_ok_and(|gpu| !gpu.is_undefined() && !gpu.is_null())
}

async fn setup(weak: Weak<Shared>, generation: u64, instance: wgpu::Instance, surface: wgpu::Surface<'static>, canvas: web_sys::HtmlCanvasElement) {
    let started = now_ms();
    let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions { compatible_surface: Some(&surface), ..Default::default() }).await;
    let Some(shared) = current(&weak, generation) else { return };
    let adapter = match adapter {
        Ok(adapter) => adapter,
        Err(error) => return shared.fail(generation, format!("WebGPU unsupported: no adapter ({error})")),
    };
    drop(shared);

    // wgpu's default (WebGPU baseline) limits, not everything the adapter offers: Bevy picks its
    // paths from the device limits, and with at most 4 storage textures per stage it does not
    // build its SSAO pipelines (which need 5).
    let device = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("rnr-bevy3d"),
            required_limits: wgpu::Limits::default().using_resolution(adapter.limits()),
            ..Default::default()
        })
        .await;
    if device.is_ok() {
        count(|c| bump(&c.devices_created));
    }
    let Some(shared) = current(&weak, generation) else {
        if let Ok((device, _)) = device {
            destroy_device(&device);
        }
        return;
    };
    let (device, queue) = match device {
        Ok(device) => device,
        Err(error) => return shared.fail(generation, format!("WebGPU device request failed: {error}")),
    };
    let fault = Arc::new(Mutex::new(None::<String>));
    let lost = fault.clone();
    device.set_device_lost_callback(move |reason, message| {
        if let Ok(mut fault) = lost.lock() {
            fault.get_or_insert(format!("device lost ({reason:?}): {message}"));
        }
    });
    let errors = fault.clone();
    device.on_uncaptured_error(Arc::new(move |error| {
        if let Ok(mut fault) = errors.lock() {
            fault.get_or_insert(format!("GPU error: {error}"));
        }
    }));

    let extent = shared.state.borrow().extent;
    let caps = surface.get_capabilities(&adapter);
    // Exactly the browser's preferred format (listed first), as the triangle fixture uses.
    let format = crate::canvas::preferred_canvas_format(&caps.formats);
    // configure() panics on PostMultiplied/Inherit alpha and non-FIFO present modes on the web.
    let alpha = [wgpu::CompositeAlphaMode::Opaque, wgpu::CompositeAlphaMode::PreMultiplied]
        .into_iter()
        .find(|mode| caps.alpha_modes.contains(mode));
    let config = surface.get_default_config(&adapter, extent.width, extent.height);
    let (Some(format), Some(alpha), Some(mut config)) = (format, alpha, config) else {
        destroy_device(&device);
        return shared.fail(generation, format!("canvas: preferred format (first of {:?}) is not Rgba8Unorm/Bgra8Unorm, or no Opaque/PreMultiplied alpha in {:?}", caps.formats, caps.alpha_modes));
    };
    config.format = format;
    config.view_formats = vec![];
    config.alpha_mode = alpha;
    config.present_mode = wgpu::PresentMode::Fifo;
    // Generation checked after the last await; no await since. A resize during setup only
    // recorded the extent, so configure at the current one.
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    surface.configure(&device, &config);
    let validation = scope.pop();
    drop(shared);
    let validation = validation.await;
    let Some(shared) = current(&weak, generation) else {
        destroy_device(&device);
        return;
    };
    if let Some(error) = validation {
        destroy_device(&device);
        return shared.fail(generation, format!("canvas configure {}x{} {format:?} failed validation: {error}", config.width, config.height));
    }
    let (extent, angle) = {
        let s = shared.state.borrow();
        (s.extent, s.stats.angle)
    };
    if (config.width, config.height) != (extent.width, extent.height) {
        config.width = extent.width;
        config.height = extent.height;
        surface.configure(&device, &config);
    }
    let device_ms = now_ms() - started;
    count(|c| c.gfx_alive.set(c.gfx_alive.get() + 1));
    let blitter = wgpu::util::TextureBlitterBuilder::new(&device, format).build();
    let mut gfx = Box::new(Gfx {
        scene: None, surface, config, view_format: format, blitter, device, queue, fault,
        pipeline_ready: false, ready: false, canvas, owns_context: false,
    });
    // Bevy replaces the uncaptured-error handler (onuncapturederror) with its own, so validation
    // errors then arrive through its RenderErrorHandler as an update error. A device-lost
    // callback is added to the `lost` promise rather than replaced, so ours (`fault`) still fires.
    let scene_started = now_ms();
    let scene = BevyScene::new(Device { instance: &instance, adapter: &adapter, device: &gfx.device, queue: &gfx.queue }, (extent.width, extent.height));
    let scene_ms = now_ms() - scene_started;
    let mut scene = match scene {
        Ok(scene) => scene,
        Err(error) => {
            drop(gfx);
            return shared.fail(generation, format!("Bevy setup failed: {error}"));
        }
    };
    scene.restore_angle(angle);
    gfx.scene = Some(scene);
    let old = {
        let mut s = shared.state.borrow_mut();
        if s.closed || s.generation != generation {
            None // BevyScene::new does not reenter the scene; checked anyway before installing.
        } else {
            s.stats.device_init_ms = device_ms;
            s.stats.first_update_ms = scene_ms;
            s.stats.presentation = format!("{format:?} (view {format:?}), alpha {alpha:?}, {:?}", gfx.config.present_mode);
            s.last_step_ms = None;
            gfx.owns_context = true;
            Some(std::mem::replace(&mut s.phase, Phase::Running(gfx)))
        }
    };
    match old {
        Some(old) => drop(old),
        None => count(|c| bump(&c.inits_discarded)),
    }
}

/// What one frame did.
enum Frame {
    Idle,
    Skipped,
    Submitted,
}

/// One frame for the bound attachment: reconfigure on resize, step Bevy unless paused and
/// settled, and blit into the canvas texture. An error is terminal for the attachment.
fn frame(s: &mut State, extent: Extent, redraw: bool) -> Result<Frame, String> {
    let controls = s.controls;
    let changed = std::mem::take(&mut s.controls_changed);
    let State { phase, stats, last_step_ms, controls_changed, .. } = s;
    let Phase::Running(gfx) = phase else { return Err("no GPU state".into()) };
    if let Some(fault) = gfx.fault.lock().ok().and_then(|f| f.clone()) {
        return Err(fault);
    }
    let mut step = redraw || changed || !controls.paused || !gfx.ready;
    if (gfx.config.width, gfx.config.height) != (extent.width, extent.height) {
        // Not in an error scope: after Bevy setup, a configure error reaches Bevy's replaced
        // uncaptured-error handler and fails the next update.
        gfx.config.width = extent.width;
        gfx.config.height = extent.height;
        gfx.surface.configure(&gfx.device, &gfx.config);
        gfx.scene.as_mut().ok_or("no scene")?.resize(&gfx.device, (extent.width, extent.height))?;
        step = true;
    }
    if !step {
        *last_step_ms = None;
        return Ok(Frame::Idle);
    }
    let now = now_ms();
    let delta_ms = last_step_ms.map_or(0.0, |last| (now - last).clamp(0.0, MAX_STEP_MS));
    *last_step_ms = Some(now);
    let scene = gfx.scene.as_mut().ok_or("no scene")?;
    scene.set_time_step(Duration::from_secs_f64(delta_ms / 1e3));
    let pipeline_was_ready = gfx.pipeline_ready;
    let angle = scene.update(controls)?;
    match scene.cube_pipeline() {
        CubePipeline::Failed(error) => return Err(error),
        CubePipeline::Ready => gfx.pipeline_ready = true,
        CubePipeline::Pending => {}
    }
    stats.frames_rendered += 1;
    stats.angle = angle;
    stats.input_applied = controls.rotation.map_or(0, |r| r.0);
    let texture = match gfx.surface.get_current_texture() {
        wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
        wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
            stats.presents_skipped += 1;
            *controls_changed |= changed;
            *last_step_ms = None;
            return Ok(Frame::Skipped);
        }
        wgpu::CurrentSurfaceTexture::Outdated => {
            gfx.surface.configure(&gfx.device, &gfx.config);
            stats.presents_skipped += 1;
            *controls_changed |= changed;
            *last_step_ms = None;
            return Ok(Frame::Skipped);
        }
        other => return Err(format!("canvas texture unavailable: {other:?}")),
    };
    let view = texture.texture.create_view(&wgpu::TextureViewDescriptor { format: Some(gfx.view_format), ..Default::default() });
    let mut encoder = gfx.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("rnr-bevy3d blit") });
    gfx.blitter.copy(&gfx.device, &mut encoder, scene.view(), &view);
    gfx.queue.submit([encoder.finish()]);
    gfx.queue.present(texture);
    stats.frames_presented += 1;
    if pipeline_was_ready {
        gfx.ready = true;
    }
    Ok(Frame::Submitted)
}

impl Producer for Shared {
    fn presentation(&self) -> Presentation {
        Presentation::WebGpu
    }

    fn render(&self, _: Extent, _: bool) -> Result<Option<Pixels>, String> {
        Err("the Bevy scene has no pixel output".into())
    }

    /// Before attachment and on resize: record only; the next frame reconfigures.
    fn configure(&self, extent: Extent) -> Result<(), String> {
        let mut s = self.state.borrow_mut();
        if s.closed {
            return Err("scene closed".into());
        }
        s.extent = extent;
        Ok(())
    }

    fn detach(&self) {
        let old = {
            let mut s = self.state.borrow_mut();
            s.token = 0;
            // A failure stays visible in stats until the next bind; everything else is released.
            let next = match &s.phase {
                Phase::Failed(message) => Phase::Failed(message.clone()),
                _ => Phase::None,
            };
            Self::reset(&mut s, next)
        };
        drop(old);
    }

    fn bind_canvas(&self, token: u64, canvas: &Canvas, extent: Extent) -> Result<(), String> {
        let canvas: web_sys::HtmlCanvasElement = canvas.clone().dyn_into().map_err(|_| "surface canvas is not an HTMLCanvasElement".to_string())?;
        let (generation, old) = {
            let mut s = self.state.borrow_mut();
            if s.closed {
                return Err("scene closed".into());
            }
            s.token = token;
            s.extent = extent;
            s.stats.last_error = None;
            let old = Self::reset(&mut s, Phase::Initializing);
            (s.generation, old)
        };
        drop(old);
        count(|c| bump(&c.inits_started));
        if !browser_has_webgpu() {
            self.fail(generation, "WebGPU unsupported: navigator.gpu is not available here".into());
            return Ok(());
        }
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::BROWSER_WEBGPU, ..wgpu::InstanceDescriptor::new_without_display_handle() });
        match instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone())) {
            Ok(surface) => wasm_bindgen_futures::spawn_local(setup(self.me.clone(), generation, instance, surface, canvas)),
            Err(error) => self.fail(generation, format!("WebGPU canvas context unavailable: {error}")),
        }
        Ok(())
    }

    fn render_gpu(&self, token: u64, extent: Extent, redraw: bool) -> Result<GpuOutcome, String> {
        let mut s = self.state.borrow_mut();
        if s.closed || s.token != token {
            return Ok(GpuOutcome::Failed("attachment has no bound canvas".into()));
        }
        match &s.phase {
            Phase::None => return Ok(GpuOutcome::Failed("attachment has no bound canvas".into())),
            Phase::Initializing => return Ok(GpuOutcome::Pending),
            Phase::Failed(message) => return Ok(GpuOutcome::Failed(message.clone())),
            Phase::Running(_) => {}
        }
        s.extent = extent;
        match frame(&mut s, extent, redraw) {
            Ok(Frame::Submitted) => Ok(GpuOutcome::Submitted),
            Ok(Frame::Idle | Frame::Skipped) => Ok(GpuOutcome::Unchanged),
            Err(message) => {
                let old = Self::failed(&mut s, message.clone());
                drop(s);
                drop(old);
                Ok(GpuOutcome::Failed(message))
            }
        }
    }
}
