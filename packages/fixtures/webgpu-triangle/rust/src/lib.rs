//! Lab fixture for the optional browser WebGPU presentation of rnr-surface: Rust draws one
//! triangle with wgpu's WebGPU backend straight into the surface's canvas ([`gpu`]). No pixels
//! cross the bridge and there is no Canvas 2D fallback. Browser only.
//!
//! Ownership follows vello2d: each triangle's [`Core`] (GPU state plus surface) is registered
//! with the adapter generation's teardown scope before it reaches JS, so runtime teardown
//! closes it even while JS still holds it. Closing only drops objects; it never waits.
use std::sync::Arc;

use rnr_core::lifecycle::{Retire, TeardownScope};
use rnr_core::Native;
use rnr_surface::Surface;

pub mod rnr_interface;
use rnr_interface as spec;

#[cfg(target_arch = "wasm32")]
mod gpu;
#[cfg(not(target_arch = "wasm32"))]
mod gpu {
    //! Host builds only (cargo check): the fixture has no native presentation.
    use std::sync::Arc;
    pub struct Shared;
    impl Shared {
        pub fn new(_: &rnr_surface::Surface) -> Result<Arc<Self>, String> {
            Err("webgpu-triangle is a browser-only fixture".into())
        }
        pub fn close(&self) {}
        pub fn set_background(&self, _: f64, _: f64, _: f64) -> Result<bool, String> { Ok(false) }
        pub fn destroy_device_for_testing(&self) -> bool { false }
        pub fn stats(&self, _owned: bool) -> super::spec::TriangleStats { unreachable!("never constructed") }
    }
}

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
        let surface = Surface::new()?;
        let shared = match gpu::Shared::new(&surface) {
            Ok(shared) => shared,
            Err(error) => { surface.close(); return Err(error); }
        };
        let core = Arc::new(Core { shared, surface });
        // Registered before the triangle reaches JS; after teardown this retires it at once.
        if let Some(scope) = &self.scope {
            let retire: Arc<dyn Retire> = core.clone();
            scope.register(Arc::downgrade(&retire));
        }
        Ok(Native::new(Triangle { core, owned: self.scope.is_some() }))
    }
}

/// What teardown, `close()` and `Drop` close: the GPU state and the surface.
pub struct Core {
    shared: Arc<gpu::Shared>,
    surface: Surface,
}

impl Core {
    fn close(&self) {
        self.shared.close();
        self.surface.close();
    }
}

impl Retire for Core {
    fn retire(&self) {
        self.close();
    }
}

pub struct Triangle {
    core: Arc<Core>,
    owned: bool,
}

impl Drop for Triangle {
    fn drop(&mut self) {
        self.core.close();
    }
}

impl spec::Triangle for Triangle {
    fn surface_key(&self) -> Result<f64, String> {
        Ok(self.core.surface.key() as f64)
    }

    fn set_background(&self, r: f64, g: f64, b: f64) -> Result<bool, String> {
        self.core.shared.set_background(r, g, b)
    }

    fn stats(&self) -> Result<spec::TriangleStats, String> {
        Ok(self.core.shared.stats(self.owned))
    }

    fn destroy_device_for_testing(&self) -> Result<bool, String> {
        Ok(self.core.shared.destroy_device_for_testing())
    }

    fn close(&self) -> Result<(), String> {
        self.core.close();
        Ok(())
    }
}
