//! The provisional presenter (docs/surface.md): each frame is rasterized on the render thread
//! by vello_cpu into a pixmap, uploaded to a wgpu texture and scaled onto the swapchain image
//! with a blit, then presented (FIFO, so presenting paces to the display).
//!
//! - The wgpu device is created by `prepare`, before any window lease is taken, and kept
//!   across detach/attach. A device-lost callback marks it lost; the render loop then calls
//!   `reset_device`, which drops every GPU resource here, on the render thread, before a new
//!   device is created.
//! - The wgpu surface holds the window lease and is dropped on unbind (destroying the
//!   swapchain, which can wait for the GPU: part of the platform's bounded detach wait).
//! - Acquire and present are each admitted through the lease (rnr-surface's admission
//!   protocol), with no lock held during the GPU calls.
//! - Configure errors are captured with an error scope and returned, not only logged.
//!
//! Panics abort the process (`panic = "abort"`); input-dependent paths avoid them.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use rnr_surface::{Extent, WindowLease};

use crate::cpu::{CpuRaster, MAX_RASTER};
use crate::frame::Cmd;
use crate::render::{admitted, present_admitted, reconfigure_outdated, PresentError, Presenter, SurfaceLease, Timings};

#[cfg(target_os = "ios")]
const BACKENDS: wgpu::Backends = wgpu::Backends::METAL;

/// Device limits on iOS ([`required_limits_for`] over the adapter's limits); unchanged
/// elsewhere (`Limits::default()`). The iOS simulator's Metal adapter allows 15 inter-stage
/// shader variables, below the WebGPU default of 16 that `Limits::default()` requests (found by
/// C1 S3); the blit and the raster texture need nothing beyond the downlevel defaults.
#[cfg(target_os = "ios")]
fn required_limits(adapter: &wgpu::Adapter) -> Result<wgpu::Limits, String> {
    required_limits_for(&adapter.limits())
}
#[cfg(not(target_os = "ios"))]
fn required_limits(_adapter: &wgpu::Adapter) -> Result<wgpu::Limits, String> {
    Ok(wgpu::Limits::default())
}

/// The downlevel defaults, with:
/// - the adapter's texture dimensions (`using_resolution`): downlevel's 2048 is below a phone
///   drawable (e.g. 2622 px), and requesting the adapter's own maximum accepts any drawable the
///   adapter can present, at no cost;
/// - the adapter's (more permissive) buffer alignments (`using_alignment`).
///
/// Validated before any device request: every limit above the adapter's is listed in one error,
/// and the adapter must take a [`MAX_RASTER`] raster texture. A pure function (host-tested).
#[cfg_attr(not(any(test, target_os = "ios")), allow(dead_code))]
pub(crate) fn required_limits_for(supported: &wgpu::Limits) -> Result<wgpu::Limits, String> {
    let requested = wgpu::Limits::downlevel_defaults().using_resolution(supported.clone()).using_alignment(supported.clone());
    let mut over = Vec::new();
    requested.check_limits_with_fail_fn(supported, false, |name, want, allowed| over.push(format!("{name} {want} > {allowed}")));
    if !over.is_empty() {
        return Err(format!("the adapter does not support the requested limits: {}", over.join(", ")));
    }
    if supported.max_texture_dimension_2d < MAX_RASTER {
        return Err(format!("the adapter's max_texture_dimension_2d {} is below the {MAX_RASTER} the raster needs", supported.max_texture_dimension_2d));
    }
    Ok(requested)
}
#[cfg(not(target_os = "ios"))]
const BACKENDS: wgpu::Backends = wgpu::Backends::VULKAN;

/// The configure error after a revocation (no configure was started).
const CONFIGURE_REVOKED: &str = "the attachment was revoked before configure";

struct Gpu {
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    lost: Arc<AtomicBool>,
}

struct Target {
    /// The wgpu surface, then the lease used to admit acquire and present (dropped after the
    /// surface; on Android the surface also holds a lease of its own as its handle source).
    bound: SurfaceLease<wgpu::Surface<'static>>,
    /// Whether the last configure allows acquires (rnr_surface::layer; always true where the
    /// platform has no drawable-timeout read-back).
    acquire_allowed: bool,
    config: wgpu::SurfaceConfiguration,
    view_format: wgpu::TextureFormat,
    blitter: wgpu::util::TextureBlitter,
}

struct Raster {
    cpu: CpuRaster,
    texture: wgpu::Texture,
    view: wgpu::TextureView,
}

pub struct WgpuPresenter {
    resolution_scale: f32,
    gpu: Option<Gpu>,
    target: Option<Target>,
    raster: Option<Raster>,
    device_init_ms: f64,
}

// Keep the presenter-facing extent conversion at the platform boundary.
fn raster_geometry(extent: Extent, resolution_scale: f32) -> ((u32, u32), f64) {
    crate::cpu::raster_geometry(extent.width, extent.height, extent.scale, resolution_scale)
}

impl WgpuPresenter {
    pub fn new(resolution_scale: f32) -> Self {
        Self { resolution_scale, gpu: None, target: None, raster: None, device_init_ms: 0.0 }
    }

    /// Configures the swapchain under its own admission (bind, resize and the Outdated
    /// reconfigure all come here): after a revocation no configure starts (on iOS: no layer
    /// writes), and a revocation meanwhile sees it in flight. The admission is released before
    /// returning. A revocation racing a bind or resize fails that step like any configure
    /// failure; the next attachment starts recovery afresh.
    fn configure(gpu: &Gpu, target: &mut Target) -> Result<(), String> {
        // A clone, so the admission does not borrow the target being configured.
        let lease = target.bound.lease.clone();
        let Some((result, allowed)) = admitted(&lease, || Self::configure_admitted(gpu, target)) else {
            target.acquire_allowed = false;
            return Err(CONFIGURE_REVOKED.into());
        };
        target.acquire_allowed = allowed;
        result
    }

    /// The configure itself, under the caller's admission: the result and whether acquires
    /// may be admitted afterwards.
    fn configure_admitted(gpu: &Gpu, target: &Target) -> (Result<(), String>, bool) {
        let run = || {
            let scope = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
            target.bound.surface.configure(&gpu.device, &target.config);
            match pollster::block_on(scope.pop()) {
                Some(e) => Err(format!("configure {}x{} {:?}: {e}", target.config.width, target.config.height, target.config.format)),
                None => Ok(()),
            }
        };
        // iOS: inside an explicit Core Animation transaction that restores the drawable
        // timeout and reads it back; acquires are refused unless it is confirmed.
        #[cfg(target_os = "ios")]
        let (result, allowed) = {
            let configured = rnr_surface::ios::configure_in_transaction(&target.bound.lease, run);
            (configured.result, configured.acquire_allowed)
        };
        // Elsewhere there is no layer read-back.
        #[cfg(not(target_os = "ios"))]
        let (result, allowed) = (run(), true);
        (result, allowed)
    }

    fn ensure_raster(&mut self, w: u32, h: u32) -> Result<(), String> {
        if self.raster.as_ref().is_some_and(|r| r.cpu.size() == (w, h)) {
            return Ok(());
        }
        let gpu = self.gpu.as_ref().ok_or("no device")?;
        self.raster = None;
        let (w16, h16) = (u16::try_from(w).map_err(|_| "raster too wide")?, u16::try_from(h).map_err(|_| "raster too tall")?);
        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("rnr-vello2d raster"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        self.raster = Some(Raster { cpu: CpuRaster::new(w16, h16), texture, view });
        Ok(())
    }
}


impl Presenter for WgpuPresenter {
    fn device_lost(&self) -> bool {
        self.gpu.as_ref().is_some_and(|g| g.lost.load(Ordering::SeqCst))
    }

    fn prepare(&mut self) -> Result<(), String> {
        if self.device_lost() {
            self.reset_device();
        }
        if self.gpu.is_some() {
            return Ok(());
        }
        let started = Instant::now();
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: BACKENDS, ..wgpu::InstanceDescriptor::new_without_display_handle() });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).map_err(|e| format!("no {BACKENDS:?} adapter: {e}"))?;
        let requested = required_limits(&adapter)?;
        let supported = adapter.limits();
        let adapter_info = adapter.get_info();
        log::info!(
            "rnr-vello2d: requesting a device on {:?} {}: max_inter_stage_shader_variables {} (adapter {}), max_texture_dimension_2d {} (adapter {})",
            adapter_info.backend, adapter_info.name, requested.max_inter_stage_shader_variables, supported.max_inter_stage_shader_variables,
            requested.max_texture_dimension_2d, supported.max_texture_dimension_2d
        );
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("rnr-vello2d"), required_limits: requested, ..Default::default() }))
            .map_err(|e| format!("request_device: {e}"))?;
        device.on_uncaptured_error(Arc::new(|e| log::error!("rnr-vello2d: wgpu error: {e}")));
        let lost = Arc::new(AtomicBool::new(false));
        let flag = lost.clone();
        device.set_device_lost_callback(move |reason, message| {
            log::error!("rnr-vello2d: GPU device lost ({reason:?}): {message}");
            flag.store(true, Ordering::SeqCst);
        });
        let info = adapter.get_info();
        log::info!("rnr-vello2d: {:?} {} ({})", info.backend, info.name, info.driver_info);
        self.device_init_ms = started.elapsed().as_secs_f64() * 1e3;
        self.gpu = Some(Gpu { instance, adapter, device, queue, lost });
        Ok(())
    }

    fn bind(&mut self, lease: WindowLease, extent: Extent) -> Result<(), String> {
        self.target = None;
        if self.device_lost() {
            return Err("the GPU device was lost".into());
        }
        let gpu = self.gpu.as_ref().ok_or("no device")?;
        let admission = lease.clone();
        // iOS: the window's CAMetalLayer directly (wgpu's UIKit path requires the main thread).
        // The layer stays alive while `admission` is held: the Target drops the surface first.
        #[cfg(target_os = "ios")]
        let surface = {
            let layer = lease.metal_layer().ok_or("the window has no Metal layer")?;
            drop(lease);
            // SAFETY: a CAMetalLayer kept alive by `admission` for the surface's lifetime.
            unsafe { gpu.instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer.as_ptr())) }.map_err(|e| format!("create_surface: {e}"))?
        };
        #[cfg(not(target_os = "ios"))]
        let surface = gpu.instance.create_surface(lease).map_err(|e| format!("create_surface: {e}"))?;
        if !gpu.adapter.is_surface_supported(&surface) {
            return Err("the adapter cannot present to this window".into());
        }
        let caps = surface.get_capabilities(&gpu.adapter);
        // vello_cpu produces sRGB-encoded bytes; present them unchanged through a non-sRGB view.
        let format = [wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureFormat::Bgra8Unorm]
            .into_iter()
            .find(|f| caps.formats.contains(f))
            .or_else(|| caps.formats.first().copied())
            .ok_or("the window reports no formats")?;
        let view_format = format.remove_srgb_suffix();
        let alpha_mode = if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
            wgpu::CompositeAlphaMode::Opaque
        } else {
            caps.alpha_modes.first().copied().ok_or("the window reports no alpha modes")?
        };
        let mut config = surface.get_default_config(&gpu.adapter, extent.width, extent.height).ok_or("the window is not supported by the adapter")?;
        config.format = format;
        config.view_formats = if view_format != format { vec![view_format] } else { vec![] };
        config.present_mode = wgpu::PresentMode::Fifo;
        config.alpha_mode = alpha_mode;
        config.desired_maximum_frame_latency = 2;
        let blitter = wgpu::util::TextureBlitterBuilder::new(&gpu.device, view_format).sample_type(wgpu::FilterMode::Linear).build();
        let mut target = Target { bound: SurfaceLease { surface, lease: admission }, acquire_allowed: false, config, view_format, blitter };
        Self::configure(gpu, &mut target)?;
        log::info!("rnr-vello2d: bound {}x{} format {format:?} (view {view_format:?}) alpha {alpha_mode:?}", extent.width, extent.height);
        self.target = Some(target);
        Ok(())
    }

    fn resize(&mut self, extent: Extent) -> Result<(), String> {
        let gpu = self.gpu.as_ref().ok_or("no device")?;
        let target = self.target.as_mut().ok_or("no window")?;
        target.config.width = extent.width;
        target.config.height = extent.height;
        Self::configure(gpu, target)
    }

    fn unbind(&mut self) {
        // Dropping the wgpu surface destroys the swapchain and releases both leases.
        self.target = None;
    }

    fn reset_device(&mut self) {
        self.target = None;
        self.raster = None;
        self.gpu = None;
    }

    fn present(&mut self, cmds: &[Cmd], extent: Extent) -> Result<Timings, PresentError> {
        if self.device_lost() {
            return Err(PresentError::DeviceLost("reported by the device-lost callback".into()));
        }
        let failed = PresentError::Failed;
        let ((rw, rh), scale) = raster_geometry(extent, self.resolution_scale);
        self.ensure_raster(rw, rh).map_err(failed)?;
        let mut timings = Timings::default();
        let t0 = Instant::now();
        {
            let raster = self.raster.as_mut().ok_or_else(|| failed("no raster".into()))?;
            raster.cpu.render(cmds, scale);
        }
        let t1 = Instant::now();
        let gpu = self.gpu.as_ref().ok_or_else(|| failed("no device".into()))?;
        let raster = self.raster.as_ref().ok_or_else(|| failed("no raster".into()))?;
        gpu.queue.write_texture(
            raster.texture.as_image_copy(),
            raster.cpu.pixels(),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(rw * 4), rows_per_image: None },
            wgpu::Extent3d { width: rw, height: rh, depth_or_array_layers: 1 },
        );
        let t2 = Instant::now();
        let target = self.target.as_mut().ok_or_else(|| failed("no window".into()))?;
        let mut outdated = false;
        let mut t3 = t2;
        let presented = present_admitted(
            &target.bound.lease,
            target.acquire_allowed,
            || match target.bound.surface.get_current_texture() {
                wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => Ok(f),
                wgpu::CurrentSurfaceTexture::Timeout => Err(PresentError::Skipped("acquire timed out".into())),
                wgpu::CurrentSurfaceTexture::Occluded => Err(PresentError::Skipped("occluded".into())),
                wgpu::CurrentSurfaceTexture::Outdated => {
                    outdated = true;
                    Err(PresentError::Skipped("swapchain outdated".into())) // replaced below
                }
                wgpu::CurrentSurfaceTexture::Lost => Err(PresentError::SurfaceLost("swapchain lost".into())),
                other => Err(failed(format!("cannot acquire a swapchain image: {other:?}"))),
            },
            |frame| {
                t3 = Instant::now();
                let view = frame.texture.create_view(&wgpu::TextureViewDescriptor { format: Some(target.view_format), ..Default::default() });
                let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("rnr-vello2d blit") });
                target.blitter.copy(&gpu.device, &mut encoder, &raster.view, &view);
                (frame, encoder)
            },
            // Admitted separately: after a revocation the acquired image is dropped unpresented.
            |(frame, encoder)| {
                gpu.queue.submit([encoder.finish()]);
                gpu.queue.present(frame);
            },
        );
        if outdated {
            // A lease clone, so the configure can borrow the target mutably.
            let lease = target.bound.lease.clone();
            return Err(reconfigure_outdated(&lease, || Self::configure(gpu, target)));
        }
        presented?;
        let t4 = Instant::now();
        let ms = |a: Instant, b: Instant| (b - a).as_secs_f64() * 1e3;
        timings.raster_ms = ms(t0, t1);
        timings.upload_ms = ms(t1, t2);
        timings.acquire_ms = ms(t2, t3);
        timings.present_ms = ms(t3, t4);
        Ok(timings)
    }

    fn raster_size(&self, extent: Extent) -> (u32, u32) {
        raster_geometry(extent, self.resolution_scale).0
    }

    fn device_init_ms(&self) -> f64 {
        self.device_init_ms
    }

    fn describe(&self) -> String {
        match &self.target {
            Some(t) => format!("{:?} (view {:?}), alpha {:?}, {:?}", t.config.format, t.view_format, t.config.alpha_mode, t.config.present_mode),
            None => String::new(),
        }
    }
}

impl Drop for WgpuPresenter {
    /// Runs on the render thread: window first, then raster resources, then the device. A
    /// stalled GPU keeps this thread (and its renderer slot) retiring; nothing else waits.
    fn drop(&mut self) {
        self.target = None;
        self.raster = None;
        if let Some(gpu) = self.gpu.take() {
            let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            drop(gpu);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    /// The iOS limits: the simulator adapter's values pass with 15 inter-stage variables; a
    /// too-small adapter fails before any request, naming every missing limit.
    #[test]
    fn required_limits_fit_the_adapter_or_name_what_is_missing() {
        let simulator = wgpu::Limits { max_inter_stage_shader_variables: 15, max_texture_dimension_2d: 16384, ..wgpu::Limits::default() };
        let ok = required_limits_for(&simulator).unwrap();
        assert_eq!((ok.max_inter_stage_shader_variables, ok.max_texture_dimension_2d), (15, 16384));
        let weak = wgpu::Limits { max_inter_stage_shader_variables: 8, max_bind_groups: 2, ..simulator.clone() };
        let err = required_limits_for(&weak).unwrap_err();
        assert!(err.contains("max_inter_stage_shader_variables 15 > 8") && err.contains("max_bind_groups 4 > 2"), "{err}");
        let small = wgpu::Limits { max_texture_dimension_2d: 2048, max_texture_dimension_1d: 2048, ..simulator };
        assert!(required_limits_for(&small).unwrap_err().contains("max_texture_dimension_2d 2048 is below the 4096"));
    }
}
