//! Explicit exports retained by the generated application bundle.
use wasm_bindgen::prelude::*;
use crate::{Extent, web_host, web_producer};
fn key(n: f64) -> Result<u64, JsValue> {
    if n.is_finite() && n.fract() == 0.0 && (1.0..9007199254740992.0).contains(&n) {
        Ok(n as u64)
    } else { Err(JsValue::from_str("invalid surface key/token")) }
}
fn extent(w: f64, h: f64, scale: f64) -> Result<Extent, JsValue> {
    if ![w,h,scale].iter().all(|n| n.is_finite()) || w.fract() != 0.0 || h.fract() != 0.0 ||
       w < 0.0 || h < 0.0 || w > u32::MAX as f64 || h > u32::MAX as f64 || scale <= 0.0 || scale > f32::MAX as f64 {
        return Err(JsValue::from_str("invalid surface extent"));
    }
    Ok(Extent { width: w as u32, height: h as u32, scale: scale as f32 })
}
#[wasm_bindgen]
pub fn rnr_surface_attach(k: f64, w: f64, h: f64, scale: f64) -> Result<JsValue, JsValue> {
    Ok(match web_host::attach(key(k)?, extent(w,h,scale)?).map_err(|e| JsValue::from_str(&e))? {
        web_host::Attached::Closed => JsValue::from_str("closed"),
        web_host::Attached::Busy => JsValue::from_f64(0.0),
        web_host::Attached::Token(t) => JsValue::from_f64(t as f64),
    })
}
#[wasm_bindgen]
pub fn rnr_surface_resize(k: f64, t: f64, w: f64, h: f64, scale: f64) -> Result<JsValue, JsValue> {
    let status = web_host::resize(key(k)?,key(t)?,extent(w,h,scale)?).map_err(|e| JsValue::from_str(&e))?;
    Ok(JsValue::from_str(match status {
        web_host::Resized::Ok => "ok", web_host::Resized::Closed => "closed", web_host::Resized::Stale => "stale",
    }))
}
#[wasm_bindgen]
pub fn rnr_surface_detach(k: f64, t: f64) -> Result<(), JsValue> {
    web_host::detach(key(k)?,key(t)?); Ok(())
}
#[wasm_bindgen]
pub fn rnr_surface_render(k: f64, t: f64, redraw: bool) -> Result<JsValue, JsValue> {
    let result = web_producer::render(key(k)?,key(t)?,redraw).map_err(|e| JsValue::from_str(&e))?;
    let object = js_sys::Object::new();
    let status = match result {
        web_producer::Output::Closed => "closed",
        web_producer::Output::Stale => "stale",
        web_producer::Output::Unchanged => "unchanged",
        web_producer::Output::Gpu(outcome) => match outcome {
            web_producer::GpuOutcome::Pending => "pending",
            web_producer::GpuOutcome::Submitted => "submitted",
            web_producer::GpuOutcome::Unchanged => "unchanged",
            web_producer::GpuOutcome::Failed(reason) => {
                js_sys::Reflect::set(&object, &"reason".into(), &reason.into())?;
                "failed"
            }
        },
        web_producer::Output::Pixels(p) => {
            js_sys::Reflect::set(&object, &"width".into(), &p.width.into())?;
            js_sys::Reflect::set(&object, &"height".into(), &p.height.into())?;
            js_sys::Reflect::set(&object, &"pixels".into(), &p.bytes)?;
            "pixels"
        }
    };
    js_sys::Reflect::set(&object, &"status".into(), &status.into())?;
    Ok(object.into())
}

/// One pointer transition (touch.rs phase codes: 0 down, 1 move, 2 up, 3 cancel, 4 cancel all)
/// for attachment `t`. Positions are element-local physical pixels; `time_ms` is the
/// PointerEvent's `timeStamp` (milliseconds since `performance.timeOrigin`, truncated).
/// False if refused (not opted in, stale, closed, capacity or unknown pointer).
#[wasm_bindgen]
pub fn rnr_surface_touch(k: f64, t: f64, phase: u32, pointer: f64, x_px: f64, y_px: f64, time_ms: f64) -> Result<bool, JsValue> {
    let phase = i32::try_from(phase).ok().and_then(crate::touch::Phase::from_code).ok_or_else(|| JsValue::from_str("invalid touch phase"))?;
    if !(pointer.fract() == 0.0 && (i32::MIN as f64..=i32::MAX as f64).contains(&pointer)) {
        return Err(JsValue::from_str("invalid pointer id"));
    }
    let time_ms = if time_ms.is_finite() { time_ms.trunc().clamp(i64::MIN as f64, i64::MAX as f64) as i64 } else { 0 };
    Ok(web_host::touch(key(k)?, key(t)?, phase, pointer as i32, x_px as f32, y_px as f32, time_ms))
}
/// Touch diagnostics of surface `k`: [accepted, coalesced, refusedStale, refusedCapacity,
/// dropped, overflows, resets, active]; empty when the key matches no live surface.
#[wasm_bindgen]
pub fn rnr_surface_touch_counters(k: f64) -> Result<Vec<f64>, JsValue> {
    let Some(inner) = crate::lookup(key(k)?) else { return Ok(Vec::new()); };
    let (c, active) = crate::Surface { inner }.touch_counters();
    Ok([c.accepted, c.coalesced, c.refused_stale, c.refused_capacity, c.dropped, c.overflows, c.resets, active as u64]
        .iter().map(|n| *n as f64).collect())
}

#[wasm_bindgen]
pub fn rnr_surface_presentation(k: f64) -> Result<JsValue, JsValue> {
    Ok(JsValue::from_str(match web_producer::presentation(key(k)?) {
        None => "closed",
        Some(web_producer::Presentation::Canvas2d) => "canvas2d",
        Some(web_producer::Presentation::WebGpu) => "webgpu",
    }))
}
/// `canvas` is the host's HTMLCanvasElement for this attachment; only a WebGpu producer takes it.
#[wasm_bindgen]
pub fn rnr_surface_bind_canvas(k: f64, t: f64, canvas: JsValue) -> Result<JsValue, JsValue> {
    let bound = web_producer::bind_canvas(key(k)?, key(t)?, &canvas).map_err(|e| JsValue::from_str(&e))?;
    Ok(JsValue::from_str(match bound {
        web_producer::Bound::Ok => "ok", web_producer::Bound::Stale => "stale", web_producer::Bound::Closed => "closed",
    }))
}

#[wasm_bindgen]
pub fn rnr_surface_diagnostics() -> Vec<f64> {
    let (owners,pixels,entries) = web_producer::diagnostics();
    let live = { crate::registry().values().filter(|w| w.strong_count() > 0).count() };
    vec![live as f64, owners as f64, pixels as f64, entries as f64]
}
/// Called by generated startup to retain these exports in the SAME cdylib as adapters.
pub fn keep_exports() {
    std::hint::black_box([
        rnr_surface_attach as *const (), rnr_surface_resize as *const (),
        rnr_surface_detach as *const (), rnr_surface_render as *const (),
        rnr_surface_diagnostics as *const (), rnr_surface_set_release_listener as *const (),
        rnr_surface_presentation as *const (), rnr_surface_bind_canvas as *const (),
        rnr_surface_touch as *const (), rnr_surface_touch_counters as *const (),
    ]);
}

thread_local! {
    static RELEASE_LISTENER: std::cell::RefCell<Option<js_sys::Function>> = const { std::cell::RefCell::new(None) };
}
#[wasm_bindgen]
pub fn rnr_surface_set_release_listener(listener: Option<js_sys::Function>) {
    RELEASE_LISTENER.with(|slot| { *slot.borrow_mut() = listener; });
}
pub(crate) fn released(key: u64, token: u64) {
    let listener = RELEASE_LISTENER.with(|slot| slot.borrow().clone());
    if let Some(listener) = listener {
        // Framework callback only queues retries. No Surface/index lock or borrow held.
        let _ = listener.call2(&JsValue::UNDEFINED, &JsValue::from_f64(key as f64), &JsValue::from_f64(token as f64));
    }
}
