use std::collections::HashMap;
use std::ops::Deref;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Shared owner of a Rust implementation object exposed to JS.
///
/// JS wrappers, native owners and in-flight operations each hold a clone; the object is
/// destroyed when the last one is released. Methods take `&self`; implementations choose
/// their own interior mutability. Thread bounds are not imposed here: `Native<T>` is
/// `Send` only when `T: Send + Sync`, so multithreaded executors reject objects that are
/// not shareable while browser-local executors accept them.
///
/// The framework counts live objects per Rust type (diagnostics for lifetime tests).
pub struct Native<T: ?Sized>(Arc<Counted<T>>);

struct Counted<T: ?Sized> {
    counts: &'static Counts,
    value: T,
}

#[derive(Default)]
struct Counts {
    created: AtomicU64,
    dropped: AtomicU64,
}

/// Objects created and destroyed for one Rust type.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LiveCounts {
    pub created: u64,
    pub dropped: u64,
}

fn registry() -> &'static Mutex<HashMap<&'static str, &'static Counts>> {
    static REGISTRY: OnceLock<Mutex<HashMap<&'static str, &'static Counts>>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

fn counts_for(type_name: &'static str) -> &'static Counts {
    let mut map = crate::cancel::lock(registry());
    map.entry(type_name).or_insert_with(|| Box::leak(Box::default()))
}

/// Live-object counts for `T` (by `std::any::type_name`).
pub fn live_counts<T: ?Sized>() -> LiveCounts {
    live_counts_by_name(std::any::type_name::<T>())
}

pub fn live_counts_by_name(type_name: &str) -> LiveCounts {
    let map = crate::cancel::lock(registry());
    map.get(type_name)
        .map(|c| LiveCounts { created: c.created.load(Ordering::SeqCst), dropped: c.dropped.load(Ordering::SeqCst) })
        .unwrap_or_default()
}

impl<T> Native<T> {
    pub fn new(value: T) -> Self {
        let counts = counts_for(std::any::type_name::<T>());
        counts.created.fetch_add(1, Ordering::SeqCst);
        Self(Arc::new(Counted { counts, value }))
    }
}

impl<T: ?Sized> Native<T> {
    /// Number of live owners, for diagnostics and tests.
    pub fn owners(this: &Self) -> usize {
        Arc::strong_count(&this.0)
    }

    /// Whether two handles own the same object.
    pub fn ptr_eq(a: &Self, b: &Self) -> bool {
        Arc::ptr_eq(&a.0, &b.0)
    }
}

impl<T: ?Sized> Drop for Counted<T> {
    fn drop(&mut self) {
        self.counts.dropped.fetch_add(1, Ordering::SeqCst);
    }
}

impl<T: ?Sized> Clone for Native<T> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl<T: ?Sized> Deref for Native<T> {
    type Target = T;

    fn deref(&self) -> &T {
        &self.0.value
    }
}
