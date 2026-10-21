//! Lab fixture for the rnrs wgpu adapter: one triangle on Android (Vulkan), iOS (Metal) and the
//! browser (WebGPU). The renderer is only the pipeline and the draw; the surface, the render
//! loop, the swapchain, the lease, teardown and failure handling are `rnrs::gpu`'s.
use std::sync::{Arc, Mutex, Weak};

use rnrs::gpu::{self, wgpu, Frame, Gpu, GpuSurface, Next, Options, TargetInfo};
use rnrs::{Native, TeardownScope};

pub mod rnr_interface;
use rnr_interface as spec;

const SHADER: &str = r#"
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    var p = array<vec2<f32>, 3>(vec2(0.0, 0.6), vec2(-0.6, -0.6), vec2(0.6, -0.6));
    return vec4<f32>(p[i], 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.5, 0.0, 1.0); }
"#;

/// The renderer: an orange triangle on the latest background colour.
struct Draw {
    probe: Arc<Mutex<Probe>>,
}

/// Lab only: one armed hook calls back into its own surface (armHookProbeForTesting).
#[derive(Default)]
struct Probe {
    armed: Option<&'static str>,
    surface: Option<Weak<GpuSurface<Draw>>>,
    log: Vec<String>,
}

impl Draw {
    /// The surface, if `hook` is armed (disarming it). The probe lock is not held afterwards.
    fn armed(&self, hook: &str) -> Option<Arc<GpuSurface<Draw>>> {
        let mut p = self.probe.lock().unwrap_or_else(|e| e.into_inner());
        if p.armed != Some(hook) {
            return None;
        }
        p.armed = None;
        p.surface.as_ref().and_then(Weak::upgrade)
    }

    fn note(&self, line: String) {
        self.probe.lock().unwrap_or_else(|e| e.into_inner()).log.push(line);
    }
}

impl gpu::Renderer for Draw {
    type State = wgpu::Color;
    type Resources = wgpu::RenderPipeline;

    fn create(&mut self, gpu: &Gpu, target: &TargetInfo) -> Result<wgpu::RenderPipeline, String> {
        if let Some(surface) = self.armed("create") {
            let accepted = surface.set_state(wgpu::Color { r: 0.0, g: 0.5, b: 1.0, a: 1.0 });
            self.note(format!("create: set_state={accepted}"));
        }
        let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("triangle"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
        Ok(gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("triangle"),
            layout: None,
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), compilation_options: Default::default(), targets: &[Some(target.format.into())] }),
            multiview_mask: None,
            cache: None,
        }))
    }

    fn draw(&mut self, pipeline: &mut wgpu::RenderPipeline, frame: &mut Frame<'_>, background: &wgpu::Color) -> Result<Next, String> {
        let mut pass = frame.encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("triangle"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: frame.view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(*background), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        pass.draw(0..3, 0..1);
        drop(pass);
        if let Some(surface) = self.armed("draw") {
            let accepted = surface.set_state(wgpu::Color { r: 0.2, g: 0.2, b: 0.2, a: 1.0 });
            surface.close();
            self.note(format!("draw: set_state={accepted}, closed"));
        }
        Ok(Next::Wait)
    }
}

/// One instance per JS runtime (adapter generation).
pub struct Module {
    scope: Option<TeardownScope>,
}

impl Default for Module {
    fn default() -> Self {
        Self { scope: TeardownScope::current() }
    }
}

impl spec::WebgpuTriangleModule for Module {
    type TriangleImpl = Triangle;

    fn create(&self) -> Result<Native<Triangle>, String> {
        let scope = self.scope.as_ref().ok_or("the triangle module was created outside a runtime adapter")?;
        let options = Options { label: "rnr-webgpu-triangle", ..Options::default() };
        let probe = Arc::new(Mutex::new(Probe::default()));
        let renderer_probe = probe.clone();
        let surface = Arc::new(GpuSurface::spawn(scope, options, wgpu::Color::BLACK, move || Draw { probe: renderer_probe })?);
        probe.lock().unwrap_or_else(|e| e.into_inner()).surface = Some(Arc::downgrade(&surface));
        Ok(Native::new(Triangle(surface, probe)))
    }
}

/// Dropped with its last owner; dropping closes the surface (never waiting).
pub struct Triangle(Arc<GpuSurface<Draw>>, Arc<Mutex<Probe>>);

impl spec::Triangle for Triangle {
    fn surface_key(&self) -> Result<f64, String> {
        Ok(self.0.key() as f64)
    }

    fn set_background(&self, r: f64, g: f64, b: f64) -> Result<bool, String> {
        if ![r, g, b].iter().all(|c| (0.0..=1.0).contains(c)) {
            return Err("background components must be between 0 and 1".into());
        }
        Ok(self.0.set_state(wgpu::Color { r, g, b, a: 1.0 }))
    }

    fn stats(&self) -> Result<spec::TriangleStats, String> {
        let s = self.0.status();
        let n = |v: u64| v as f64;
        Ok(spec::TriangleStats {
            state: s.state.name().into(),
            gpu_state: s.gpu.name().into(),
            surface_width: s.width.into(),
            surface_height: s.height.into(),
            frames_submitted: n(s.frames_presented),
            inits_started: n(s.setups_started),
            inits_discarded: n(s.setups_discarded),
            device_losses: n(s.device_losses),
            detach_timeouts: n(s.detach_timeouts),
            adapter: s.adapter,
            presentation: s.presentation,
            last_error: s.last_error,
        })
    }

    fn destroy_device_for_testing(&self) -> Result<bool, String> {
        Ok(self.0.destroy_device_for_testing())
    }

    fn arm_hook_probe_for_testing(&self, mode: String) -> Result<bool, String> {
        let hook = match mode.as_str() {
            "create" => "create",
            "draw" => "draw",
            _ => return Ok(false),
        };
        self.1.lock().unwrap_or_else(|e| e.into_inner()).armed = Some(hook);
        Ok(true)
    }

    fn hook_probe_log(&self) -> Result<String, String> {
        Ok(self.1.lock().unwrap_or_else(|e| e.into_inner()).log.join("; "))
    }

    fn close(&self) -> Result<(), String> {
        self.0.close();
        Ok(())
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::spec::{Triangle as _, WebgpuTriangleModule as _};
    use super::*;

    #[test]
    fn create_needs_a_runtime_scope_and_teardown_closes() {
        let outside = Module { scope: None };
        assert!(outside.create().err().unwrap().contains("outside a runtime adapter"));
        let scope = TeardownScope::new();
        let m = Module { scope: Some(scope.clone()) };
        let t = m.create().unwrap();
        assert!((1.0..9007199254740992.0).contains(&t.surface_key().unwrap()));
        assert!(t.set_background(2.0, 0.0, 0.0).is_err());
        assert!(t.set_background(0.0, 0.5, 1.0).unwrap());
        let st = t.stats().unwrap();
        assert_eq!((st.state.as_str(), st.gpu_state.as_str()), ("detached", "none"));
        scope.retire_all();
        assert_eq!(t.stats().unwrap().state, "closed");
        assert!(!t.set_background(0.0, 0.0, 0.0).unwrap(), "closed: false, never an error");
        t.close().unwrap();
    }
}
