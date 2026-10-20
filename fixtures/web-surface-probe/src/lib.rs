//! Stateless compile/pixel feasibility only. No production surface or registry.
#[path = "../../../packages/vello2d/rust/src/frame.rs"]
mod frame;
mod shared_draw {
    include!(concat!(env!("OUT_DIR"), "/draw.rs"));
}
#[cfg(not(probe_cpu_extracted))]
use vello_cpu::{Level, Pixmap, RasterizerSettings, RenderContext, RenderMode, RenderSettings, Resources};
use wasm_bindgen::prelude::*;

const MAX_PIXELS: u32 = 4_194_304;

#[wasm_bindgen]
pub fn raster(bytes: &[u8], width: u32, height: u32, scale: f64) -> Result<Vec<u8>, JsValue> {
    let bad = |s: &str| JsValue::from_str(s);
    if width == 0 || height == 0 || width > 4096 || height > 4096
        || width.checked_mul(height).filter(|&p| p <= MAX_PIXELS).is_none() {
        return Err(bad("extent exceeds probe bounds"));
    }
    if !scale.is_finite() || scale <= 0.0 || scale > 16.0 {
        return Err(bad("invalid probe scale"));
    }
    let mut commands = Vec::new();
    frame::parse(bytes, &mut commands).map_err(|e| bad(&e))?;
    #[cfg(probe_cpu_extracted)]
    {
        let mut raster = shared_draw::CpuRaster::new(width as u16, height as u16);
        raster.render(&commands, scale);
        return Ok(raster.pixels().to_vec());
    }
    #[cfg(not(probe_cpu_extracted))]
    {
    let settings = RenderSettings { level: Level::baseline(), num_threads: 0 };
    let mut context = RenderContext::new_with(width as u16, height as u16, settings);
    let mut pixels = Pixmap::new(width as u16, height as u16);
    shared_draw::draw(&mut context, &commands, width, height, scale);
    context.render_with(&mut pixels, &mut Resources::new(),
        RasterizerSettings { render_mode: RenderMode::OptimizeSpeed, ..Default::default() });
    Ok(pixels.data_as_u8_slice().to_vec())
    }
}

#[wasm_bindgen]
pub fn raster_mode() -> String {
    if cfg!(probe_cpu_extracted) { "extracted-CpuRaster-try_detect" } else { "baseline-shared-draw" }.into()
}

