//! The Rust side of an rnrs module: everything a module crate needs, from one dependency.
//!
//! ```toml
//! [dependencies]
//! rnrs = "0.1"                                     # headless modules
//! rnrs = { version = "0.1", features = ["surface"] } # surfaces (the app installs @rnrs/surface)
//! rnrs = { version = "0.1", features = ["wgpu"] }    # wgpu renderers (rnrs::gpu)
//! ```
//!
//! Re-exports only: [`core`] is the framework's `rnrs-core` and [`surface`] its `rnrs-surface`,
//! the same crate instances the app bundle links (it patches both to the installed copies), so
//! types from here and from a direct `rnrs-core` dependency are identical. The generated
//! `rnr_interface.rs` of a crate depending on `rnrs` refers to `rnrs::core`.

pub use rnrs_core as core;
pub use rnrs_core::lifecycle::{Retire, TeardownScope};
pub use rnrs_core::{CancelToken, Cancelled, Native};

#[cfg(feature = "surface")]
pub use rnrs_surface as surface;

/// The wgpu adapter (feature `wgpu`): implement [`gpu::Renderer`] and create a [`gpu::GpuSurface`];
/// `rnrs::gpu::wgpu` is the exact wgpu version it uses, for pipelines and shaders.
#[cfg(feature = "wgpu")]
pub use rnrs_surface::gpu;
