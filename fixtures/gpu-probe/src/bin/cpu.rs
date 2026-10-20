//! vello_cpu variant of the probe: rasterizes the paddle/ball scene on the CPU into a pixmap
//! (PROBE_SIZE=WxH, PROBE_THREADS=n), then uploads it into a wgpu texture with
//! `Queue::write_texture` on the Vulkan device, timing each step separately. Finally reads the
//! uploaded texture back from the GPU and requires it to equal the CPU pixmap byte for byte,
//! and checks a few pixels of it. Exits nonzero on any mismatch. This verifies the raster and
//! the upload only: nothing is presented to a window.
use std::time::Instant;
use vello::wgpu;
use vello_cpu::color::{AlphaColor, Srgb};
use vello_cpu::kurbo::{Circle, Rect, RoundedRect, Shape};
use vello_cpu::{Level, Pixmap, RasterizerSettings, RenderContext, RenderMode, RenderSettings, Resources};

fn main() {
    let (w, h): (u16, u16) = std::env::var("PROBE_SIZE")
        .ok()
        .and_then(|s| s.split_once('x').map(|(a, b)| (a.parse().unwrap(), b.parse().unwrap())))
        .unwrap_or((256, 256));
    let threads: u16 = std::env::var("PROBE_THREADS").ok().map(|s| s.parse().unwrap()).unwrap_or(0);
    let settings = RenderSettings { level: Level::try_detect().unwrap_or(Level::baseline()), num_threads: threads };
    println!("level {:?} threads {threads} size {w}x{h}", settings.level);
    let mut ctx = RenderContext::new_with(w, h, settings);
    let mut resources = Resources::new();
    let mut pixmap = Pixmap::new(w, h);
    let raster = RasterizerSettings { render_mode: RenderMode::OptimizeSpeed, ..Default::default() };

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::VULKAN, ..wgpu::InstanceDescriptor::new_without_display_handle() });
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).expect("device");
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("frame"),
        size: wgpu::Extent3d { width: w.into(), height: h.into(), depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let (sx, sy) = (f64::from(w) / 256.0, f64::from(h) / 256.0);
    let (mut build, mut rast, mut upload) = (vec![], vec![], vec![]);
    let validate = std::env::var_os("PROBE_VALIDATE").is_some();
    for i in 0..if validate { 12 } else { 120 } {
        let t0 = Instant::now();
        ctx.reset();
        ctx.set_paint(AlphaColor::<Srgb>::from_rgb8(32, 0, 0));
        ctx.fill_rect(&Rect::new(0.0, 0.0, w.into(), h.into()));
        ctx.set_paint(AlphaColor::<Srgb>::from_rgb8(0, 0, 255));
        ctx.fill_rect(&Rect::new(16.0 * sx, 16.0 * sy, 112.0 * sx, 112.0 * sy));
        ctx.set_paint(AlphaColor::<Srgb>::from_rgb8(255, 255, 255));
        let cx = if validate || i == 119 { 192.0 } else { 150.0 + (i % 40) as f64 };
        ctx.fill_path(&Circle::new((cx * sx, 64.0 * sy), 40.0 * sx.min(sy)).to_path(0.1));
        ctx.set_paint(AlphaColor::<Srgb>::from_rgb8(0, 200, 0));
        ctx.fill_path(&RoundedRect::new(16.0 * sx, 160.0 * sy, 240.0 * sx, 240.0 * sy, 12.0).to_path(0.1));
        ctx.flush();
        let t1 = Instant::now();
        ctx.render_with(&mut pixmap, &mut resources, raster);
        let t2 = Instant::now();
        queue.write_texture(
            texture.as_image_copy(),
            pixmap.data_as_u8_slice(),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(u32::from(w) * 4), rows_per_image: None },
            wgpu::Extent3d { width: w.into(), height: h.into(), depth_or_array_layers: 1 },
        );
        queue.submit([]);
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        let t3 = Instant::now();
        build.push((t1 - t0).as_secs_f64() * 1e3);
        rast.push((t2 - t1).as_secs_f64() * 1e3);
        upload.push((t3 - t2).as_secs_f64() * 1e3);
    }
    let stat = |name: &str, v: &mut Vec<f64>| {
        let v = &mut v[10..];
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!("timing {name}_ms median={:.3} p90={:.3} max={:.3} n={}", v[v.len() / 2], v[v.len() * 9 / 10], v[v.len() - 1], v.len());
    };
    stat("scene", &mut build);
    stat("raster", &mut rast);
    stat("upload", &mut upload);
    // GPU readback of the uploaded texture (rows padded to 256 bytes).
    let row = u32::from(w) * 4;
    let bpr = row.next_multiple_of(256);
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
    let mapped = buf.slice(..).get_mapped_range().expect("mapped range");
    let gpu: Vec<u8> = mapped.chunks(bpr as usize).flat_map(|r| r[..row as usize].iter().copied()).collect();
    drop(mapped);
    let cpu = pixmap.data_as_u8_slice();
    if let Ok(path) = std::env::var("PROBE_RGBA") { std::fs::write(path, cpu).expect("write CPU RGBA"); }
    let differing = gpu.iter().zip(cpu).filter(|(a, b)| a != b).count();
    println!("readback gpu_bytes={} cpu_bytes={} differing_bytes={differing}", gpu.len(), cpu.len());
    let mut ok = gpu.len() == cpu.len() && differing == 0;
    let px = |x: f64, y: f64| {
        let i = ((y * sy) as usize * usize::from(w) + (x * sx) as usize) * 4;
        [gpu[i], gpu[i + 1], gpu[i + 2], gpu[i + 3]]
    };
    for ((x, y), want) in [((64.0, 64.0), [0, 0, 255, 255]), ((192.0, 64.0), [255, 255, 255, 255]), ((128.0, 200.0), [0, 200, 0, 255]), ((4.0, 140.0), [32, 0, 0, 255])] {
        let got = px(x, y);
        println!("pixel ({x},{y}) = {got:?} want {want:?}");
        ok &= got == want;
    }
    println!("RESULT {}", if ok { "pass" } else { "fail: GPU readback mismatch" });
    std::process::exit(if ok { 0 } else { 1 });
}
