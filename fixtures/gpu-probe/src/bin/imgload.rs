//! Minimal reproduction for the Mali SPIR-V compiler crash seen with vello_hybrid: creates one
//! render pipeline whose fragment shader does `textureLoad` (argument 1: u32 | f32 | array),
//! compiled either with naga's default runtime bounds checks or unchecked (argument 2).
use vello::wgpu;

fn main() {
    let kind = std::env::args().nth(1).unwrap_or_else(|| "u32".into());
    let checks = std::env::args().nth(2).unwrap_or_else(|| "checked".into());
    let (decl, load) = match kind.as_str() {
        "u32" => ("var t: texture_2d<u32>;", "vec4<f32>(textureLoad(t, vec2<u32>(p.xy), 0))"),
        "f32" => ("var t: texture_2d<f32>;", "textureLoad(t, vec2<i32>(p.xy), 0)"),
        "array" => ("var t: texture_2d_array<f32>;", "textureLoad(t, vec2<u32>(p.xy), 1u, 0)"),
        _ => panic!("kind"),
    };
    let src = format!(
        "@group(0) @binding(0) {decl}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {{
  return vec4<f32>(f32(i & 1u) * 2.0 - 1.0, f32(i >> 1u) * 2.0 - 1.0, 0.0, 1.0);
}}
@fragment fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {{ return {load}; }}"
    );
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::VULKAN, ..wgpu::InstanceDescriptor::new_without_display_handle() });
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    let (device, _queue) = pollster::block_on(adapter.request_device(&Default::default())).expect("device");
    let desc = wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(src.into()) };
    let module = if checks == "unchecked" {
        unsafe { device.create_shader_module_trusted(desc, wgpu::ShaderRuntimeChecks::unchecked()) }
    } else {
        device.create_shader_module(desc)
    };
    println!("creating pipeline kind={kind} checks={checks}");
    let _p = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())],
        }),
        multiview_mask: None,
        cache: None,
    });
    println!("RESULT pass kind={kind} checks={checks}");
}
