//! The comparison's operations exported directly with wasm-bindgen. Argument handling is
//! wasm-bindgen's own: f64 parameters take any JS value through ToNumber, bool parameters take
//! truthiness, and `&[f64]` copies an array-like into linear memory (Float64Array.set, ToNumber
//! per element). No strict validation: see the checked wrapper in web/main.ts.
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn nop() {}

#[wasm_bindgen]
pub fn add(a: f64, b: f64) -> f64 {
    a + b
}

#[wasm_bindgen]
pub fn flip(b: bool) -> bool {
    !b
}

/// Left-to-right sum, as the other implementations.
#[wasm_bindgen(js_name = arrSum)]
pub fn arr_sum(xs: &[f64]) -> f64 {
    let mut sum = 0.0;
    for x in xs {
        sum += x;
    }
    sum
}
