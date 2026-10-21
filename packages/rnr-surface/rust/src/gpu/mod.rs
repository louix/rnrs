//! The wgpu adapter (feature `wgpu`): a renderer implements [`Renderer`]; [`GpuSurface`] owns
//! the surface, the render loop, the device, the swapchain and the window lease, and calls the
//! renderer's hooks. Android (Vulkan), iOS (Metal) and the browser (WebGPU, no fallback) share
//! this API; nothing platform-specific reaches the renderer.
//!
//! ```ignore
//! struct Triangle;
//! impl gpu::Renderer for Triangle {
//!     type State = wgpu::Color;                // latest value from JS (set_state)
//!     type Resources = wgpu::RenderPipeline;   // per device and swapchain format
//!     fn create(&mut self, gpu: &gpu::Gpu, target: &gpu::TargetInfo) -> Result<Self::Resources, String> {
//!         Ok(pipeline(&gpu.device, target.format))
//!     }
//!     fn draw(&mut self, pipeline: &mut Self::Resources, frame: &mut gpu::Frame<'_>, bg: &wgpu::Color) -> Result<gpu::Next, String> {
//!         let mut pass = frame.encoder.begin_render_pass(&clear(frame.view, *bg));
//!         pass.set_pipeline(pipeline);
//!         pass.draw(0..3, 0..1);
//!         Ok(gpu::Next::Wait)
//!     }
//! }
//! // Module::create: GpuSurface::spawn(&scope, Options::default(), wgpu::Color::BLACK, || Triangle)?
//! ```
//!
//! # Lifecycle (both platforms)
//! - The surface is registered with the runtime teardown scope before its key reaches JS; an RN
//!   reload, [`GpuSurface::close`] or dropping the last handle closes it. Closing never waits.
//! - Each attachment (a platform window, or a browser canvas) gets new [`Renderer::Resources`]:
//!   [`Renderer::create`] after the swapchain is configured, then [`Renderer::resized`]; again
//!   [`Renderer::resized`] on every size change. They are dropped when the attachment ends,
//!   before the swapchain, and the swapchain before the window lease.
//! - A failure (a hook's error, a validation error, a lost swapchain or device) ends rendering
//!   for that attachment: the error is kept in [`Status::last_error`] and there is no retry; a
//!   new attachment gets one fresh attempt. A lost device is dropped (after the resources and
//!   swapchain) and replaced on the next attachment. Nothing falls back to another backend.
//! - A device lost while nothing is being drawn (after [`Next::Wait`], nothing changing) is
//!   noticed at the next wake of the render loop (a state change, attach, resize, detach or
//!   close): until then [`Status::gpu`] still reads `Ready`. (Browser: at the next frame the
//!   host requests, i.e. the next `requestAnimationFrame` while attached.)
//! - A zero-sized attachment counts as no attachment: its resources and swapchain are dropped,
//!   and a later non-zero size builds new ones ([`Renderer::create`] again), like a re-attach.
//! - Natively, the render thread drops the device after waiting for its submitted work; a GPU
//!   that never finishes keeps that thread, and its slot of [`MAX_RENDER_THREADS`], forever
//!   (the cap is process-wide and stays bounded: a new surface beyond it fails at once). Close
//!   and drop never wait for it.
//! - Hooks never run under a lock of this adapter, of rnr-surface or of the host: a hook may
//!   call [`GpuSurface::set_state`] or [`GpuSurface::close`].
//!
//! # Frames
//! [`Renderer::draw`] records into [`Frame::encoder`] targeting [`Frame::view`]; the adapter
//! submits and presents. After [`Next::Wait`] the next frame is drawn only after a change (new
//! state, attach, resize); after [`Next::Animate`] it is drawn again, at most
//! [`Options::max_frame_rate`] per second natively (a fixed cap, whatever the presentation mode
//! does) and once per `requestAnimationFrame` in the browser.
//!
//! # Retained handles
//! wgpu handles are reference-counted clones; the adapter cannot stop a renderer from keeping a
//! clone of [`Frame::view`], the device or the queue. The adapter owns one invariant: the wgpu
//! surface is dropped before the window lease (on Android the surface also holds a lease clone
//! as its window-handle source; on iOS it uses the lease's `CAMetalLayer`), and neither is ever
//! handed to the renderer. Everything else rests on wgpu's safe-API guarantee (wgpu 30.0.1):
//! - wgpu-core snatches a presented or discarded surface texture under the device's exclusive
//!   snatch lock (`present.rs` 340, 399); a retained view then fails `TextureView::try_raw`'s
//!   check of its parent (`resource.rs` 1984) and is an error when used, never a dangling access.
//! - No backend's view refers to the window or the wgpu surface: Vulkan's holds raw `vk` handles
//!   (`hal::vulkan::TextureView`), Metal's a retained `MTLTexture` (`hal::metal::TextureView`),
//!   the browser's a `GPUTextureView` object, so no retained clone keeps a window alive.
//! - Unlike ordinary textures (whose views wgpu destroys with them), a retained view of a
//!   surface texture keeps its own view object (Vulkan: a `VkImageView`) until the clone is
//!   dropped, which can be after the swapchain is gone; destroying it then is wgpu's
//!   responsibility, not this adapter's.
//! Keep GPU objects in [`Renderer::Resources`] and nothing from a [`Frame`] beyond `draw`.
use rnr_core::bind::MaybeSend;

use crate::touch::TouchRecord;
use crate::Extent;

pub use wgpu;

#[cfg(not(target_arch = "wasm32"))]
mod driver;
#[cfg(not(target_arch = "wasm32"))]
mod native;
#[cfg(not(target_arch = "wasm32"))]
pub use native::MAX_RENDER_THREADS;
#[cfg(not(target_arch = "wasm32"))]
pub use native::GpuSurface;
#[cfg(target_arch = "wasm32")]
mod web;
#[cfg(target_arch = "wasm32")]
pub use web::GpuSurface;

/// What a renderer gets to build with: the adapter and the device (and its queue).
pub struct Gpu {
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    pub(crate) instance: wgpu::Instance,
    /// First device loss or uncaptured error, written by wgpu callbacks.
    pub(crate) fault: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}

impl Gpu {
    pub(crate) fn fault(&self) -> Option<String> {
        self.fault.lock().ok().and_then(|f| f.clone())
    }

    /// Records device loss and uncaptured errors (logged once each, kept as the fault).
    pub(crate) fn watch(device: &wgpu::Device, label: &'static str) -> std::sync::Arc<std::sync::Mutex<Option<String>>> {
        let fault = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
        let lost = fault.clone();
        device.set_device_lost_callback(move |reason, message| {
            log::error!("{label}: GPU device lost ({reason:?}): {message}");
            if let Ok(mut f) = lost.lock() {
                f.get_or_insert(format!("device lost ({reason:?}): {message}"));
            }
        });
        let errors = fault.clone();
        device.on_uncaptured_error(std::sync::Arc::new(move |error| {
            log::error!("{label}: wgpu error: {error}");
            if let Ok(mut f) = errors.lock() {
                f.get_or_insert(format!("GPU error: {error}"));
            }
        }));
        fault
    }
}

/// The swapchain a renderer draws into (fixed for one attachment).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TargetInfo {
    /// The swapchain (and view) format: 8-bit RGBA or BGRA, non-sRGB; in the browser, the
    /// browser's preferred canvas format.
    pub format: wgpu::TextureFormat,
}

/// One frame to draw: record into `encoder`, targeting `view`. Valid only during
/// [`Renderer::draw`].
pub struct Frame<'a> {
    pub device: &'a wgpu::Device,
    pub queue: &'a wgpu::Queue,
    pub view: &'a wgpu::TextureView,
    pub encoder: &'a mut wgpu::CommandEncoder,
    pub format: wgpu::TextureFormat,
    pub extent: Extent,
}

/// When to draw again after a frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    /// After the next change only (state, attach, resize).
    Wait,
    /// Continuously, paced by the adapter.
    Animate,
}

/// The renderer: its hooks run on the render thread (natively) or the main thread (browser),
/// never under an adapter, surface or host lock.
pub trait Renderer: 'static {
    /// The latest value set from JS ([`GpuSurface::set_state`]); the newest replaces older
    /// ones and [`Renderer::draw`] sees the latest.
    type State: MaybeSend + 'static;
    /// GPU objects for one attachment: created, used and dropped by the adapter's thread.
    type Resources: 'static;
    /// After the swapchain is configured for a new attachment.
    fn create(&mut self, gpu: &Gpu, target: &TargetInfo) -> Result<Self::Resources, String>;
    /// After [`Renderer::create`] and after every size change, before the next draw: rebuild
    /// size-dependent resources here.
    fn resized(&mut self, _resources: &mut Self::Resources, _gpu: &Gpu, _extent: Extent) -> Result<(), String> {
        Ok(())
    }
    fn draw(&mut self, resources: &mut Self::Resources, frame: &mut Frame<'_>, state: &Self::State) -> Result<Next, String>;
    /// Touch records (rnr_surface::touch) since the last call, with [`Options::touch`]; called
    /// on every wake, also while detached or paused, so resets arrive promptly.
    fn touch(&mut self, _records: &[TouchRecord]) {}
}

/// Adapter options.
#[derive(Clone, Copy, Debug)]
pub struct Options {
    /// Used in logs and as the device label.
    pub label: &'static str,
    /// Deliver touches to [`Renderer::touch`] (the view also needs `touchInput="rust"`).
    pub touch: bool,
    /// The native cap for [`Next::Animate`] and for redraws, in frames per second (1 to 240).
    pub max_frame_rate: u32,
}

impl Default for Options {
    fn default() -> Self {
        Self { label: "rnr-gpu", touch: false, max_frame_rate: 60 }
    }
}

/// The surface's attachment.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SurfaceState {
    #[default]
    Detached,
    Attached,
    Closed,
}

/// The GPU side of the current attachment.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum GpuState {
    #[default]
    None,
    /// Device or swapchain setup in progress (asynchronous in the browser).
    Initializing,
    Ready,
    /// Terminal for the attachment; see [`Status::last_error`].
    Failed,
}

impl SurfaceState {
    pub fn name(self) -> &'static str {
        match self {
            Self::Detached => "detached",
            Self::Attached => "attached",
            Self::Closed => "closed",
        }
    }
}

impl GpuState {
    pub fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Initializing => "initializing",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
}

/// Counters and state, for diagnostics and stats.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Status {
    pub state: SurfaceState,
    pub gpu: GpuState,
    /// The attached size (zero while detached).
    pub width: u32,
    pub height: u32,
    /// Frames submitted and presented (GPU work queued; not proof of display).
    pub frames_presented: u64,
    /// Frames not drawn this time (acquire timeout, occluded, outdated swapchain).
    pub presents_skipped: u64,
    /// Attachments whose setup started, and (browser) setups discarded because their attachment
    /// had already ended.
    pub setups_started: u64,
    pub setups_discarded: u64,
    pub device_losses: u64,
    /// Platform detaches that returned before the adapter released the window (rnr-surface's
    /// bounded wait; always 0 in the browser).
    pub detach_timeouts: u64,
    /// Adapter name, labelled when it is a software (fallback) adapter.
    pub adapter: String,
    /// Swapchain format, alpha mode and present mode ("" until ready).
    pub presentation: String,
    pub last_error: Option<String>,
}

pub(crate) fn adapter_label(info: &wgpu::AdapterInfo) -> String {
    let name = if info.name.is_empty() { "unnamed" } else { &info.name };
    if info.device_type == wgpu::DeviceType::Cpu {
        format!("{name} (fallback adapter: software)")
    } else {
        format!("{name} ({:?})", info.backend)
    }
}

pub(crate) fn describe(config: &wgpu::SurfaceConfiguration) -> String {
    format!("{:?} {:?} {:?}", config.format, config.alpha_mode, config.present_mode)
}
