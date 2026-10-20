//! Main-thread browser scheduler. Same decoder, CPU raster, stats and renderer core.
use std::cell::RefCell;
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
use rnr_surface::{Extent, Surface, web_producer::{self, Pixels, Producer, Registration}};
use crate::{cpu::{CpuRaster, raster_geometry}, frame::{self, Cmd}, timing::{EventRing, Kind, browser_now}};
pub use crate::render_state::{GpuState, Stats};
static OPEN: AtomicUsize = AtomicUsize::new(0);
pub fn process_counts() -> (usize, usize) { (OPEN.load(Ordering::SeqCst), 0) }
pub fn note_closed() { OPEN.fetch_sub(1, Ordering::SeqCst); }

#[derive(Default)]
struct State {
    closed: bool,
    pending: Option<(Vec<u8>, f64, u32)>,
    id: u32,
    cmds: Vec<Cmd>,
    decoded: Vec<Cmd>,
    have_frame: bool,
    raster: Option<CpuRaster>,
    stats: Stats,
}
pub struct Shared {
    surface: Surface,
    scale: f32,
    state: RefCell<State>,
    registration: RefCell<Option<Registration>>,
    events: EventRing,
}
pub fn spawn_with(surface: &Surface, scale: f32, events: EventRing) -> Result<Arc<Shared>, String> {
    let shared = Arc::new(Shared { surface: surface.clone(), scale, state: RefCell::new(State::default()),
        registration: RefCell::new(None), events });
    let producer: Arc<dyn Producer> = shared.clone();
    // No JS key escapes until registration succeeds. Caller closes Surface on failure.
    let registration = web_producer::register(surface, &producer)?;
    *shared.registration.borrow_mut() = Some(registration);
    OPEN.fetch_add(1, Ordering::SeqCst);
    Ok(shared)
}
impl Shared {
    pub fn submit(&self, bytes: Vec<u8>) -> bool {
        let mut state = self.state.borrow_mut();
        if state.closed { return false; }
        state.id = state.id.wrapping_add(1);
        let id = state.id;
        let replaced = state.pending.replace((bytes, browser_now(), id));
        state.stats.frames_submitted += 1;
        state.stats.frames_replaced += replaced.is_some() as u64;
        self.events.record(Kind::Submit, id, 0);
        drop(state); drop(replaced);
        true
    }
    pub fn is_closed(&self) -> bool { self.state.borrow().closed }
    pub fn stats(&self) -> Stats { self.state.borrow().stats.clone() }
    pub fn drain_timings(&self) -> Vec<u8> { self.events.drain() }
    pub fn close(&self) -> bool {
        let old = {
            let mut state = self.state.borrow_mut();
            if state.closed { return false; }
            let mut replacement = State::default();
            replacement.closed = true;
            replacement.stats = state.stats.clone();
            replacement.stats.bound = None;
            replacement.stats.gpu = GpuState::None;
            std::mem::replace(&mut *state, replacement)
        };
        drop(old); // raster/commands/pending freed before the reservation/owner slot
        drop(self.registration.borrow_mut().take());
        true
    }
    fn configure_inner(&self, extent: Extent) -> Result<(), String> {
        let ((w,h), _) = raster_geometry(extent.width, extent.height, extent.scale, self.scale);
        let mut state = self.state.borrow_mut();
        if state.closed { return Err("renderer closed".into()); }
        if state.raster.as_ref().is_some_and(|r| r.size() == (w,h)) { return Ok(()); }
        drop(state.raster.take());
        state.stats.bound = None;
        let registration = self.registration.borrow();
        let registration = registration.as_ref().ok_or("renderer closed")?;
        registration.release_pixels();
        registration.reserve_pixels(w,h)?;
        state.raster = Some(CpuRaster::new(w as u16,h as u16));
        state.stats.bound = Some((w,h));
        state.stats.presentation = "canvas2d".into();
        state.stats.gpu = GpuState::Ready;
        Ok(())
    }
}
impl Drop for Shared { fn drop(&mut self) { self.close(); } }
impl Producer for Shared {
    fn configure(&self, extent: Extent) -> Result<(), String> {
        let result = self.configure_inner(extent);
        if let Err(error) = &result {
            let mut s = self.state.borrow_mut();
            s.stats.surface_errors += 1; s.stats.last_error = Some(error.clone());
        }
        result
    }
    fn detach(&self) {
        let mut state = self.state.borrow_mut();
        drop(state.raster.take());
        state.stats.bound = None;
        state.stats.gpu = GpuState::None;
        drop(state);
        if let Some(registration) = self.registration.borrow().as_ref() { registration.release_pixels(); }
    }
    fn render(&self, extent: Extent, redraw: bool) -> Result<Option<Pixels>, String> {
        if self.is_closed() { return Ok(None); }
        self.configure(extent)?;
        let mut state = self.state.borrow_mut();
        let mut fresh = None;
        if let Some((bytes, time, id)) = state.pending.take() {
            match frame::parse(&bytes, &mut state.decoded) {
                Ok(()) => {
                    let s = &mut *state;
                    std::mem::swap(&mut s.cmds, &mut s.decoded);
                    s.have_frame = true;
                    fresh = Some((time,id));
                }
                Err(error) => {
                    state.stats.frames_invalid += 1;
                    state.stats.last_error = Some(format!("invalid frame: {error}"));
                }
            }
        }
        if !state.have_frame || (!redraw && fresh.is_none()) { return Ok(None); }
        let started = browser_now();
        let (_, scale) = raster_geometry(extent.width, extent.height, extent.scale, self.scale);
        let s = &mut *state;
        let raster = s.raster.as_mut().ok_or("raster unavailable")?;
        raster.render(&s.cmds, scale);
        let (width,height) = raster.size();
        // Safe synchronous copy from a scoped Rust slice. No raw memory view, JS callback,
        // Rust Vec duplicate, or borrowed JS object survives this expression.
        let bytes = js_sys::Uint8Array::from(raster.pixels());
        s.stats.last.raster_ms = browser_now() - started;
        s.stats.frames_presented += 1; // CPU output delivered, not display scanout
        let id = fresh.map(|(_,id)| id).unwrap_or(s.id);
        if let Some((submitted,_)) = fresh { s.stats.last_submit_to_present_ms = browser_now() - submitted; }
        self.events.record(Kind::Present, id, self.surface.snapshot().attachment as u32);
        Ok(Some(Pixels { width, height, bytes }))
    }
}
