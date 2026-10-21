//! Framework browser backend (handwritten, module-independent).
//!
//! The JS side (`packages/runtime/src/web-backend.ts`) constructs one [`RnrWebAdapter`] per
//! `(module, generation)`. Generated module glue converts values through [`WebEnv`], an
//! `Env` over `js_sys`. Native objects live in a slab here; their JS wrappers are plain
//! frozen objects that the JS side maps to `(slot, version)` through a module-private
//! WeakMap, so they cannot be forged, and a FinalizationRegistry releases the slot when a
//! wrapper is collected. Everything runs on the page's JS thread; futures are browser-local.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Accepts only ids that are exact integers in 1..=Number.MAX_SAFE_INTEGER, so fractions,
/// infinities and huge values never alias a valid operation.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn valid_operation_id(id: f64) -> bool {
    id.is_finite() && id.fract() == 0.0 && (1.0..=MAX_SAFE_INTEGER).contains(&id)
}

// The backend itself only exists for wasm32 (browser-local, !Send JS values).
#[cfg(target_arch = "wasm32")]
mod web;
#[cfg(target_arch = "wasm32")]
pub use web::*;

#[cfg(test)]
mod tests {
    use super::valid_operation_id;

    #[test]
    fn operation_ids_must_be_exact_safe_integers() {
        for id in [1.0, 2.0, MAX] {
            assert!(valid_operation_id(id), "{id}");
        }
        for id in [0.0, -0.0, -1.0, 0.5, 1.5, 1.000_000_000_001, f64::NAN, f64::INFINITY, -f64::INFINITY, MAX + 1.0, 2f64.powi(64), 1e300] {
            assert!(!valid_operation_id(id), "{id}");
        }
    }

    const MAX: f64 = 9_007_199_254_740_991.0;
}
