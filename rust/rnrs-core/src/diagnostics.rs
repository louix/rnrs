//! Attribution counters for diagnostics builds only (feature `diagnostics`; never in a
//! headline/measurement build). A counting global allocator plus named event counters that
//! backends increment through `count`. Plain relaxed atomics: totals, not timings.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

pub static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
pub static ALLOCATED_BYTES: AtomicU64 = AtomicU64::new(0);

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Relaxed);
        ALLOCATED_BYTES.fetch_add(layout.size() as u64, Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Relaxed);
        ALLOCATED_BYTES.fetch_add(layout.size() as u64, Relaxed);
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Relaxed);
        ALLOCATED_BYTES.fetch_add(new_size as u64, Relaxed);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

/// Backend event counters (meaning defined by each backend; see docs/optimization.md).
pub static EVENTS: [AtomicU64; 8] = [const { AtomicU64::new(0) }; 8];

pub fn count(event: usize) {
    EVENTS[event].fetch_add(1, Relaxed);
}

/// [allocations, allocated bytes, events 0..8]
pub fn snapshot() -> [u64; 10] {
    let mut out = [0; 10];
    out[0] = ALLOCATIONS.load(Relaxed);
    out[1] = ALLOCATED_BYTES.load(Relaxed);
    for (i, e) in EVENTS.iter().enumerate() {
        out[2 + i] = e.load(Relaxed);
    }
    out
}
