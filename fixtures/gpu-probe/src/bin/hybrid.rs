//! vello_hybrid variant of the probe (see main.rs): the same three shapes rendered with the
//! sparse-strip hybrid renderer (paths processed on the CPU into strips, composited by wgpu
//! render pipelines instead of Vello's compute pipeline). PROBE_SIZE=WxH changes the target.
use std::time::Instant;
use vello_common::kurbo::{Circle, Rect, RoundedRect, Shape};
use vello_common::peniko::color::{AlphaColor, Srgb};
use wgpu29 as wgpu;

fn main() {
    let (w, h): (u16, u16) = std::env::var("PROBE_SIZE")
        .ok()
        .and_then(|s| s.split_once('x').map(|(a, b)| (a.parse().unwrap(), b.parse().unwrap())))
        .unwrap_or((256, 256));
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).expect("adapter");
    println!("adapter {:?}", adapter.get_info());
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("hybrid-probe"), ..Default::default() })).expect("device");
    device.on_uncaptured_error(std::sync::Arc::new(|e| println!("uncaptured wgpu error: {e}")));
    let format = wgpu::TextureFormat::Rgba8Unorm;
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("target"),
        size: wgpu::Extent3d { width: w.into(), height: h.into(), depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&Default::default());
    let t1 = Instant::now();
    let (mut renderer, mut resources) =
        vello_hybrid::Renderer::new(&device, &vello_hybrid::RenderTargetConfig { format, width: w.into(), height: h.into() });
    println!("timing hybrid_renderer_new_ms={:.1}", t1.elapsed().as_secs_f64() * 1e3);
    let size = vello_hybrid::RenderSize { width: w.into(), height: h.into() };
    let mut scene = vello_hybrid::Scene::new(w, h);
    let mut times = Vec::new();
    let mut encode = Vec::new();
    let validate = std::env::var_os("PROBE_VALIDATE").is_some();
    for i in 0..if validate { 2 } else { 60 } {
        let t = Instant::now();
        scene.reset();
        // Background, paddle, ball (moving), rounded rect.
        scene.set_paint(AlphaColor::<Srgb>::from_rgb8(32, 0, 0));
        scene.fill_rect(&Rect::new(0.0, 0.0, w.into(), h.into()));
        scene.set_paint(AlphaColor::<Srgb>::from_rgb8(0, 0, 255));
        scene.fill_rect(&Rect::new(16.0, 16.0, 112.0, 112.0));
        scene.set_paint(AlphaColor::<Srgb>::from_rgb8(255, 255, 255));
        let cx = if validate || i == 59 { 192.0 } else { 150.0 + (i as f64) };
        scene.fill_path(&Circle::new((cx, 64.0), 40.0).to_path(0.1));
        scene.set_paint(AlphaColor::<Srgb>::from_rgb8(0, 200, 0));
        scene.fill_path(&RoundedRect::new(16.0, 160.0, 240.0, 240.0, 12.0).to_path(0.1));
        let te = t.elapsed();
        let mut enc = device.create_command_encoder(&Default::default());
        renderer
            .render(&scene, &mut resources, &device, &queue, &mut enc, &size, &view, &vello_hybrid::TextureBindings::new())
            .expect("render");
        queue.submit([enc.finish()]);
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        encode.push(te.as_secs_f64() * 1e3);
        times.push(t.elapsed().as_secs_f64() * 1e3);
    }
    println!("timing first_frame_ms={:.2}", times[0]);
    let med = |v: &mut Vec<f64>| { v.sort_by(|a, b| a.partial_cmp(b).unwrap()); (v[v.len() / 2], v[v.len() - 1]) };
    let mut rest = times[1..].to_vec();
    let mut enc_rest = encode[1..].to_vec();
    let (m, x) = med(&mut rest);
    let (em, ex) = med(&mut enc_rest);
    println!("timing frame_wait_ms median={m:.2} max={x:.2} scene_build_ms median={em:.3} max={ex:.3} n={} size={w}x{h}", rest.len());

    let bpr = (u32::from(w) * 4).next_multiple_of(256);
    let buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: u64::from(bpr) * u64::from(h),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut enc = device.create_command_encoder(&Default::default());
    enc.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bpr), rows_per_image: None } },
        wgpu::Extent3d { width: w.into(), height: h.into(), depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);
    buf.slice(..).map_async(wgpu::MapMode::Read, |r| r.expect("map"));
    device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let data = buf.slice(..).get_mapped_range().to_vec();
    if let Ok(path) = std::env::var("PROBE_RGBA") {
        let packed: Vec<u8> = data.chunks(bpr as usize).flat_map(|r| r[..usize::from(w) * 4].iter().copied()).collect();
        std::fs::write(path, packed).expect("write RGBA");
    }
    let px = |x: u32, y: u32| {
        let i = (y * bpr + x * 4) as usize;
        [data[i], data[i + 1], data[i + 2], data[i + 3]]
    };
    let mut ok = true;
    for ((x, y), want) in [((64, 64), [0, 0, 255, 255]), ((192, 64), [255, 255, 255, 255]), ((128, 200), [0, 200, 0, 255]), ((4, 140), [32, 0, 0, 255])] {
        let got = px(x, y);
        println!("pixel ({x},{y}) = {got:?} want {want:?}");
        ok &= got == want;
    }
    println!("RESULT {}", if ok { "pass" } else { "fail: pixel mismatch" });
    std::process::exit(if ok { 0 } else { 1 });
}
