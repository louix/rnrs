//! Staged wasm-only weak producer index; Surface/Inner remains lifecycle authority.
//! Declare this module only on wasm32 (and host tests). No JS objects, waits or unsafe
//! Send/Sync. Resource guards stay on the creating thread and outlive their raster.
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Weak};
use crate::{Extent, Surface};

pub const MAX_PRODUCERS: usize = 4;
pub const MAX_PIXELS: u64 = 4_194_304;
pub const MAX_TOTAL_PIXELS: u64 = 8_388_608;

pub struct Pixels {
    pub width: u32,
    pub height: u32,
    #[cfg(not(target_arch = "wasm32"))]
    pub bytes: Vec<u8>,
    #[cfg(target_arch = "wasm32")]
    pub bytes: js_sys::Uint8Array,
}
/// How a producer's output reaches the page. Fixed for the producer's lifetime: a DOM
/// canvas holds one context type, so the host picks the context once per mount.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presentation {
    /// Owned RGBA pixels returned by `render`, drawn by the host with Canvas 2D.
    Canvas2d,
    /// The producer draws into the attached canvas itself (WebGPU); no pixels cross the bridge.
    WebGpu,
}
/// The canvas handed to a `WebGpu` producer: an `HTMLCanvasElement` on wasm32.
#[cfg(target_arch = "wasm32")]
pub type Canvas = wasm_bindgen::JsValue;
#[cfg(not(target_arch = "wasm32"))]
pub type Canvas = ();
/// Result of one GPU render call. `Submitted` means GPU work was submitted for the canvas
/// texture; it is not evidence that anything reached the display.
#[derive(Debug, PartialEq, Eq)]
pub enum GpuOutcome {
    /// Device or surface setup still in progress for this attachment; nothing drawn.
    Pending,
    Submitted,
    /// Nothing new to draw (no redraw requested, or no texture this time).
    Unchanged,
    /// Terminal for this attachment (unsupported, device lost, validation). The host reports
    /// it once and does not retry until an explicit reattach.
    Failed(String),
}
pub trait Producer {
    /// Called only after checking the authoritative Surface attachment. Return an
    /// owned copy, or None when unchanged. Must not reenter the bridge.
    fn render(&self, extent: Extent, redraw: bool) -> Result<Option<Pixels>, String>;
    fn configure(&self, _extent: Extent) -> Result<(), String> { Ok(()) }
    fn detach(&self) {}
    fn presentation(&self) -> Presentation { Presentation::Canvas2d }
    /// `WebGpu` producers: start presenting attachment `token` into `canvas`. Called after the
    /// authority check. Setup may finish asynchronously; it must then recheck that `token` is
    /// still the producer's current attachment, and drop what it built otherwise.
    fn bind_canvas(&self, _token: u64, _canvas: &Canvas, _extent: Extent) -> Result<(), String> {
        Err("producer does not present to a GPU canvas".into())
    }
    /// `WebGpu` producers: draw attachment `token`. Called after the authority check.
    fn render_gpu(&self, _token: u64, _extent: Extent, _redraw: bool) -> Result<GpuOutcome, String> {
        Err("producer does not present to a GPU canvas".into())
    }
}
pub enum Output {
    Closed,
    Stale,
    Unchanged,
    Pixels(Pixels),
    Gpu(GpuOutcome),
}
#[derive(Debug, PartialEq, Eq)]
pub enum Bound { Ok, Stale, Closed }
#[derive(Default)]
struct Budget { owners: usize, pixels: u64 }
struct Entry { producer: Weak<dyn Producer>, registration: std::rc::Weak<()> }
thread_local! {
    static INDEX: RefCell<HashMap<u64, Entry>> = RefCell::new(HashMap::new());
    static BUDGET: RefCell<Budget> = RefCell::new(Budget::default());
}

/// Held by a renderer, not by the weak lookup. Drop raster memory before this guard.
/// Removing a stale/closed index entry never releases a live owner's reservation.
pub struct Registration {
    key: u64,
    identity: Rc<()>, // registration identity and !Send/!Sync marker, not attachment state
    pixels: Cell<u64>,
}

pub fn register(surface: &Surface, producer: &Arc<dyn Producer>) -> Result<Registration, String> {
    if surface.snapshot().closed { return Err("surface closed".into()); }
    let key = surface.key();
    let duplicate = INDEX.with(|index| index.borrow().get(&key).and_then(|entry| entry.producer.upgrade()).is_some());
    if duplicate { return Err("surface already has a producer".into()); }
    BUDGET.with(|budget| {
        let mut budget = budget.borrow_mut();
        if budget.owners >= MAX_PRODUCERS { return Err("browser producer limit reached".to_string()); }
        budget.owners += 1;
        Ok(())
    })?;
    let weak = Arc::downgrade(producer);
    let identity = Rc::new(());
    INDEX.with(|index| { index.borrow_mut().insert(key, Entry { producer: weak, registration: Rc::downgrade(&identity) }); });
    Ok(Registration { key, identity, pixels: Cell::new(0) })
}
impl Registration {
    /// Allocate only AFTER this succeeds. Before resize, free old raster, then call
    /// release_pixels. Reservation failures never silently grow aggregate storage.
    pub fn reserve_pixels(&self, width: u32, height: u32) -> Result<(), String> {
        let surface = crate::lookup(self.key).map(|inner| Surface { inner }).ok_or("unknown surface")?;
        if surface.snapshot().closed { return Err("surface closed".into()); }
        if self.pixels.get() != 0 { return Err("release old raster before reserving".into()); }
        let pixels = u64::from(width).checked_mul(u64::from(height)).ok_or("pixel overflow")?;
        if width > 4096 || height > 4096 || pixels > MAX_PIXELS {
            return Err("browser raster limit exceeded".into());
        }
        BUDGET.with(|budget| {
            let mut budget = budget.borrow_mut();
            let total = budget.pixels.checked_add(pixels).ok_or("aggregate pixel overflow")?;
            if total > MAX_TOTAL_PIXELS { return Err("browser raster budget exhausted".into()); }
            budget.pixels = total;
            self.pixels.set(pixels);
            Ok(())
        })
    }
    /// Caller must free its old raster before releasing its reservation.
    pub fn release_pixels(&self) {
        let pixels = self.pixels.replace(0);
        BUDGET.with(|budget| { budget.borrow_mut().pixels -= pixels; });
    }
    /// Called on close as well as Drop; resource accounting remains until release/drop.
    pub fn unregister(&self) {
        INDEX.with(|index| {
            let mut index = index.borrow_mut();
            if index.get(&self.key).is_some_and(|entry| entry.registration.ptr_eq(&Rc::downgrade(&self.identity))) {
                index.remove(&self.key);
            }
        });
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.unregister();
        self.release_pixels();
        BUDGET.with(|budget| { budget.borrow_mut().owners -= 1; });
    }
}
pub fn remove(key: u64) { INDEX.with(|index| { index.borrow_mut().remove(&key); }); }

// Only called after the authoritative key/token check. Never return a map borrow.
pub(crate) fn producer(key: u64) -> Option<Arc<dyn Producer>> {
    INDEX.with(|index| index.borrow().get(&key).and_then(|entry| entry.producer.upgrade()))
}

/// The presentation of the producer registered for `key`; None when closed or unknown.
pub fn presentation(key: u64) -> Option<Presentation> {
    let surface = crate::lookup(key).map(|inner| Surface { inner })?;
    if surface.snapshot().closed { return None; }
    producer(key).map(|p| p.presentation())
}

/// Hands the host's canvas to the `WebGpu` producer of the current attachment `token`.
pub fn bind_canvas(key: u64, token: u64, canvas: &Canvas) -> Result<Bound, String> {
    let Some(inner) = crate::lookup(key) else { return Ok(Bound::Closed); };
    let surface = Surface { inner };
    let snapshot = surface.snapshot();
    if snapshot.closed { return Ok(Bound::Closed); }
    if token == 0 || snapshot.attachment != token || snapshot.extent.is_empty() { return Ok(Bound::Stale); }
    let Some(producer) = producer(key) else { return Ok(Bound::Closed); };
    if producer.presentation() != Presentation::WebGpu {
        return Err("surface producer presents with Canvas 2D, not a GPU canvas".into());
    }
    producer.bind_canvas(token, canvas, snapshot.extent)?;
    let after = surface.snapshot();
    if after.closed { return Ok(Bound::Closed); }
    if after.attachment != token { return Ok(Bound::Stale); }
    Ok(Bound::Ok)
}

pub fn render(key: u64, token: u64, redraw: bool) -> Result<Output, String> {
    // The authoritative registry is checked BEFORE consulting the producer index.
    let Some(inner) = crate::lookup(key) else {
        INDEX.with(|index| { index.borrow_mut().remove(&key); });
        return Ok(Output::Closed);
    };
    let surface = Surface { inner };
    let snapshot = surface.snapshot();
    if snapshot.closed {
        INDEX.with(|index| { index.borrow_mut().remove(&key); });
        return Ok(Output::Closed);
    }
    if token == 0 || snapshot.attachment != token || snapshot.extent.is_empty() {
        return Ok(Output::Stale);
    }
    let producer = INDEX.with(|index| {
        let mut index = index.borrow_mut();
        let producer = index.get(&key).and_then(|entry| entry.producer.upgrade());
        if producer.is_none() { index.remove(&key); }
        producer
    });
    let Some(producer) = producer else { return Ok(Output::Closed); };
    if producer.presentation() == Presentation::WebGpu {
        let outcome = producer.render_gpu(token, snapshot.extent, redraw)?;
        let after = surface.snapshot();
        if after.closed { return Ok(Output::Closed); }
        if after.attachment != token { return Ok(Output::Stale); }
        return Ok(Output::Gpu(outcome));
    }
    // No registry borrow/lock held across renderer code or output destruction.
    let result = producer.render(snapshot.extent, redraw)?;
    // Defensive postcheck: even a mistakenly reentrant producer cannot return pixels
    // to an attachment that it closed or replaced while rasterizing.
    let after = surface.snapshot();
    if after.closed {
        INDEX.with(|index| { index.borrow_mut().remove(&key); });
        return Ok(Output::Closed);
    }
    if after.attachment != token || after.extent != snapshot.extent { return Ok(Output::Stale); }
    match result {
        None => Ok(Output::Unchanged),
        Some(pixels) => {
            #[cfg(target_arch = "wasm32")]
            let len = pixels.bytes.length() as usize;
            #[cfg(not(target_arch = "wasm32"))]
            let len = pixels.bytes.len();
            let count = u64::from(pixels.width) * u64::from(pixels.height);
            if pixels.width == 0 || pixels.height == 0 || pixels.width > 4096 || pixels.height > 4096 ||
                count > MAX_PIXELS || count * 4 != len as u64 {
                return Err("invalid browser pixel output".into());
            }
            #[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
            if pixels.bytes.chunks_exact(4).any(|pixel| pixel[3] != 255) {
                return Err("browser baseline requires opaque pixels".into());
            }
            Ok(Output::Pixels(pixels))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake { calls: Cell<usize> }
    impl Producer for Fake {
        fn render(&self, _: Extent, _: bool) -> Result<Option<Pixels>, String> {
            self.calls.set(self.calls.get() + 1);
            Ok(Some(Pixels { width: 1, height: 1, bytes: vec![255, 0, 0, 255] }))
        }
    }
    // Tests set existing Surface state directly, avoiding native windows/waits. These
    // are NOT implementations of the pending wasm attach API.
    fn attach(surface: &Surface, token: u64) {
        let mut state = surface.inner.lock();
        state.attachment = token;
        state.extent = Extent { width: 1, height: 1, scale: 1.0 };
    }
    fn fake() -> Arc<Fake> { Arc::new(Fake { calls: Cell::new(0) }) }
    fn erased(producer: &Arc<Fake>) -> Arc<dyn Producer> { producer.clone() }

    #[test]
    fn stale_token_and_closed_key_never_dispatch_and_closed_lookup_prunes() {
        let surface = Surface::new().unwrap();
        let producer = fake();
        let guard = register(&surface, &erased(&producer)).unwrap();
        attach(&surface, 10);
        assert!(matches!(render(surface.key(), 9, false).unwrap(), Output::Stale));
        assert_eq!(producer.calls.get(), 0);
        match render(surface.key(), 10, false).unwrap() {
            Output::Pixels(pixels) => assert_eq!(pixels.bytes, [255, 0, 0, 255]),
            _ => panic!("expected pixels"),
        }
        surface.close();
        assert!(matches!(render(surface.key(), 10, false).unwrap(), Output::Closed));
        assert_eq!(producer.calls.get(), 1);
        assert!(!INDEX.with(|index| index.borrow().contains_key(&surface.key())));
        // Pruning a closed entry did not release still-owned resources.
        assert_eq!(BUDGET.with(|b| b.borrow().owners), 1);
        drop(guard);
        assert_eq!(BUDGET.with(|b| b.borrow().owners), 0);
    }
    #[test]
    fn gpu_producer_gets_bind_and_render_only_for_the_current_attachment() {
        struct Gpu { bound: Cell<u64>, renders: Cell<usize> }
        impl Producer for Gpu {
            fn render(&self, _: Extent, _: bool) -> Result<Option<Pixels>, String> { panic!("no pixel path") }
            fn presentation(&self) -> Presentation { Presentation::WebGpu }
            fn bind_canvas(&self, token: u64, _: &Canvas, _: Extent) -> Result<(), String> { self.bound.set(token); Ok(()) }
            fn render_gpu(&self, token: u64, _: Extent, _: bool) -> Result<GpuOutcome, String> {
                self.renders.set(self.renders.get() + 1);
                Ok(if token == self.bound.get() { GpuOutcome::Submitted } else { GpuOutcome::Pending })
            }
        }
        let surface = Surface::new().unwrap();
        let gpu = Arc::new(Gpu { bound: Cell::new(0), renders: Cell::new(0) });
        let dynamic: Arc<dyn Producer> = gpu.clone();
        let guard = register(&surface, &dynamic).unwrap();
        assert_eq!(presentation(surface.key()), Some(Presentation::WebGpu));
        attach(&surface, 20);
        assert_eq!(bind_canvas(surface.key(), 19, &()).unwrap(), Bound::Stale);
        assert!(matches!(render(surface.key(), 19, true).unwrap(), Output::Stale));
        assert_eq!((gpu.bound.get(), gpu.renders.get()), (0, 0));
        assert_eq!(bind_canvas(surface.key(), 20, &()).unwrap(), Bound::Ok);
        assert!(matches!(render(surface.key(), 20, true).unwrap(), Output::Gpu(GpuOutcome::Submitted)));
        surface.close();
        assert_eq!(presentation(surface.key()), None);
        assert_eq!(bind_canvas(surface.key(), 20, &()).unwrap(), Bound::Closed);
        assert_eq!(gpu.renders.get(), 1);
        drop(guard);

        // A Canvas 2D producer never receives a canvas.
        let surface = Surface::new().unwrap();
        let producer = fake();
        let guard = register(&surface, &erased(&producer)).unwrap();
        attach(&surface, 21);
        assert_eq!(presentation(surface.key()), Some(Presentation::Canvas2d));
        assert!(bind_canvas(surface.key(), 21, &()).unwrap_err().contains("Canvas 2D"));
        drop(guard);
    }
    #[test]
    fn dead_weak_entry_is_pruned_without_calling_a_producer() {
        let surface = Surface::new().unwrap();
        let producer = fake();
        let guard = register(&surface, &erased(&producer)).unwrap();
        attach(&surface, 11);
        drop(producer);
        assert!(matches!(render(surface.key(), 11, true).unwrap(), Output::Closed));
        assert!(!INDEX.with(|index| index.borrow().contains_key(&surface.key())));
        drop(guard);
    }
    #[test]
    fn resource_caps_and_resize_failure_do_not_overreserve() {
        let mut owners = Vec::new();
        for _ in 0..MAX_PRODUCERS {
            let surface = Surface::new().unwrap();
            let producer = fake();
            let guard = register(&surface, &erased(&producer)).unwrap();
            owners.push((surface, producer, guard));
        }
        assert!(register(&Surface::new().unwrap(), &erased(&fake())).is_err());
        owners[0].2.reserve_pixels(2048, 2048).unwrap();
        owners[1].2.reserve_pixels(2048, 2048).unwrap();
        assert!(owners[2].2.reserve_pixels(1, 1).is_err());
        assert!(owners[0].2.reserve_pixels(1, 1).is_err());
        assert_eq!(BUDGET.with(|b| b.borrow().pixels), MAX_TOTAL_PIXELS);
        owners[0].2.release_pixels();
        assert!(owners[0].2.reserve_pixels(u32::MAX, u32::MAX).is_err());
        owners[2].2.reserve_pixels(1, 1).unwrap();
        assert_eq!(BUDGET.with(|b| b.borrow().pixels), MAX_PIXELS + 1);
        drop(owners);
        assert_eq!(BUDGET.with(|b| (b.borrow().owners, b.borrow().pixels)), (0, 0));
    }
    #[test]
    fn duplicate_registration_refused_and_unregister_is_idempotent() {
        let surface = Surface::new().unwrap();
        let producer = fake();
        let guard = register(&surface, &erased(&producer)).unwrap();
        assert!(register(&surface, &erased(&producer)).is_err());
        guard.unregister(); guard.unregister();
        drop(guard);
        assert_eq!(BUDGET.with(|b| b.borrow().owners), 0);
    }
    #[test]
    fn producer_can_change_index_and_drop_guards_during_render() {
        struct Reentrant { guard: RefCell<Option<Registration>> }
        impl Producer for Reentrant {
            fn render(&self, _: Extent, _: bool) -> Result<Option<Pixels>, String> {
                drop(self.guard.borrow_mut().take());
                let temporary = Surface::new()?;
                let producer: Arc<dyn Producer> = fake();
                let registration = register(&temporary, &producer)?;
                registration.unregister();
                drop(registration);
                Ok(None)
            }
        }
        let surface = Surface::new().unwrap();
        let producer = Arc::new(Reentrant { guard: RefCell::new(None) });
        let erased: Arc<dyn Producer> = producer.clone();
        *producer.guard.borrow_mut() = Some(register(&surface, &erased).unwrap());
        attach(&surface, 13);
        assert!(matches!(render(surface.key(), 13, false).unwrap(), Output::Unchanged));
        assert_eq!(BUDGET.with(|b| b.borrow().owners), 0);
        assert!(!INDEX.with(|index| index.borrow().contains_key(&surface.key())));
    }
    #[test]
    fn old_registration_drop_cannot_remove_replacement_of_same_producer() {
        let surface = Surface::new().unwrap();
        let producer = fake();
        let old = register(&surface, &erased(&producer)).unwrap();
        old.unregister();
        let current = register(&surface, &erased(&producer)).unwrap();
        drop(old);
        attach(&surface, 12);
        assert!(matches!(render(surface.key(), 12, false).unwrap(), Output::Pixels(_)));
        drop(current);
        assert!(!INDEX.with(|index| index.borrow().contains_key(&surface.key())));
    }

}

/// Framework diagnostics used by the generated-bundle lifecycle fixture.
pub fn diagnostics() -> (usize, u64, usize) {
    let (owners,pixels) = BUDGET.with(|b| { let b = b.borrow(); (b.owners,b.pixels) });
    let entries = INDEX.with(|i| i.borrow().len());
    (owners,pixels,entries)
}
