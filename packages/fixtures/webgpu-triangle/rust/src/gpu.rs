//! Browser WebGPU producer for one rnr-surface. Main thread only: no waits, no polling, and no
//! RefCell borrow held across an await or across dropping GPU objects.
//!
//! Every `bind_canvas`, `detach` and `close` advances `generation`. Setup (adapter, device,
//! pipeline validation) is asynchronous; after each await it continues only if its generation
//! is still current, and otherwise drops (and destroys) what it built and counts the setup as
//! discarded. Failures are terminal for the attachment (no retries here): the host reports
//! them once, and a new attachment starts a fresh setup.
use std::cell::RefCell;
use std::sync::{Arc, Mutex, Weak};

use rnr_surface::web_producer::{self, Canvas, GpuOutcome, Pixels, Presentation, Producer, Registration};
use rnr_surface::{Extent, Surface};
use wasm_bindgen::JsCast;

use crate::spec::TriangleStats;

const SHADER: &str = r#"
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    var p = array<vec2<f32>, 3>(vec2(0.0, 0.6), vec2(-0.6, -0.6), vec2(0.6, -0.6));
    return vec4<f32>(p[i], 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.5, 0.0, 1.0); }
"#;

struct Gpu {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    config: wgpu::SurfaceConfiguration,
    /// First device loss or uncaptured error, written by wgpu callbacks (which must be Send).
    fault: Arc<Mutex<Option<String>>>,
}

impl Drop for Gpu {
    fn drop(&mut self) {
        // Release the device now rather than at garbage collection. Never waits.
        self.device.destroy();
    }
}

enum Phase {
    None,
    Initializing,
    Ready(Gpu),
    Failed(String),
}

struct State {
    closed: bool,
    /// The attachment whose canvas is bound (0: none).
    token: u64,
    generation: u64,
    phase: Phase,
    extent: Extent,
    background: wgpu::Color,
    dirty: bool,
    frames_submitted: u64,
    inits_started: u64,
    inits_discarded: u64,
    device_losses: u64,
    adapter: String,
    presentation: String,
    last_error: Option<String>,
}

pub struct Shared {
    me: Weak<Shared>,
    state: RefCell<State>,
    registration: RefCell<Option<Registration>>,
}

impl Shared {
    pub fn new(surface: &Surface) -> Result<Arc<Self>, String> {
        let shared = Arc::new_cyclic(|me| Shared {
            me: me.clone(),
            state: RefCell::new(State {
                closed: false, token: 0, generation: 0, phase: Phase::None, extent: Extent::default(),
                background: wgpu::Color::BLACK, dirty: true, frames_submitted: 0, inits_started: 0,
                inits_discarded: 0, device_losses: 0, adapter: String::new(), presentation: String::new(),
                last_error: None,
            }),
            registration: RefCell::new(None),
        });
        let producer: Arc<dyn Producer> = shared.clone();
        // No key reaches JS until registration succeeds; the caller closes the surface otherwise.
        *shared.registration.borrow_mut() = Some(web_producer::register(surface, &producer)?);
        Ok(shared)
    }

    /// Ends the current attachment's GPU state; returns it so the caller drops it unborrowed.
    fn reset(state: &mut State, phase: Phase) -> Phase {
        state.generation += 1;
        state.presentation.clear();
        std::mem::replace(&mut state.phase, phase)
    }

    pub fn close(&self) {
        let old = {
            let mut s = self.state.borrow_mut();
            if s.closed { return; }
            s.closed = true;
            s.token = 0;
            Self::reset(&mut s, Phase::None)
        };
        drop(old);
        drop(self.registration.borrow_mut().take());
    }

    pub fn set_background(&self, r: f64, g: f64, b: f64) -> Result<bool, String> {
        if ![r, g, b].iter().all(|c| (0.0..=1.0).contains(c)) {
            return Err("background components must be between 0 and 1".into());
        }
        let mut s = self.state.borrow_mut();
        if s.closed { return Ok(false); }
        s.background = wgpu::Color { r, g, b, a: 1.0 };
        s.dirty = true;
        Ok(true)
    }

    pub fn destroy_device_for_testing(&self) -> bool {
        match &self.state.borrow().phase {
            Phase::Ready(gpu) => { gpu.device.destroy(); true }
            _ => false,
        }
    }

    pub fn stats(&self, owned: bool) -> TriangleStats {
        let s = self.state.borrow();
        let attached = !s.closed && s.token != 0;
        TriangleStats {
            state: if s.closed { "closed" } else if attached { "attached" } else { "detached" }.into(),
            gpu_state: match s.phase {
                Phase::None => "none", Phase::Initializing => "initializing",
                Phase::Ready(_) => "ready", Phase::Failed(_) => "failed",
            }.into(),
            surface_width: if attached { s.extent.width as f64 } else { 0.0 },
            surface_height: if attached { s.extent.height as f64 } else { 0.0 },
            frames_submitted: s.frames_submitted as f64,
            inits_started: s.inits_started as f64,
            inits_discarded: s.inits_discarded as f64,
            device_losses: s.device_losses as f64,
            adapter: s.adapter.clone(),
            presentation: s.presentation.clone(),
            last_error: s.last_error.clone(),
            owned_by_runtime: owned,
        }
    }

    /// Records a terminal failure for `generation`, if it is still current.
    fn fail(&self, generation: u64, message: String) {
        let old = {
            let mut s = self.state.borrow_mut();
            if s.closed || s.generation != generation { return; }
            s.last_error = Some(message.clone());
            std::mem::replace(&mut s.phase, Phase::Failed(message))
        };
        drop(old);
    }
}

/// The renderer, if `generation` is still its current attachment; otherwise counts a discard.
fn current(weak: &Weak<Shared>, generation: u64) -> Option<Arc<Shared>> {
    let shared = weak.upgrade()?;
    let live = { let s = shared.state.borrow(); !s.closed && s.generation == generation };
    if live { return Some(shared); }
    shared.state.borrow_mut().inits_discarded += 1;
    None
}

fn browser_has_webgpu() -> bool {
    let Some(window) = web_sys::window() else { return false; };
    js_sys::Reflect::get(&window.navigator(), &"gpu".into()).is_ok_and(|gpu| !gpu.is_undefined() && !gpu.is_null())
}

async fn setup(weak: Weak<Shared>, generation: u64, instance: wgpu::Instance, surface: wgpu::Surface<'static>) {
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions { compatible_surface: Some(&surface), ..Default::default() })
        .await;
    let Some(shared) = current(&weak, generation) else { return; };
    let adapter = match adapter {
        Ok(adapter) => adapter,
        Err(error) => return shared.fail(generation, format!("WebGPU unsupported: no adapter ({error})")),
    };
    let info = adapter.get_info();
    shared.state.borrow_mut().adapter = format!("{}{}", if info.name.is_empty() { "unnamed" } else { &info.name },
        if info.device_type == wgpu::DeviceType::Cpu { " (fallback adapter: software)" } else { "" });
    drop(shared);

    let device = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("rnr-webgpu-triangle"),
            required_limits: wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
            ..Default::default()
        })
        .await;
    let Some(shared) = current(&weak, generation) else {
        if let Ok((device, _)) = device { device.destroy(); }
        return;
    };
    let (device, queue) = match device {
        Ok(device) => device,
        Err(error) => return shared.fail(generation, format!("WebGPU device request failed: {error}")),
    };
    let fault = Arc::new(Mutex::new(None::<String>));
    let lost = fault.clone();
    device.set_device_lost_callback(move |reason, message| {
        if let Ok(mut fault) = lost.lock() { fault.get_or_insert(format!("device lost ({reason:?}): {message}")); }
    });
    let errors = fault.clone();
    device.on_uncaptured_error(Arc::new(move |error| {
        if let Ok(mut fault) = errors.lock() { fault.get_or_insert(format!("GPU error: {error}")); }
    }));

    let extent = shared.state.borrow().extent;
    let caps = surface.get_capabilities(&adapter);
    // configure() panics on PostMultiplied/Inherit alpha and non-FIFO present modes on the web.
    let alpha = [wgpu::CompositeAlphaMode::Opaque, wgpu::CompositeAlphaMode::PreMultiplied]
        .into_iter().find(|mode| caps.alpha_modes.contains(mode));
    let config = surface.get_default_config(&adapter, extent.width, extent.height);
    let (Some(alpha), Some(mut config)) = (alpha, config) else {
        device.destroy();
        return shared.fail(generation, "canvas offers no usable format or alpha mode".into());
    };
    config.alpha_mode = alpha;
    config.present_mode = wgpu::PresentMode::Fifo;

    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None, source: wgpu::ShaderSource::Wgsl(SHADER.into()),
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("triangle"),
        layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        fragment: Some(wgpu::FragmentState {
            module: &module, entry_point: Some("fs"), compilation_options: Default::default(),
            targets: &[Some(config.format.into())],
        }),
        multiview_mask: None,
        cache: None,
    });
    let validation = scope.pop();
    drop(shared);
    let validation = validation.await;
    let Some(shared) = current(&weak, generation) else { device.destroy(); return; };
    if let Some(error) = validation {
        device.destroy();
        return shared.fail(generation, format!("triangle pipeline failed validation: {error}"));
    }
    // A resize during setup only recorded the extent; configure at the current one.
    let extent = shared.state.borrow().extent;
    config.width = extent.width;
    config.height = extent.height;
    surface.configure(&device, &config);
    let gpu = Gpu { surface, device, queue, pipeline, config, fault };
    let old = {
        let mut s = shared.state.borrow_mut();
        s.presentation = format!("{:?} {:?} {:?}", gpu.config.format, gpu.config.alpha_mode, gpu.config.present_mode);
        s.dirty = true;
        std::mem::replace(&mut s.phase, Phase::Ready(gpu))
    };
    drop(old);
}

impl Producer for Shared {
    fn presentation(&self) -> Presentation { Presentation::WebGpu }

    fn render(&self, _: Extent, _: bool) -> Result<Option<Pixels>, String> {
        Err("the WebGPU triangle has no pixel output".into())
    }

    /// Before attachment (no token yet) and on resize: record only; render reconfigures.
    fn configure(&self, extent: Extent) -> Result<(), String> {
        let mut s = self.state.borrow_mut();
        if s.closed { return Err("renderer closed".into()); }
        s.extent = extent;
        s.dirty = true;
        Ok(())
    }

    fn detach(&self) {
        let old = {
            let mut s = self.state.borrow_mut();
            s.token = 0;
            // A failure stays visible in stats until the next bind; everything else is released.
            let next = match &s.phase { Phase::Failed(message) => Phase::Failed(message.clone()), _ => Phase::None };
            Self::reset(&mut s, next)
        };
        drop(old);
    }

    fn bind_canvas(&self, token: u64, canvas: &Canvas, extent: Extent) -> Result<(), String> {
        let canvas: web_sys::HtmlCanvasElement = canvas.clone().dyn_into()
            .map_err(|_| "surface canvas is not an HTMLCanvasElement".to_string())?;
        let (generation, old) = {
            let mut s = self.state.borrow_mut();
            if s.closed { return Err("renderer closed".into()); }
            s.token = token;
            s.extent = extent;
            s.dirty = true;
            s.inits_started += 1;
            let old = Self::reset(&mut s, Phase::Initializing);
            (s.generation, old)
        };
        drop(old);
        if !browser_has_webgpu() {
            self.fail(generation, "WebGPU unsupported: navigator.gpu is not available here".into());
            return Ok(());
        }
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::BROWSER_WEBGPU,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        match instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas)) {
            Ok(surface) => wasm_bindgen_futures::spawn_local(setup(self.me.clone(), generation, instance, surface)),
            Err(error) => self.fail(generation, format!("WebGPU canvas context unavailable: {error}")),
        }
        Ok(())
    }

    fn render_gpu(&self, token: u64, extent: Extent, redraw: bool) -> Result<GpuOutcome, String> {
        let mut s = self.state.borrow_mut();
        if s.closed || s.token != token {
            return Ok(GpuOutcome::Failed("attachment has no bound canvas".into()));
        }
        let gpu = match &mut s.phase {
            Phase::None => return Ok(GpuOutcome::Failed("attachment has no bound canvas".into())),
            Phase::Initializing => return Ok(GpuOutcome::Pending),
            Phase::Failed(message) => return Ok(GpuOutcome::Failed(message.clone())),
            Phase::Ready(gpu) => gpu,
        };
        let fault = gpu.fault.lock().ok().and_then(|fault| fault.clone());
        if let Some(message) = fault {
            s.device_losses += message.starts_with("device lost") as u64;
            s.last_error = Some(message.clone());
            let old = std::mem::replace(&mut s.phase, Phase::Failed(message.clone()));
            drop(s);
            drop(old);
            return Ok(GpuOutcome::Failed(message));
        }
        let mut dirty = s.dirty || redraw;
        let background = s.background;
        s.extent = extent;
        let Phase::Ready(gpu) = &mut s.phase else { unreachable!() };
        if (gpu.config.width, gpu.config.height) != (extent.width, extent.height) {
            gpu.config.width = extent.width;
            gpu.config.height = extent.height;
            gpu.surface.configure(&gpu.device, &gpu.config);
            dirty = true;
        }
        if !dirty { return Ok(GpuOutcome::Unchanged); }
        let texture = match gpu.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture) | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => texture,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                s.dirty = true;
                return Ok(GpuOutcome::Unchanged);
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                gpu.surface.configure(&gpu.device, &gpu.config);
                s.dirty = true;
                return Ok(GpuOutcome::Unchanged);
            }
            other => {
                let message = format!("canvas texture unavailable: {other:?}");
                s.last_error = Some(message.clone());
                let old = std::mem::replace(&mut s.phase, Phase::Failed(message.clone()));
                drop(s);
                drop(old);
                return Ok(GpuOutcome::Failed(message));
            }
        };
        let view = texture.texture.create_view(&Default::default());
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("triangle"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view, depth_slice: None, resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(background), store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&gpu.pipeline);
            pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([encoder.finish()]);
        gpu.queue.present(texture);
        s.dirty = false;
        s.frames_submitted += 1;
        Ok(GpuOutcome::Submitted)
    }
}
