//! The small adapter between Bevy and the surface: our own wgpu device (handed to Bevy), and a
//! swapchain on the leased window that Bevy never sees. Each frame Bevy renders into an
//! offscreen texture ([`crate::scene`]); here it is blitted onto the acquired swapchain image
//! and presented. That blit is one extra full-screen GPU pass per frame (not zero-copy).
//!
//! - Acquire, present and configure are each admitted through the lease (rnrs-surface's
//!   admission protocol), with no lock held during the GPU calls. After a revocation no
//!   acquire starts and an acquired image is dropped unpresented.
//! - The wgpu surface holds the lease and is dropped with the [`Target`]; dropping it destroys
//!   the swapchain (part of the platform's bounded detach wait).
//! - Colour: Bevy writes sRGB-encoded bytes (its target view is `Rgba8UnormSrgb`); the blit reads
//!   them through a non-sRGB view and writes a non-sRGB view of the swapchain, so the bytes
//!   reach the display unchanged, as in vello2d.
//! - iOS (Metal), with rnrs-surface's iOS contracts exactly as vello2d uses them: the surface is
//!   made from the lease's `CAMetalLayer` (wgpu's UIKit path needs the main thread), each
//!   configure runs in `rnrs_surface::ios::configure_in_transaction`, and acquires are refused
//!   unless its read-back confirmed the drawable timeout.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rnrs_surface::{Extent, WindowLease};

pub enum PresentError {
    /// Nothing presented this time (timeout, occluded, outdated and reconfigured, revoked).
    Skipped(String),
    /// Rendering to this attachment ends (lost surface or device, failed reconfigure).
    Fatal(String),
}

#[cfg(target_os = "ios")]
const BACKENDS: wgpu::Backends = wgpu::Backends::METAL;
#[cfg(not(target_os = "ios"))]
const BACKENDS: wgpu::Backends = wgpu::Backends::VULKAN;

/// Why a present fails when the last configure did not confirm the drawable timeout (iOS).
const ACQUIRE_REFUSED: &str = "acquire refused: the drawable timeout was not confirmed after configure";

pub struct Gpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    lost: Arc<AtomicBool>,
}

impl Gpu {
    pub fn new() -> Result<Self, String> {
        let backends = BACKENDS;
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends, ..wgpu::InstanceDescriptor::new_without_display_handle() });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).map_err(|e| format!("no {backends:?} adapter: {e}"))?;
        // Bevy picks its pipelines (e.g. storage vs uniform buffers) from the device's limits,
        // so the device gets everything the adapter offers.
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("rnrs-bevy3d"), required_limits: adapter.limits(), ..Default::default() }))
            .map_err(|e| format!("request_device: {e}"))?;
        device.on_uncaptured_error(Arc::new(|e| log::error!("rnrs-bevy3d: wgpu error: {e}")));
        let lost = Arc::new(AtomicBool::new(false));
        let flag = lost.clone();
        device.set_device_lost_callback(move |reason, message| {
            log::error!("rnrs-bevy3d: GPU device lost ({reason:?}): {message}");
            flag.store(true, Ordering::SeqCst);
        });
        let info = adapter.get_info();
        log::info!("rnrs-bevy3d: {:?} {} ({})", info.backend, info.name, info.driver_info);
        Ok(Self { instance, adapter, device, queue, lost })
    }

    /// The objects Bevy is created with.
    pub fn parts(&self) -> crate::scene::Device<'_> {
        crate::scene::Device { instance: &self.instance, adapter: &self.adapter, device: &self.device, queue: &self.queue }
    }

    pub fn lost(&self) -> bool {
        self.lost.load(Ordering::SeqCst)
    }
}

impl Drop for Gpu {
    /// On the render thread, after the window and the Bevy app are gone. A stalled GPU keeps
    /// this thread (and its slot) retiring; nothing else waits for it.
    fn drop(&mut self) {
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
    }
}

/// The swapchain on one attachment. **Field order is drop order**: the wgpu surface (which
/// holds its own lease clone as the window handle source) before the admission lease.
pub struct Target {
    surface: wgpu::Surface<'static>,
    lease: WindowLease,
    config: wgpu::SurfaceConfiguration,
    view_format: wgpu::TextureFormat,
    blitter: wgpu::util::TextureBlitter,
    /// Whether the last configure allows acquires (always after a successful configure off iOS).
    acquire_allowed: bool,
}

/// Runs `f` under one admission on `lease`; None, without running `f`, once revoked.
fn admitted<R>(lease: &WindowLease, f: impl FnOnce() -> R) -> Option<R> {
    let _admission = lease.admit()?;
    Some(f())
}

impl Target {
    pub fn bind(gpu: &Gpu, lease: WindowLease, extent: Extent) -> Result<Self, String> {
        let admission = lease.clone();
        // iOS: the window's CAMetalLayer directly. It stays alive while `admission` is held, and
        // the Target drops the surface first.
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
        let format = [wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureFormat::Bgra8Unorm, wgpu::TextureFormat::Rgba8UnormSrgb, wgpu::TextureFormat::Bgra8UnormSrgb]
            .into_iter()
            .find(|f| caps.formats.contains(f))
            .ok_or_else(|| format!("the window offers no 8-bit RGBA/BGRA format: {:?}", caps.formats))?;
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
        let blitter = wgpu::util::TextureBlitterBuilder::new(&gpu.device, view_format).build();
        let mut target = Self { surface, lease: admission, config, view_format, blitter, acquire_allowed: false };
        target.configure(gpu)?;
        log::info!("rnrs-bevy3d: bound {}x{} {}", extent.width, extent.height, target.describe());
        Ok(target)
    }

    /// Configures under its own admission, with validation errors captured and returned. On iOS
    /// inside an explicit Core Animation transaction that restores the drawable timeout and
    /// reads it back; acquires are refused unless it is confirmed.
    fn configure(&mut self, gpu: &Gpu) -> Result<(), String> {
        let run = || {
            let scope = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
            self.surface.configure(&gpu.device, &self.config);
            match pollster::block_on(scope.pop()) {
                Some(e) => Err(format!("configure {}x{} {:?}: {e}", self.config.width, self.config.height, self.config.format)),
                None => Ok(()),
            }
        };
        let configured = admitted(&self.lease, || {
            #[cfg(target_os = "ios")]
            let configured = {
                let c = rnrs_surface::ios::configure_in_transaction(&self.lease, run);
                (c.result, c.acquire_allowed)
            };
            #[cfg(not(target_os = "ios"))]
            let configured = (run(), true);
            configured
        });
        let (result, allowed) = configured.unwrap_or_else(|| (Err("the attachment was revoked before configure".into()), false));
        self.acquire_allowed = allowed && result.is_ok();
        result
    }

    pub fn resize(&mut self, gpu: &Gpu, extent: Extent) -> Result<(), String> {
        self.config.width = extent.width;
        self.config.height = extent.height;
        self.configure(gpu)
    }

    pub fn describe(&self) -> String {
        format!("{:?} (view {:?}), alpha {:?}, {:?}", self.config.format, self.view_format, self.config.alpha_mode, self.config.present_mode)
    }

    /// Blits `source` (Bevy's finished frame, read through a non-sRGB view) onto a newly
    /// acquired swapchain image and presents it, admitting acquire and present separately.
    pub fn present(&mut self, gpu: &Gpu, source: &wgpu::TextureView) -> Result<(), PresentError> {
        use PresentError::{Fatal, Skipped};
        if gpu.lost() {
            return Err(Fatal("the GPU device was lost".into()));
        }
        if !self.acquire_allowed {
            return Err(Fatal(ACQUIRE_REFUSED.into()));
        }
        let acquired = admitted(&self.lease, || self.surface.get_current_texture()).ok_or_else(|| Skipped("revoked before acquire".into()))?;
        let frame = match acquired {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            wgpu::CurrentSurfaceTexture::Timeout => return Err(Skipped("acquire timed out".into())),
            wgpu::CurrentSurfaceTexture::Occluded => return Err(Skipped("occluded".into())),
            wgpu::CurrentSurfaceTexture::Outdated => {
                return match self.configure(gpu) {
                    Ok(()) => Err(Skipped("swapchain outdated; reconfigured".into())),
                    Err(e) => Err(Fatal(e)),
                }
            }
            wgpu::CurrentSurfaceTexture::Lost => return Err(Fatal("swapchain lost".into())),
            other => return Err(Fatal(format!("cannot acquire a swapchain image: {other:?}"))),
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor { format: Some(self.view_format), ..Default::default() });
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("rnrs-bevy3d blit") });
        self.blitter.copy(&gpu.device, &mut encoder, source, &view);
        // Admitted separately: after a revocation the acquired image is dropped unpresented.
        admitted(&self.lease, || {
            gpu.queue.submit([encoder.finish()]);
            gpu.queue.present(frame);
        })
        .ok_or_else(|| Skipped("revoked before present".into()))
    }
}
