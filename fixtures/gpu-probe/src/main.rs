//! Headless GPU probe for the surface/Vello renderer (docs/surface.md).
//!
//! Prints every adapter wgpu finds (Vulkan and GLES), requests a device with Vello's limits on
//! the first Vulkan adapter, renders one Vello scene into an offscreen texture, reads it back
//! and checks a few pixels. Repeats the render to time it. Optionally writes the image as a
//! binary PPM (argument 1). No window, surface or React Native involved.
use std::time::Instant;
use vello::kurbo::{Affine, Circle, Rect, RoundedRect};
use vello::peniko::{Color, Fill};
use vello::wgpu;

const W: u32 = 256;
const H: u32 = 256;

fn main() {
    let out = std::env::args().nth(1);
    let want = if std::env::var("PROBE_BACKEND").as_deref() == Ok("gl") { wgpu::Backend::Gl } else { wgpu::Backend::Vulkan };
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN | wgpu::Backends::GL,
        flags: wgpu::InstanceFlags::from_env_or_default(),
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapters = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));
    for a in &adapters {
        let i = a.get_info();
        println!("adapter backend={:?} name={:?} type={:?} driver={:?} driver_info={:?}", i.backend, i.name, i.device_type, i.driver, i.driver_info);
    }
    let Some(adapter) = adapters.into_iter().find(|a| a.get_info().backend == want) else {
        println!("RESULT fail: no {want:?} adapter");
        std::process::exit(1);
    };
    let l = adapter.limits();
    println!(
        "limits storage_buffers_per_stage={} storage_textures_per_stage={} workgroup_storage={} invocations={} max_buffer={} max_storage_binding={} max_tex2d={}",
        l.max_storage_buffers_per_shader_stage, l.max_storage_textures_per_shader_stage, l.max_compute_workgroup_storage_size,
        l.max_compute_invocations_per_workgroup, l.max_buffer_size, l.max_storage_buffer_binding_size, l.max_texture_dimension_2d
    );
    println!("features {:?}", adapter.features());
    let t0 = Instant::now();
    let (device, queue) = match pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("gpu-probe"),
        required_limits: wgpu::Limits::default(),
        ..Default::default()
    })) {
        Ok(dq) => dq,
        Err(e) => {
            println!("RESULT fail: request_device with default limits: {e}");
            std::process::exit(1);
        }
    };
    println!("timing device_ms={:.1}", t0.elapsed().as_secs_f64() * 1e3);
    device.on_uncaptured_error(std::sync::Arc::new(|e| println!("uncaptured wgpu error: {e}")));

    let t1 = Instant::now();
    let mut renderer = vello::Renderer::new(
        &device,
        vello::RendererOptions {
            use_cpu: std::env::var_os("PROBE_CPU").is_some(),
            antialiasing_support: vello::AaSupport::area_only(),
            num_init_threads: None,
            pipeline_cache: None,
        },
    )
    .expect("vello renderer");
    println!("timing vello_renderer_new_ms={:.1}", t1.elapsed().as_secs_f64() * 1e3);

    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("target"),
        size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&Default::default());
    let mut scene = vello::Scene::new();
    let empty = std::env::var_os("PROBE_EMPTY").is_some();
    let only = std::env::var("PROBE_ONLY").unwrap_or_default();
    if !empty && (only.is_empty() || only == "rect") {
    // Paddle (left half, blue), ball (right half, white circle), green rounded rect at bottom.
    scene.fill(Fill::NonZero, Affine::IDENTITY, Color::from_rgb8(0, 0, 255), None, &Rect::new(16.0, 16.0, 112.0, 112.0));
    }
    if !empty && (only.is_empty() || only == "circle") {
    scene.fill(Fill::NonZero, Affine::IDENTITY, Color::from_rgb8(255, 255, 255), None, &Circle::new((192.0, 64.0), 40.0));
    }
    if !empty && only.is_empty() {
    scene.fill(Fill::NonZero, Affine::IDENTITY, Color::from_rgb8(0, 200, 0), None, &RoundedRect::new(16.0, 160.0, 240.0, 240.0, 12.0));
    }
    let params = vello::RenderParams {
        base_color: Color::from_rgb8(32, 0, 0),
        width: W,
        height: H,
        antialiasing_method: vello::AaConfig::Area,
    };
    let mut times = Vec::new();
    for _ in 0..if std::env::var_os("PROBE_VALIDATE").is_some() { 2 } else { 30 } {
        let t = Instant::now();
        renderer.render_to_texture(&device, &queue, &scene, &view, &params).expect("render");
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        times.push(t.elapsed().as_secs_f64() * 1e3);
    }
    println!("timing first_render_ms={:.2}", times[0]);
    let mut rest = times[1..].to_vec();
    rest.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("timing render_wait_ms median={:.2} max={:.2} n={}", rest[rest.len() / 2], rest[rest.len() - 1], rest.len());

    let bpr = W * 4; // 1024, already a multiple of 256
    let buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: (bpr * H) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut enc = device.create_command_encoder(&Default::default());
    enc.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bpr), rows_per_image: Some(H) } },
        wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);
    buf.slice(..).map_async(wgpu::MapMode::Read, |r| r.expect("map"));
    device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let data = buf.slice(..).get_mapped_range().expect("mapped range").to_vec();
    if let Ok(path) = std::env::var("PROBE_RGBA") { std::fs::write(path, &data).expect("write RGBA"); }
    let px = |x: u32, y: u32| {
        let i = ((y * W + x) * 4) as usize;
        [data[i], data[i + 1], data[i + 2], data[i + 3]]
    };
    // Expected pixels follow the shapes actually drawn (PROBE_EMPTY, PROBE_ONLY); undrawn areas
    // show the base colour.
    const BASE: [u8; 4] = [32, 0, 0, 255];
    let drawn = |name: &str| !empty && (only.is_empty() || only == name);
    let checks = [
        ((64, 64), if drawn("rect") { [0, 0, 255, 255] } else { BASE }),
        ((192, 64), if drawn("circle") { [255, 255, 255, 255] } else { BASE }),
        ((128, 200), if !empty && only.is_empty() { [0, 200, 0, 255] } else { BASE }),
        ((4, 4), BASE),
    ];
    let mut ok = true;
    for ((x, y), want) in checks {
        let got = px(x, y);
        println!("pixel ({x},{y}) = {got:?} want {want:?}");
        ok &= got == want;
    }
    if let Some(path) = out {
        let mut ppm = format!("P6\n{W} {H}\n255\n").into_bytes();
        for p in data.chunks(4) {
            ppm.extend_from_slice(&p[..3]);
        }
        std::fs::write(&path, ppm).expect("write ppm");
        println!("wrote {path}");
    }
    println!("RESULT {}", if ok { "pass" } else { "fail: pixel mismatch" });
    std::process::exit(if ok { 0 } else { 1 });
}
