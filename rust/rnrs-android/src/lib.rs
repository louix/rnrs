//! Framework Android backend (handwritten, module-independent).
//!
//! The C++ JSI adapter (`packages/runtime/cpp/RnrsJsi.cpp`) installs one adapter per
//! `(module, runtime generation)` and calls into it through the module's [`ModuleTable`], the
//! only thing a module binary exports (`RnrsAbi.h`). Each binary, a prebuilt module or the
//! app's source bundle, has its own copy of this crate and its own Tokio runtime and budget. Generated module
//! glue never sees JSI: it converts values through [`JsiEnv`], which forwards each
//! operation to the C++ call context through a function table. Values cross as indices
//! into that context's per-call arena; strings as UTF-8 byte ranges; native objects as
//! owned `NativeBox` pointers that the C++ side stores in `jsi::NativeState`.
//!
//! Two C++ call contexts implement the function table: the module adapter's (RnrsJsi.cpp),
//! used on its React Native runtime's JS thread, and the optional worklet endpoint's
//! (RnrsWorklets.cpp), used on the thread of whichever runtime calls it (the UI thread, a
//! worklet runtime's thread, or the JS thread inside `runOnUISync`), serialized by that
//! runtime. Either way a context belongs to one call on one thread, and `rnrs_adapter_call`
//! may run concurrently for one adapter from different runtimes: module state is Send + Sync.
//!
//! No function here unwinds: release builds abort on panic and `extern "C"` functions
//! abort rather than unwind in any build.
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;

use rnrs_core::bind::{expected, Path, valid_length, Adapter, BindError, BytesError, Env, ErrorKind, Kind, MethodKind, ModuleDef, NativeBox, Spawner, UnwrapError, Val};
use rnrs_core::exec::TokioSpawner;
use rnrs_core::{Budget, Delivery, Notify};

/// Why an adapter was torn down (diagnostics only; teardown itself is the same).
pub const RNRS_TEARDOWN_EXPLICIT: u32 = 0;
/// The framework's runtime-lifecycle hook (React Native module invalidation).
pub const RNRS_TEARDOWN_LIFECYCLE: u32 = 1;
/// Fallback: the adapter was destroyed (runtime finalization) without an earlier teardown.
pub const RNRS_TEARDOWN_DESTRUCTOR: u32 = 2;
/// Created while its runtime scope was being invalidated; refused registration.
pub const RNRS_TEARDOWN_REFUSED: u32 = 3;

/// Running operations allowed at once across every module and runtime generation in the
/// process, including non-cooperative work left behind by closed generations.
pub const RNRS_EXECUTOR_BUDGET: usize = 32;

pub type Callback = extern "C" fn(*mut c_void);
/// Reports the latest posted wake's state (RnrsDelivery.h: 0 queued, 1 running, 2 done,
/// 3 dropped). Called under the host lock; only reads an atomic.
pub type DeliveryCallback = extern "C" fn(*mut c_void) -> u8;
pub const RNRS_DELIVERY_QUEUED: u8 = 0;
pub const RNRS_DELIVERY_RUNNING: u8 = 1;
pub const RNRS_DELIVERY_DONE: u8 = 2;
pub const RNRS_DELIVERY_DROPPED: u8 = 3;

/// Wakes the JS thread. The adapter guarantees `notify` may be called from any thread and
/// only schedules work, and that `ctx` stays valid until `release` is called once.
pub struct Notifier {
    notify: Callback,
    delivery: DeliveryCallback,
    release: Callback,
    ctx: *mut c_void,
}

// SAFETY: see the contract above; the context is only passed back to the adapter.
unsafe impl Send for Notifier {}
unsafe impl Sync for Notifier {}

impl Notify for Notifier {
    fn notify(&self) {
        (self.notify)(self.ctx)
    }

    fn delivery(&self) -> Delivery {
        match (self.delivery)(self.ctx) {
            RNRS_DELIVERY_QUEUED => Delivery::Queued,
            RNRS_DELIVERY_RUNNING => Delivery::Running,
            RNRS_DELIVERY_DONE => Delivery::Done,
            RNRS_DELIVERY_DROPPED => Delivery::Dropped,
            _ => Delivery::Unobserved,
        }
    }
}

impl Drop for Notifier {
    fn drop(&mut self) {
        (self.release)(self.ctx)
    }
}

/// Binding-owned Tokio runtime for the whole process. It outlives every JS runtime
/// generation (including RN reloads) and is never shut down from the JS thread.
fn tokio_spawner() -> Option<&'static TokioSpawner> {
    static RUNTIME: OnceLock<Option<TokioSpawner>> = OnceLock::new();
    RUNTIME.get_or_init(|| TokioSpawner::owned(2).ok()).as_ref()
}

fn spawner() -> Option<&'static Spawner> {
    tokio_spawner().map(|s| s as &'static Spawner)
}

/// Shared by every adapter on that runtime, so it has the same (process) scope.
pub fn budget() -> &'static Budget {
    static BUDGET: OnceLock<Budget> = OnceLock::new();
    BUDGET.get_or_init(|| Budget::new(RNRS_EXECUTOR_BUDGET))
}

static HOSTS_CREATED: AtomicU64 = AtomicU64::new(0);
static HOSTS_TORN_DOWN: AtomicU64 = AtomicU64::new(0);
static HOSTS_FREED: AtomicU64 = AtomicU64::new(0);
static TORN_DOWN_BY: [AtomicU64; 4] = [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)];
static TEARDOWN_CANCELLED: AtomicU64 = AtomicU64::new(0);
static TEARDOWN_DISCARDED_QUEUED: AtomicU64 = AtomicU64::new(0);
static TEARDOWN_STILL_RUNNING: AtomicU64 = AtomicU64::new(0);

/// One module's adapter generation.
pub struct RnrsAdapter {
    adapter: Adapter<Notifier>,
    torn_down: AtomicBool,
}

impl RnrsAdapter {
    pub fn new(def: &'static ModuleDef, max_in_flight: usize, budget: Budget, notifier: Notifier) -> Result<Self, String> {
        let spawner = spawner().ok_or("failed to start the Tokio runtime")?;
        let adapter = Adapter::new(def, max_in_flight, budget, spawner, notifier)?;
        // React Native 0.88's RuntimeScheduler can drop a queued drain task (it clears its
        // queue when another task throws): post a lost wake again (rnrs_core Host docs).
        if let Some(timer) = tokio_spawner() {
            adapter.monitor_delivery(timer);
        }
        HOSTS_CREATED.fetch_add(1, Ordering::SeqCst);
        Ok(Self { adapter, torn_down: AtomicBool::new(false) })
    }

    pub fn adapter(&self) -> &Adapter<Notifier> {
        &self.adapter
    }

    /// Stops admission, cancels pending work and drops queued outcomes without blocking and
    /// without touching JS. Callable from any thread. Idempotent; only the first call counts
    /// towards `reason`. Returns the number of cancelled operations.
    pub fn teardown(&self, reason: u32) -> u32 {
        if self.torn_down.swap(true, Ordering::SeqCst) {
            return 0;
        }
        HOSTS_TORN_DOWN.fetch_add(1, Ordering::SeqCst);
        if let Some(counter) = TORN_DOWN_BY.get(reason as usize) {
            counter.fetch_add(1, Ordering::SeqCst);
        }
        let report = self.adapter.teardown();
        TEARDOWN_CANCELLED.fetch_add(report.cancelled as u64, Ordering::SeqCst);
        TEARDOWN_DISCARDED_QUEUED.fetch_add(report.discarded_queued as u64, Ordering::SeqCst);
        TEARDOWN_STILL_RUNNING.fetch_add(report.still_running as u64, Ordering::SeqCst);
        report.cancelled as u32
    }

    /// Diagnostics object: host counters, process budget, teardown totals, native counts.
    pub fn stats_js(&self, env: &mut dyn Env) -> Result<Val, BindError> {
        let b = budget().stats();
        let load = |c: &AtomicU64| c.load(Ordering::SeqCst) as f64;
        self.adapter.stats_js(env, &[
            ("hostsCreated", load(&HOSTS_CREATED)),
            ("hostsTornDown", load(&HOSTS_TORN_DOWN)),
            ("hostsFreed", load(&HOSTS_FREED)),
            ("tornDownExplicit", load(&TORN_DOWN_BY[0])),
            ("tornDownLifecycle", load(&TORN_DOWN_BY[1])),
            ("tornDownDestructor", load(&TORN_DOWN_BY[2])),
            ("tornDownRefused", load(&TORN_DOWN_BY[3])),
            ("teardownCancelled", load(&TEARDOWN_CANCELLED)),
            ("teardownDiscardedQueued", load(&TEARDOWN_DISCARDED_QUEUED)),
            ("teardownStillRunning", load(&TEARDOWN_STILL_RUNNING)),
            ("budgetLimit", b.limit as f64),
            ("budgetRunning", b.running as f64),
            ("budgetOrphaned", b.orphaned as f64),
            ("budgetPeak", b.peak as f64),
            ("budgetRejected", b.rejected as f64),
            ("bytesAdopted", load(&BYTES_ADOPTED)),
            ("bytesReleased", load(&BYTES_RELEASED)),
        ])
    }
}

impl Drop for RnrsAdapter {
    fn drop(&mut self) {
        self.teardown(RNRS_TEARDOWN_DESTRUCTOR);
        HOSTS_FREED.fetch_add(1, Ordering::SeqCst);
    }
}

// ---- The module table: the binary boundary -------------------------------------------

/// Version of the C boundary (`ModuleTable`, `JsiVTable`, `ScalarBinding`, callbacks and
/// status codes) mirrored by packages/runtime/cpp/RnrsAbi.h. The framework C++ accepts a table
/// only with exactly this number and the struct sizes it was compiled with; any change to
/// the boundary bumps it, and the exported symbol names carry it (`rnrs_module_v5_<crate>`).
pub const RNRS_ABI: u32 = 5;

/// What one binary exports per module: identity, version data and every entry point the C++
/// runtime calls for that module. Tables are immutable statics; the binary is linked
/// statically and never unloaded, so a table pointer is valid for the whole process (the
/// C++ side keeps it in wrappers, ArrayBuffers and worklet boxes to release them later,
/// possibly after the adapter is freed). Every pointer a module hands out is released only
/// through the table of the binary that allocated it.
///
/// Built by generated code: `static T: ModuleTable = ModuleTable::new(&glue::x::MODULE, init);`
/// plus `#[no_mangle] extern "C" fn rnrs_module_v5_<crate>() -> &'static ModuleTable`; a module
/// that renders to surfaces adds `.with_surface(rnrs_surface::host::table())`.
#[repr(C)]
pub struct ModuleTable {
    pub abi: u32,
    pub size: u32,
    pub vtable_size: u32,
    pub scalar_binding_size: u32,
    pub name: *const u8,
    pub name_len: usize,
    pub hash: *const u8,
    pub hash_len: usize,
    pub build: *const u8,
    pub build_len: usize,
    /// Opaque to C++: this binary's `ModuleDef`, read back only by `adapter_new`.
    pub def: *const ModuleDef,
    /// Once per process before any other entry (the generated binary's startup: logging).
    /// Idempotent, so every table of one binary may point at the same function.
    pub init: extern "C" fn(),
    pub set_app_data_dir: unsafe extern "C" fn(*const u8, usize) -> bool,
    pub adapter_new: unsafe extern "C" fn(*const ModuleTable, u32, Callback, DeliveryCallback, Callback, *mut c_void, *mut u8, usize) -> *mut RnrsAdapter,
    pub adapter_scalar: unsafe extern "C" fn(*const RnrsAdapter, usize, *mut u32, *mut ScalarBinding) -> bool,
    pub scalar_call: unsafe extern "C" fn(*const RnrsAdapter, *const ScalarBinding, *const [f64; 4], *mut f64, *mut u32, *mut u8, usize) -> u32,
    pub adapter_call: unsafe extern "C" fn(*const RnrsAdapter, *const JsiVTable, *mut c_void, u32, u32, u32, *const u32, usize, *mut u32, *mut u32, *mut u8, usize) -> u32,
    pub adapter_drain: unsafe extern "C" fn(*const RnrsAdapter, *const JsiVTable, *mut c_void, u32, usize, SettleFn) -> usize,
    pub adapter_stats: unsafe extern "C" fn(*const RnrsAdapter, *const JsiVTable, *mut c_void, u32) -> u32,
    pub adapter_cancel: unsafe extern "C" fn(*const RnrsAdapter, u64) -> bool,
    pub adapter_teardown: unsafe extern "C" fn(*const RnrsAdapter, u32) -> u32,
    pub adapter_free: unsafe extern "C" fn(*mut RnrsAdapter),
    pub adapter_method_find: unsafe extern "C" fn(*const RnrsAdapter, *const u8, usize, *mut u32, *mut bool) -> bool,
    pub native_share: unsafe extern "C" fn(*const c_void) -> *mut c_void,
    pub native_spec_name: unsafe extern "C" fn(*const c_void, *mut usize) -> *const u8,
    pub native_release: extern "C" fn(*mut c_void),
    pub bytes_free: unsafe extern "C" fn(*mut u8, usize, usize),
    /// Attribution counters; null unless built with the `diagnostics` feature.
    pub diagnostics: Option<unsafe extern "C" fn(*mut u64)>,
    /// Opaque to this crate: the binary's rnrs-surface table (`RnrsSurfaceV1`,
    /// rnrs_surface::host), or null for a module without surfaces. Every module of one binary
    /// that has it points at the same static table.
    pub surface: *const c_void,
}

// SAFETY: immutable static data (string literals, a static ModuleDef, function pointers).
unsafe impl Sync for ModuleTable {}

/// Diagnostics only: the backend version this binary was built with (the target, rustc and
/// sources are recorded in the package's native manifest).
const BUILD: &str = concat!("rnrs-android ", env!("CARGO_PKG_VERSION"));

impl ModuleTable {
    pub const fn new(def: &'static ModuleDef, init: extern "C" fn()) -> Self {
        Self {
            abi: RNRS_ABI,
            size: std::mem::size_of::<ModuleTable>() as u32,
            vtable_size: std::mem::size_of::<JsiVTable>() as u32,
            scalar_binding_size: std::mem::size_of::<ScalarBinding>() as u32,
            name: def.name.as_ptr(),
            name_len: def.name.len(),
            hash: def.hash.as_ptr(),
            hash_len: def.hash.len(),
            build: BUILD.as_ptr(),
            build_len: BUILD.len(),
            def,
            init,
            set_app_data_dir: rnrs_set_app_data_dir,
            adapter_new: rnrs_adapter_new,
            adapter_scalar: rnrs_adapter_scalar,
            scalar_call: rnrs_scalar_call,
            adapter_call: rnrs_adapter_call,
            adapter_drain: rnrs_adapter_drain,
            adapter_stats: rnrs_adapter_stats,
            adapter_cancel: rnrs_adapter_cancel,
            adapter_teardown: rnrs_adapter_teardown,
            adapter_free: rnrs_adapter_free,
            adapter_method_find: rnrs_adapter_method_find,
            native_share: rnrs_native_share,
            native_spec_name: rnrs_native_spec_name,
            native_release: rnrs_native_release,
            bytes_free: rnrs_bytes_free,
            #[cfg(feature = "diagnostics")]
            diagnostics: Some(rnrs_diagnostics),
            #[cfg(not(feature = "diagnostics"))]
            diagnostics: None,
            surface: std::ptr::null(),
        }
    }

    /// This module renders to surfaces: `surface` is its binary's rnrs-surface table.
    pub const fn with_surface(mut self, surface: *const c_void) -> Self {
        self.surface = surface;
        self
    }
}

// ---- Env over the C++ call context -----------------------------------------------------

/// Function table implemented by the C++ JSI adapter and the worklet endpoint. `ctx` is the
/// per-call context; values are indices into that context's value storage (the adapter's
/// arena, or the endpoint call's fixed slots). Fallible operations return false when JS
/// threw (the context keeps the exception for rethrow).
#[repr(C)]
pub struct JsiVTable {
    pub kind: extern "C" fn(*mut c_void, u32) -> u32,
    pub to_number: extern "C" fn(*mut c_void, u32) -> f64,
    pub to_bool: extern "C" fn(*mut c_void, u32) -> bool,
    pub get_property: extern "C" fn(*mut c_void, u32, *const u8, usize, *mut u32) -> bool,
    /// Reads `length` (may run proxy traps); false if JS threw.
    pub array_length: extern "C" fn(*mut c_void, u32, *mut f64) -> bool,
    pub get_index: extern "C" fn(*mut c_void, u32, u32, *mut u32) -> bool,
    pub undefined: extern "C" fn(*mut c_void) -> u32,
    pub null: extern "C" fn(*mut c_void) -> u32,
    pub number: extern "C" fn(*mut c_void, f64) -> u32,
    pub boolean: extern "C" fn(*mut c_void, bool) -> u32,
    pub string: extern "C" fn(*mut c_void, *const u8, usize) -> u32,
    pub object: extern "C" fn(*mut c_void) -> u32,
    pub set_property: extern "C" fn(*mut c_void, u32, *const u8, usize, u32) -> bool,
    pub array: extern "C" fn(*mut c_void, u32) -> u32,
    pub set_index: extern "C" fn(*mut c_void, u32, u32, u32) -> bool,
    /// Takes ownership of `native` (released through `rnrs_native_release`).
    pub wrap_native: extern "C" fn(*mut c_void, *mut c_void, *mut u32) -> bool,
    /// 0 ok (writes the `NativeBox` pointer), 1 not native, 2 closed generation, 3 disposed.
    pub unwrap_native: extern "C" fn(*mut c_void, u32, *mut *const c_void) -> u32,
    /// Checks the value (framework `bufferKind` helper) and copies its bytes into storage it
    /// obtains from `alloc(alloc_ctx, len)` (null if allocation failed), in one call. Returns
    /// 0 ok, 1-5 as `BytesError`, 6 if JS threw, 7 if allocation failed.
    pub to_bytes: extern "C" fn(*mut c_void, u32, extern "C" fn(*mut c_void, usize) -> *mut u8, *mut c_void) -> u32,
    /// Takes ownership of a Rust `Vec<u8>` (ptr, len, cap), released through
    /// `rnrs_bytes_free`, and writes the new ArrayBuffer's index.
    pub new_bytes: extern "C" fn(*mut c_void, *mut u8, usize, usize, *mut u32),
    /// UTF-8 copy of a string straight into storage from `alloc(alloc_ctx, len)`; returns
    /// the bytes written (at most `len`).
    pub to_string_into: extern "C" fn(*mut c_void, u32, extern "C" fn(*mut c_void, usize) -> *mut u8, *mut c_void) -> usize,
    /// Same layout/contract as RnrsAbi.h: 0 success, 1 invalid, 2 thrown.
    pub number_array: extern "C" fn(*mut c_void, u32, u32, extern "C" fn(*mut c_void, usize, usize) -> *mut f64, *mut c_void, *mut u32, *mut u32) -> u32,
    /// `Object.entries` of a plain object (`Record<string, T>`, `JsonValue`); writes the new
    /// array's index. 0 ok, 1 not a plain object, 2 thrown.
    pub own_entries: extern "C" fn(*mut c_void, u32, *mut u32) -> u32,
    /// A new array of `len` doubles read from `data` (borrowed for the whole synchronous call;
    /// C++ may run framework JS before and while reading it), as own data properties; writes its
    /// index. False if JS threw.
    pub new_numbers: extern "C" fn(*mut c_void, *const f64, u32, *mut u32) -> bool,
}

static BYTES_ADOPTED: AtomicU64 = AtomicU64::new(0);
static BYTES_RELEASED: AtomicU64 = AtomicU64::new(0);

// Only this callback borrows the vector while C++ is active; it runs no JS.
// C++ relinquishes its old data pointer before requesting growth. Nested JS calls
// have separate vectors and cannot access this stack-local destination.
extern "C" fn alloc_numbers(ctx: *mut c_void, initialized: usize, capacity: usize) -> *mut f64 {
    let out = unsafe { &mut *(ctx as *mut Vec<f64>) };
    assert!(initialized <= out.capacity() && initialized <= capacity);
    // SAFETY: the native loop initialized this prefix before requesting growth.
    unsafe { out.set_len(initialized) };
    out.reserve_exact(capacity - initialized);
    out.as_mut_ptr()
}

#[cfg(test)]
mod number_storage_tests {
    use super::*;

    #[test]
    fn growth_preserves_initialized_ieee_values_and_partial_tail_can_be_freed() {
        let mut out = Vec::<f64>::new();
        let ctx = &raw mut out as *mut c_void;
        let p = alloc_numbers(ctx, 0, 4096);
        for i in 0..4096 {
            unsafe { p.add(i).write(match i { 0 => -0.0, 1 => f64::NAN, 2 => f64::INFINITY, _ => i as f64 }) };
        }
        let p = alloc_numbers(ctx, 4096, 8192);
        assert_eq!(out.len(), 4096);
        assert_eq!(out[0].to_bits(), (-0.0f64).to_bits());
        assert!(out[1].is_nan());
        assert_eq!(out[2], f64::INFINITY);
        assert_eq!(out[4095], 4095.0);
        // Simulate a throwing getter after growth and one successful write: no
        // set_len on the uncommitted tail, and no leaked allocation on drop.
        unsafe { p.add(4096).write(42.0) };
        drop(out);
    }
}

/// Reserves exactly `len` bytes (uninitialized; the encoder writes them) in the empty
/// `Vec<u8>` behind `ctx` and returns the storage. Allocation failure aborts, as for any
/// String.
extern "C" fn alloc_string(ctx: *mut c_void, len: usize) -> *mut u8 {
    let out = unsafe { &mut *(ctx as *mut Vec<u8>) };
    out.reserve_exact(len);
    out.as_mut_ptr()
}

/// Replaces the `Vec<u8>` behind `ctx` with `len` zeroed bytes and returns its storage (C++
/// copies into it), or null if that cannot be allocated (C++ then reports status 7).
extern "C" fn alloc_bytes(ctx: *mut c_void, len: usize) -> *mut u8 {
    let out = unsafe { &mut *(ctx as *mut Vec<u8>) };
    match rnrs_core::bind::alloc_bytes(len) {
        Ok(storage) => {
            *out = storage;
            out.as_mut_ptr()
        }
        Err(_) => std::ptr::null_mut(),
    }
}

/// Releases a `Vec<u8>` handed to the C++ side for an ArrayBuffer. Thread-safe: Hermes may
/// finalize ArrayBuffers off the JS thread (runtime destruction).
///
/// # Safety
/// `(ptr, len, cap)` come from one `Vec<u8>` passed to `new_bytes`, released once.
pub unsafe extern "C" fn rnrs_bytes_free(ptr: *mut u8, len: usize, cap: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, len, cap) });
    BYTES_RELEASED.fetch_add(1, Ordering::SeqCst);
}

pub struct JsiEnv<'a> {
    vt: &'a JsiVTable,
    ctx: *mut c_void,
    epoch: u32,
}

impl<'a> JsiEnv<'a> {
    /// # Safety
    /// `ctx` is a live C++ call context for `vt`, used only on the calling runtime's thread
    /// for this call (the RN JS thread for the adapter; any runtime's thread for the endpoint).
    pub unsafe fn new(vt: &'a JsiVTable, ctx: *mut c_void, epoch: u32) -> Self {
        Self { vt, ctx, epoch }
    }
    fn ix(&self, v: Val) -> u32 {
        assert_eq!(v.epoch(), self.epoch, "JS value handle used outside the call that created it");
        v.index()
    }
    fn val(&self, index: u32) -> Val {
        Val::new(index, self.epoch)
    }
}

/// `JsiVTable::unwrap_native` results.
pub const RNRS_UNWRAP_OK: u32 = 0;
pub const RNRS_UNWRAP_NOT_NATIVE: u32 = 1;
pub const RNRS_UNWRAP_CLOSED: u32 = 2;
pub const RNRS_UNWRAP_DISPOSED: u32 = 3;
/// `JsiVTable::number_array` results (2: JS threw).
pub const RNRS_NUMBERS_OK: u32 = 0;
pub const RNRS_NUMBERS_INVALID: u32 = 1;
pub const RNRS_NUMBERS_THROWN: u32 = 2;
/// `JsiVTable::own_entries` results (2: JS threw).
pub const RNRS_ENTRIES_OK: u32 = 0;
pub const RNRS_ENTRIES_NOT_PLAIN: u32 = 1;
pub const RNRS_ENTRIES_THROWN: u32 = 2;

/// `JsiVTable::kind` results are indices into this table.
const KINDS: [Kind; 9] = [Kind::Undefined, Kind::Null, Kind::Boolean, Kind::Number, Kind::String, Kind::Array, Kind::Function, Kind::Object, Kind::Other];

impl Env for JsiEnv<'_> {
    fn kind(&mut self, v: Val) -> Kind {
        KINDS.get((self.vt.kind)(self.ctx, self.ix(v)) as usize).copied().unwrap_or(Kind::Other)
    }
    fn to_number(&mut self, v: Val) -> f64 {
        (self.vt.to_number)(self.ctx, self.ix(v))
    }
    fn number_array(&mut self, v: Val, path: &Path<'_>) -> Result<Vec<f64>, BindError> {
        if self.kind(v) != Kind::Array {
            return Err(expected(self, v, path, "an array"));
        }
        let length = self.array_length(v)?;
        let mut out = Vec::<f64>::new();
        let mut bad_index = 0;
        let mut bad_value = 0;
        // Raw pointer only: no destination reference remains live across JS getters.
        let status = (self.vt.number_array)(self.ctx, self.ix(v), length, alloc_numbers,
            &raw mut out as *mut c_void, &mut bad_index, &mut bad_value);
        match status {
            0 => {
                assert!(length as usize <= out.capacity());
                // SAFETY: success guarantees all length doubles were initialized.
                unsafe { out.set_len(length as usize) };
                Ok(out)
            }
            1 => {
                let value = self.val(bad_value);
                Err(expected(self, value, &path.index(bad_index), "a number"))
            }
            _ => Err(BindError::Thrown),
        }
        // On failure Vec frees its allocation. Uncommitted tail values are f64
        // (no destructors); no uninitialized value is ever read or dropped.
    }
    fn to_bool(&mut self, v: Val) -> bool {
        (self.vt.to_bool)(self.ctx, self.ix(v))
    }
    fn to_string(&mut self, v: Val) -> String {
        // One copy: the C++ side encodes the engine's string data directly into this
        // buffer. Validation is kept (in place, no copy); invalid bytes would take the lossy
        // path exactly as before.
        let mut buf: Vec<u8> = Vec::new();
        let written = (self.vt.to_string_into)(self.ctx, self.ix(v), alloc_string, &mut buf as *mut Vec<u8> as *mut c_void);
        assert!(written <= buf.capacity(), "string encoder overran its buffer");
        // SAFETY: the encoder initialized the first `written` bytes of the reserved storage.
        unsafe { buf.set_len(written) };
        utf8_from_vec(buf)
    }
    fn get_property(&mut self, object: Val, key: &str) -> Result<Val, BindError> {
        let mut out = 0u32;
        if (self.vt.get_property)(self.ctx, self.ix(object), key.as_ptr(), key.len(), &mut out) { Ok(self.val(out)) } else { Err(BindError::Thrown) }
    }
    fn own_entries(&mut self, v: Val) -> Result<Option<Val>, BindError> {
        let mut out = 0u32;
        match (self.vt.own_entries)(self.ctx, self.ix(v), &mut out) {
            RNRS_ENTRIES_OK => Ok(Some(self.val(out))),
            RNRS_ENTRIES_NOT_PLAIN => Ok(None),
            _ => Err(BindError::Thrown),
        }
    }
    fn array_length(&mut self, array: Val) -> Result<u32, BindError> {
        let mut out = 0.0f64;
        if !(self.vt.array_length)(self.ctx, self.ix(array), &mut out) {
            return Err(BindError::Thrown);
        }
        valid_length(out)
    }
    fn get_index(&mut self, array: Val, index: u32) -> Result<Val, BindError> {
        let mut out = 0u32;
        if (self.vt.get_index)(self.ctx, self.ix(array), index, &mut out) { Ok(self.val(out)) } else { Err(BindError::Thrown) }
    }
    fn undefined(&mut self) -> Val {
        let i = (self.vt.undefined)(self.ctx);
        self.val(i)
    }
    fn null(&mut self) -> Val {
        let i = (self.vt.null)(self.ctx);
        self.val(i)
    }
    fn number(&mut self, value: f64) -> Val {
        let i = (self.vt.number)(self.ctx, value);
        self.val(i)
    }
    fn boolean(&mut self, value: bool) -> Val {
        let i = (self.vt.boolean)(self.ctx, value);
        self.val(i)
    }
    fn string(&mut self, value: &str) -> Val {
        let i = (self.vt.string)(self.ctx, value.as_ptr(), value.len());
        self.val(i)
    }
    fn object(&mut self) -> Val {
        let i = (self.vt.object)(self.ctx);
        self.val(i)
    }
    fn set_property(&mut self, object: Val, key: &str, value: Val) -> Result<(), BindError> {
        if (self.vt.set_property)(self.ctx, self.ix(object), key.as_ptr(), key.len(), self.ix(value)) { Ok(()) } else { Err(BindError::Thrown) }
    }
    fn array(&mut self, length: u32) -> Val {
        let i = (self.vt.array)(self.ctx, length);
        self.val(i)
    }
    fn set_index(&mut self, array: Val, index: u32, value: Val) -> Result<(), BindError> {
        if (self.vt.set_index)(self.ctx, self.ix(array), index, self.ix(value)) { Ok(()) } else { Err(BindError::Thrown) }
    }
    fn new_number_array(&mut self, values: &[f64]) -> Result<Val, BindError> {
        let len = u32::try_from(values.len()).map_err(|_| BindError::range_error("array too long"))?;
        let mut out = 0u32;
        // `values` outlives the call (the caller's Vec is not touched until it returns); C++ never
        // reads it after returning (or for len 0).
        if (self.vt.new_numbers)(self.ctx, values.as_ptr(), len, &mut out) { Ok(self.val(out)) } else { Err(BindError::Thrown) }
    }
    fn to_bytes(&mut self, v: Val, out: &mut Vec<u8>) -> Result<(), BytesError> {
        let status = (self.vt.to_bytes)(self.ctx, self.ix(v), alloc_bytes, out as *mut Vec<u8> as *mut c_void);
        match BytesError::from_status(status) {
            None => Ok(()),
            Some(error) => Err(error),
        }
    }
    fn new_bytes(&mut self, data: Vec<u8>) -> Result<Val, BindError> {
        let mut data = std::mem::ManuallyDrop::new(data);
        let mut out = 0u32;
        BYTES_ADOPTED.fetch_add(1, Ordering::SeqCst);
        // Ownership passes to the C++ side, which always adopts it (or copies and then
        // releases it) and frees it through rnrs_bytes_free exactly once.
        (self.vt.new_bytes)(self.ctx, data.as_mut_ptr(), data.len(), data.capacity(), &mut out);
        Ok(self.val(out))
    }
    fn wrap_native(&mut self, object: NativeBox) -> Result<Val, BindError> {
        let raw = Box::into_raw(Box::new(object)) as *mut c_void;
        let mut out = 0u32;
        if (self.vt.wrap_native)(self.ctx, raw, &mut out) {
            Ok(self.val(out))
        } else {
            // Not adopted: release here.
            rnrs_native_release(raw);
            Err(BindError::error("runtime adapter is closed"))
        }
    }
    fn unwrap_native(&mut self, v: Val) -> Result<&NativeBox, UnwrapError> {
        let mut ptr: *const c_void = std::ptr::null();
        match (self.vt.unwrap_native)(self.ctx, self.ix(v), &mut ptr) {
            // SAFETY: the wrapper (adapter: a NativeState object in this call's arena; endpoint:
            // a boxed-handle HostObject in the call's slots, or the receiver box held by the
            // calling host function) is rooted for the whole call, so the box outlives this
            // borrow; no JS runs while it is borrowed.
            RNRS_UNWRAP_OK if !ptr.is_null() => Ok(unsafe { &*(ptr as *const NativeBox) }),
            RNRS_UNWRAP_OK | RNRS_UNWRAP_NOT_NATIVE => Err(UnwrapError::NotNative),
            RNRS_UNWRAP_CLOSED => Err(UnwrapError::Closed),
            _ => Err(UnwrapError::Disposed),
        }
    }
}

// ---- C ABI -------------------------------------------------------------------------------

pub const RNRS_CALL_OK: u32 = 0;
pub const RNRS_CALL_ERROR: u32 = 1;
pub const RNRS_CALL_THROWN: u32 = 2;
/// A declared error (`Throws<T, E>`): `out` holds the converted `E`; no message.
pub const RNRS_CALL_DOMAIN: u32 = 3;

pub type SettleFn = extern "C" fn(*mut c_void, u64, u32, u32, *const u8, usize);

/// The `errorKind` a failed call reports (RnrsAbi.h `kErrorType`, `kErrorRange`, `kErrorPlain`).
fn error_kind_code(kind: ErrorKind) -> u32 {
    match kind {
        ErrorKind::TypeError => 0,
        ErrorKind::RangeError => 1,
        ErrorKind::Error => 2,
    }
}

fn write_message(out: *mut u8, cap: usize, text: &str) {
    if out.is_null() || cap == 0 {
        return;
    }
    let mut n = text.len().min(cap - 1);
    while !text.is_char_boundary(n) {
        n -= 1;
    }
    // SAFETY: `out` points to `cap` writable bytes (C ABI contract).
    unsafe {
        std::ptr::copy_nonoverlapping(text.as_ptr(), out, n);
        *out.add(n) = 0;
    }
}

/// `from_raw_parts` requires a non-null, aligned pointer even for length 0, but C++ may pass
/// null for empty data (an empty `std::vector`'s `data()`, for example). Every slice built
/// from a foreign pointer goes through here.
///
/// # Safety
/// If `len > 0`, `ptr` must be valid for `len` reads of `T` for `'a`.
pub unsafe fn slice_or_empty<'a, T>(ptr: *const T, len: usize) -> &'a [T] {
    if len == 0 || ptr.is_null() {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }
}


unsafe fn str_arg<'a>(ptr: *const u8, len: usize) -> &'a str {
    std::str::from_utf8(unsafe { slice_or_empty(ptr, len) }).unwrap_or("")
}

/// Creates an adapter generation of `table`'s module; null on failure (message in `error`).
///
/// # Safety
/// `table` is a table built by [`ModuleTable::new`] in this binary; `error` points to
/// `error_cap` writable bytes; `ctx` stays valid until `release` is called once.
pub unsafe extern "C" fn rnrs_adapter_new(
    table: *const ModuleTable, max_in_flight: u32, notify: Callback, delivery: DeliveryCallback, release: Callback, ctx: *mut c_void,
    error: *mut u8, error_cap: usize,
) -> *mut RnrsAdapter {
    let notifier = Notifier { notify, delivery, release, ctx };
    // SAFETY: tables are immutable statics whose `def` is a `&'static ModuleDef` of this binary.
    let def = unsafe { &*(*table).def };
    match RnrsAdapter::new(def, max_in_flight as usize, budget().clone(), notifier) {
        Ok(adapter) => Box::into_raw(Box::new(adapter)),
        Err(message) => {
            write_message(error, error_cap, &message);
            std::ptr::null_mut()
        }
    }
}

/// Private immutable binding borrowed by C++ for the owning adapter's lifetime.
#[repr(C)]
pub struct ScalarBinding {
    args: u32,
    result: u32,
    definition: *const rnrs_core::bind::ScalarDef,
    instance: *const (),
}

/// # Safety
/// Adapter is live; out points to writable storage. Binding must not outlive adapter.
pub unsafe extern "C" fn rnrs_adapter_scalar(adapter: *const RnrsAdapter, index: usize, method: *mut u32, out: *mut ScalarBinding) -> bool {
    let adapter = &unsafe { &*adapter }.adapter;
    let Some(def) = adapter.def().scalars.get(index) else { return false };
    unsafe {
        method.write(def.method);
        out.write(ScalarBinding { args: def.args, result: def.result, definition: def, instance: adapter.scalar_instance(def) });
    }
    true
}

/// # Safety
/// Binding belongs to live adapter; args contains four initialized scalar slots with
/// validated types/boolean representations. No JS may run during this synchronous call.
/// Output/error buffers are writable with the stated capacity, as in rnrs_adapter_call.
pub unsafe extern "C" fn rnrs_scalar_call(adapter: *const RnrsAdapter, binding: *const ScalarBinding, args: *const [f64; 4], out: *mut f64,
    error_kind: *mut u32, error: *mut u8, error_cap: usize) -> u32 {
    let adapter = unsafe { &*adapter };
    let binding = unsafe { &*binding };
    #[cfg(feature = "diagnostics")]
    rnrs_core::diagnostics::count(4);
    let result = adapter.adapter.check_open().and_then(|()| {
        // The captured C++ shared owner keeps adapter and its instance alive even
        // if another thread retires its resources. Teardown never frees instance.
        unsafe { ((*binding.definition).call)(binding.instance, &*args) }.map_err(BindError::error)
    });
    match result {
        Ok(value) => { unsafe { out.write(value) }; RNRS_CALL_OK }
        Err(BindError::Js { kind, message }) => {
            unsafe { error_kind.write(error_kind_code(kind)) };
            write_message(error, error_cap, &message);
            RNRS_CALL_ERROR
        }
        Err(BindError::Thrown) => unreachable!("scalar leaf cannot run JS"),
        // Methods with declared errors have no scalar leaf; never unwind across the C ABI.
        Err(BindError::Domain { .. }) => {
            unsafe { error_kind.write(error_kind_code(ErrorKind::Error)) };
            write_message(error, error_cap, "rnrs: internal error: a scalar leaf reported a declared error");
            RNRS_CALL_ERROR
        }
    }
}

/// Calls method `method` (IR order). On `RNRS_CALL_ERROR` writes the error kind (0 TypeError,
/// 1 RangeError, 2 Error) and message; on `RNRS_CALL_THROWN` the context holds a JS exception;
/// on `RNRS_CALL_DOMAIN` `out` holds a declared error's converted value.
///
/// # Safety
/// `adapter` is live; `vt`/`ctx` form a live call context on the calling runtime's thread
/// (see the module docs); `args` points to `nargs` value indices of that context; `out`, `error_kind` are writable; `error` has `error_cap` bytes.
pub unsafe extern "C" fn rnrs_adapter_call(
    adapter: *const RnrsAdapter, vt: *const JsiVTable, ctx: *mut c_void, epoch: u32, method: u32, this: u32, args: *const u32,
    nargs: usize, out: *mut u32, error_kind: *mut u32, error: *mut u8, error_cap: usize,
) -> u32 {
    let adapter = unsafe { &*adapter };
    #[cfg(feature = "diagnostics")]
    rnrs_core::diagnostics::count(4);
    let mut env = unsafe { JsiEnv::new(&*vt, ctx, epoch) };
    // A zero-argument call may pass a null `args` (empty std::vector).
    let raw = unsafe { slice_or_empty(args, nargs) };
    // Up to 8 arguments on the stack (no allocation per call).
    let mut inline = [Val::new(0, epoch); 8];
    let heap: Vec<Val>;
    let args: &[Val] = if raw.len() <= inline.len() {
        for (slot, &i) in inline.iter_mut().zip(raw) {
            *slot = Val::new(i, epoch);
        }
        &inline[..raw.len()]
    } else {
        heap = raw.iter().map(|&i| Val::new(i, epoch)).collect();
        &heap
    };
    match adapter.adapter.call(&mut env, method, Val::new(this, epoch), args) {
        Ok(v) => {
            unsafe { out.write(v.index()) };
            RNRS_CALL_OK
        }
        Err(BindError::Thrown) => RNRS_CALL_THROWN,
        Err(BindError::Domain { value }) => {
            unsafe { out.write(value.index()) };
            RNRS_CALL_DOMAIN
        }
        Err(BindError::Js { kind, message }) => {
            unsafe { error_kind.write(error_kind_code(kind)) };
            write_message(error, error_cap, &message);
            RNRS_CALL_ERROR
        }
    }
}

/// Converts and settles up to `max` outcomes; `settle(ctx, id, status, value, msg, len)` is
/// called for each on the JS thread. Returns how many were drained.
///
/// # Safety
/// As for `rnrs_adapter_call`.
pub unsafe extern "C" fn rnrs_adapter_drain(
    adapter: *const RnrsAdapter, vt: *const JsiVTable, ctx: *mut c_void, epoch: u32, max: usize, settle: SettleFn,
) -> usize {
    let adapter = unsafe { &*adapter };
    let mut env = unsafe { JsiEnv::new(&*vt, ctx, epoch) };
    adapter.adapter.drain(&mut env, max, |_, id, status, value, message| {
        settle(ctx, id, status, value.index(), message.as_ptr(), message.len());
    })
}

/// Builds the diagnostics object; returns its arena index.
///
/// # Safety
/// As for `rnrs_adapter_call`.
pub unsafe extern "C" fn rnrs_adapter_stats(adapter: *const RnrsAdapter, vt: *const JsiVTable, ctx: *mut c_void, epoch: u32) -> u32 {
    let adapter = unsafe { &*adapter };
    let mut env = unsafe { JsiEnv::new(&*vt, ctx, epoch) };
    match adapter.stats_js(&mut env) {
        Ok(v) => v.index(),
        Err(_) => (vt_ref(vt).undefined)(ctx),
    }
}

fn vt_ref<'a>(vt: *const JsiVTable) -> &'a JsiVTable {
    unsafe { &*vt }
}

/// # Safety
/// `adapter` is live.
pub unsafe extern "C" fn rnrs_adapter_cancel(adapter: *const RnrsAdapter, id: u64) -> bool {
    unsafe { &*adapter }.adapter.cancel(id)
}

/// Any thread; no JS. Idempotent.
///
/// # Safety
/// `adapter` is live.
pub unsafe extern "C" fn rnrs_adapter_teardown(adapter: *const RnrsAdapter, reason: u32) -> u32 {
    unsafe { &*adapter }.teardown(reason)
}

/// Tears down if needed (counted as the destructor fallback) and frees the adapter.
/// Running work keeps its own references.
///
/// # Safety
/// `adapter` is live and not used afterwards.
pub unsafe extern "C" fn rnrs_adapter_free(adapter: *mut RnrsAdapter) {
    drop(unsafe { Box::from_raw(adapter) });
}

/// Finds method `name` (`method` or `Object.method`, as in the IR) of the adapter's module:
/// writes its index and whether it is async. Returns false if the module has no such method.
///
/// # Safety
/// `adapter` is live; `(name, len)` is readable; `index` and `is_async` are writable.
pub unsafe extern "C" fn rnrs_adapter_method_find(adapter: *const RnrsAdapter, name: *const u8, len: usize, index: *mut u32, is_async: *mut bool) -> bool {
    let name = unsafe { str_arg(name, len) };
    let def = unsafe { &*adapter }.adapter.def();
    match def.methods.iter().position(|m| m.name == name) {
        Some(i) => {
            unsafe {
                index.write(i as u32);
                is_async.write(def.methods[i].kind == MethodKind::Async);
            }
            true
        }
        None => false,
    }
}

/// A second owner of the object in `native` (a `NativeBox` from a wrapper): a new box,
/// released through `rnrs_native_release` independently of the first. Thread-safe.
///
/// # Safety
/// `native` is a live `NativeBox` pointer (from `wrap_native` or this function).
pub unsafe extern "C" fn rnrs_native_share(native: *const c_void) -> *mut c_void {
    let boxed = unsafe { &*(native as *const NativeBox) };
    Box::into_raw(Box::new(boxed.share())) as *mut c_void
}

/// The spec interface name of the object in `native` (static UTF-8, not terminated).
///
/// # Safety
/// `native` is a live `NativeBox` pointer; `len` is writable.
pub unsafe extern "C" fn rnrs_native_spec_name(native: *const c_void, len: *mut usize) -> *const u8 {
    let name = unsafe { &*(native as *const NativeBox) }.spec_name;
    unsafe { len.write(name.len()) };
    name.as_ptr()
}

/// Releases a native object owned by a JS wrapper. Thread-safe: `NativeBox` holds a
/// `Native<T>` with `T: Send + Sync`, so the final drop may run on any thread (Hermes
/// finalizes wrappers off the JS thread during runtime destruction).
pub extern "C" fn rnrs_native_release(native: *mut c_void) {
    if !native.is_null() {
        drop(unsafe { Box::from_raw(native as *mut NativeBox) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod teardown_hook {
        //! The runtime-teardown hook through the C ABI used by Android (JNI) and iOS: an
        //! explicit `rnrs_adapter_teardown` and the Drop-only path (`rnrs_adapter_free` without
        //! teardown, as RNRS_TEARDOWN_DESTRUCTOR) both retire what the module registered, even
        //! while another reference to the resource is held.
        use super::*;
        use rnrs_core::bind::{Call, MethodDef, NativeTypeDef};
        use rnrs_core::lifecycle::{Retire, TeardownScope};
        use std::sync::atomic::AtomicUsize;
        use std::sync::{Arc, Mutex};

        struct Resource(AtomicUsize);
        impl Retire for Resource {
            fn retire(&self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        /// Resources created by each instantiate, retained here as a surviving holder would.
        static CREATED: Mutex<Vec<Arc<Resource>>> = Mutex::new(Vec::new());
        static UNOWNED: AtomicUsize = AtomicUsize::new(0);

        fn instantiate() -> Result<Box<rnrs_core::bind::AnyNative>, String> {
            let resource = Arc::new(Resource(AtomicUsize::new(0)));
            match TeardownScope::current() {
                Some(scope) => {
                    let r: Arc<dyn Retire> = resource.clone();
                    scope.register(Arc::downgrade(&r));
                }
                None => {
                    UNOWNED.fetch_add(1, Ordering::SeqCst);
                }
            }
            CREATED.lock().unwrap().push(resource);
            Ok(Box::new(rnrs_core::Native::new(())))
        }
        fn call(_: &mut Call<'_>, _: u32, _: Val, _: &[Val]) -> Result<Val, BindError> {
            Err(BindError::error("no methods"))
        }
        static METHODS: [MethodDef; 0] = [];
        static TYPES: [NativeTypeDef; 0] = [];
        static DEF: ModuleDef = ModuleDef { name: "TeardownHookProbe", hash: "test", methods: &METHODS, scalars: &[], native_types: &TYPES, instantiate, call };
        extern "C" fn no_init() {}
        static TABLE: ModuleTable = ModuleTable::new(&DEF, no_init);

        extern "C" fn noop(_: *mut c_void) {}
        extern "C" fn queued(_: *mut c_void) -> u8 {
            0
        }

        fn new_adapter() -> (*mut RnrsAdapter, Arc<Resource>) {
            let mut error = [0u8; 256];
            let adapter = unsafe { (TABLE.adapter_new)(&TABLE, 4, noop, queued, noop, std::ptr::null_mut(), error.as_mut_ptr(), error.len()) };
            assert!(!adapter.is_null());
            let resource = CREATED.lock().unwrap().last().cloned().expect("instantiated");
            (adapter, resource)
        }

        #[test]
        fn explicit_teardown_and_drop_only_paths_retire_registered_resources() {
            let (adapter, explicit) = new_adapter();
            assert_eq!(explicit.0.load(Ordering::SeqCst), 0);
            unsafe { rnrs_adapter_teardown(adapter, 0) };
            assert_eq!(explicit.0.load(Ordering::SeqCst), 1, "explicit teardown retires");
            unsafe { rnrs_adapter_free(adapter) };
            assert_eq!(explicit.0.load(Ordering::SeqCst), 1, "exactly once");

            let (adapter, dropped) = new_adapter();
            unsafe { rnrs_adapter_free(adapter) };
            assert_eq!(dropped.0.load(Ordering::SeqCst), 1, "freed without teardown (destructor path) retires");
            assert_eq!(UNOWNED.load(Ordering::SeqCst), 0, "adapter construction always provides a scope");
            assert!(TeardownScope::current().is_none(), "the scope is not left current after construction");
        }

        static FAILING_RESOURCE: Mutex<Option<Arc<Resource>>> = Mutex::new(None);
        fn instantiate_then_fail() -> Result<Box<rnrs_core::bind::AnyNative>, String> {
            let resource = Arc::new(Resource(AtomicUsize::new(0)));
            let r: Arc<dyn Retire> = resource.clone();
            TeardownScope::current().expect("scope").register(Arc::downgrade(&r));
            *FAILING_RESOURCE.lock().unwrap() = Some(resource);
            Err("instantiate failed after registering".into())
        }
        static FAILING: ModuleDef = ModuleDef { name: "TeardownHookFailing", hash: "test", methods: &METHODS, scalars: &[], native_types: &TYPES, instantiate: instantiate_then_fail, call };

        #[test]
        fn a_failed_instantiate_retires_what_it_registered() {
            let notifier = Notifier { notify: noop, delivery: queued, release: noop, ctx: std::ptr::null_mut() };
            assert!(RnrsAdapter::new(&FAILING, 4, budget().clone(), notifier).is_err());
            let resource = FAILING_RESOURCE.lock().unwrap().clone().expect("registered");
            assert_eq!(resource.0.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn empty_foreign_slices_never_reach_from_raw_parts() {
        let empty: &[u32] = unsafe { slice_or_empty(std::ptr::null(), 0) };
        assert!(empty.is_empty());
        // A null pointer with a nonzero length is a caller bug, but still not UB here.
        let none: &[u8] = unsafe { slice_or_empty(std::ptr::null(), 5) };
        assert!(none.is_empty());
        let data = [1u32, 2, 3];
        assert_eq!(unsafe { slice_or_empty(data.as_ptr(), 3) }, &data);
        assert_eq!(unsafe { str_arg(std::ptr::null(), 0) }, "");
    }

    #[test]
    fn array_lengths_must_be_integers_in_range() {
        assert_eq!(valid_length(0.0), Ok(0));
        assert_eq!(valid_length(4294967295.0), Ok(u32::MAX));
        for bad in [-1.0, 1.5, f64::NAN, f64::INFINITY, 4294967296.0] {
            assert!(valid_length(bad).is_err(), "{bad}");
        }
    }
}

#[cfg(test)]
mod new_numbers_tests {
    use super::*;
    use std::cell::RefCell;

    // A fake C++ side: only `new_numbers` (and `number`, for comparison) may be called.
    #[derive(Default)]
    struct Fake {
        seen: RefCell<Vec<(usize, Vec<u64>)>>,
        throw: bool,
    }
    extern "C" fn new_numbers(ctx: *mut c_void, data: *const f64, len: u32, out: *mut u32) -> bool {
        let fake = unsafe { &*(ctx as *const Fake) };
        let values = if len == 0 { Vec::new() } else { unsafe { std::slice::from_raw_parts(data, len as usize) }.iter().map(|x| x.to_bits()).collect() };
        fake.seen.borrow_mut().push((len as usize, values));
        unsafe { *out = 7 };
        !fake.throw
    }
    extern "C" fn no_u32(_: *mut c_void, _: u32) -> u32 { unreachable!() }
    extern "C" fn no_f64(_: *mut c_void, _: u32) -> f64 { unreachable!() }
    extern "C" fn no_bool(_: *mut c_void, _: u32) -> bool { unreachable!() }
    extern "C" fn no_prop(_: *mut c_void, _: u32, _: *const u8, _: usize, _: *mut u32) -> bool { unreachable!() }
    extern "C" fn no_len(_: *mut c_void, _: u32, _: *mut f64) -> bool { unreachable!() }
    extern "C" fn no_index(_: *mut c_void, _: u32, _: u32, _: *mut u32) -> bool { unreachable!() }
    extern "C" fn no_value(_: *mut c_void) -> u32 { unreachable!() }
    extern "C" fn no_number(_: *mut c_void, _: f64) -> u32 { unreachable!() }
    extern "C" fn no_boolean(_: *mut c_void, _: bool) -> u32 { unreachable!() }
    extern "C" fn no_string(_: *mut c_void, _: *const u8, _: usize) -> u32 { unreachable!() }
    extern "C" fn no_set_property(_: *mut c_void, _: u32, _: *const u8, _: usize, _: u32) -> bool { unreachable!() }
    extern "C" fn no_set_index(_: *mut c_void, _: u32, _: u32, _: u32) -> bool { unreachable!() }
    extern "C" fn no_wrap(_: *mut c_void, _: *mut c_void, _: *mut u32) -> bool { unreachable!() }
    extern "C" fn no_unwrap(_: *mut c_void, _: u32, _: *mut *const c_void) -> u32 { unreachable!() }
    extern "C" fn no_to_bytes(_: *mut c_void, _: u32, _: extern "C" fn(*mut c_void, usize) -> *mut u8, _: *mut c_void) -> u32 { unreachable!() }
    extern "C" fn no_new_bytes(_: *mut c_void, _: *mut u8, _: usize, _: usize, _: *mut u32) { unreachable!() }
    extern "C" fn no_to_string(_: *mut c_void, _: u32, _: extern "C" fn(*mut c_void, usize) -> *mut u8, _: *mut c_void) -> usize { unreachable!() }
    extern "C" fn no_numbers_in(_: *mut c_void, _: u32, _: u32, _: extern "C" fn(*mut c_void, usize, usize) -> *mut f64, _: *mut c_void, _: *mut u32, _: *mut u32) -> u32 { unreachable!() }
    extern "C" fn no_entries(_: *mut c_void, _: u32, _: *mut u32) -> u32 { unreachable!() }

    const VT: JsiVTable = JsiVTable {
        kind: no_u32, to_number: no_f64, to_bool: no_bool, get_property: no_prop, array_length: no_len, get_index: no_index,
        undefined: no_value, null: no_value, number: no_number, boolean: no_boolean, string: no_string, object: no_value,
        set_property: no_set_property, array: no_u32, set_index: no_set_index, wrap_native: no_wrap, unwrap_native: no_unwrap,
        to_bytes: no_to_bytes, new_bytes: no_new_bytes, to_string_into: no_to_string, number_array: no_numbers_in,
        own_entries: no_entries, new_numbers,
    };

    #[test]
    fn one_call_with_the_borrowed_doubles() {
        let mut fake = Fake::default();
        let values = [1.5, -0.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY];
        {
            let mut env = unsafe { JsiEnv::new(&VT, &raw mut fake as *mut c_void, 3) };
            assert_eq!(env.new_number_array(&values), Ok(Val::new(7, 3)));
            // Through the generated writer too; empty arrays still make one call (len 0).
            assert_eq!(rnrs_core::bind::number_array_into_js(Vec::new(), &mut env), Ok(Val::new(7, 3)));
        }
        let seen = fake.seen.borrow();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0], (5, values.iter().map(|x| x.to_bits()).collect()));
        assert_eq!(seen[1], (0, vec![]));
    }

    #[test]
    fn false_is_a_retained_exception() {
        let mut fake = Fake { throw: true, ..Fake::default() };
        let mut env = unsafe { JsiEnv::new(&VT, &raw mut fake as *mut c_void, 1) };
        assert_eq!(env.new_number_array(&[1.0]), Err(BindError::Thrown));
    }
}

/// Attribution counters (diagnostics builds only): writes [allocations, allocated bytes,
/// events 0..8] to `out` (10 values). Rust-side event 4 counts adapter calls.
///
/// # Safety
/// `out` points to 10 writable u64.
#[cfg(feature = "diagnostics")]
pub unsafe extern "C" fn rnrs_diagnostics(out: *mut u64) {
    let snapshot = rnrs_core::diagnostics::snapshot();
    unsafe { std::ptr::copy_nonoverlapping(snapshot.as_ptr(), out, snapshot.len()) };
}

/// A String from UTF-8 bytes with the documented lossy policy (invalid sequences become
/// U+FFFD), byte-identical to `String::from_utf8_lossy(&bytes).into_owned()`: valid input (the
/// normal case) is validated in place with `str::from_utf8`, which is much faster than the
/// lossy decoder's chunk walk, and kept without a copy; only invalid input takes the lossy
/// path.
pub(crate) fn utf8_from_vec(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

#[cfg(test)]
mod utf8_tests {
    use super::utf8_from_vec;

    #[test]
    fn identical_to_the_lossy_conversion() {
        let mut cases: Vec<Vec<u8>> = vec![
            vec![], b"ascii".to_vec(), "é漢😀".as_bytes().to_vec(), vec![0], vec![0xff], vec![0xc3], vec![0xe6, 0xbc],
            vec![0xed, 0xa0, 0x80], // an encoded lone surrogate (invalid UTF-8)
            vec![0xf4, 0x90, 0x80, 0x80], vec![b'a', 0x80, b'b'], vec![0xf0, 0x9f, 0x98], "x".repeat(70_000).into_bytes(),
        ];
        let mut long = "aé漢😀".repeat(20_000).into_bytes();
        long.insert(12_345, 0xfe);
        cases.push(long);
        for bytes in cases {
            assert_eq!(utf8_from_vec(bytes.clone()), String::from_utf8_lossy(&bytes).into_owned(), "{:?}", &bytes[..bytes.len().min(16)]);
        }
    }
}

/// Called once by the framework's Kotlin module (through JNI) with the app's private data
/// directory, before modules are created. Returns false if the path is not UTF-8 or a
/// different directory was already set.
///
/// # Safety
/// `(ptr, len)` is a readable byte range for the duration of the call.
pub unsafe extern "C" fn rnrs_set_app_data_dir(ptr: *const u8, len: usize) -> bool {
    let bytes = if len == 0 { &[][..] } else { std::slice::from_raw_parts(ptr, len) };
    match std::str::from_utf8(bytes) {
        Ok(path) if !path.is_empty() => rnrs_core::platform::set_app_data_dir(path.into()).is_ok(),
        _ => false,
    }
}

#[cfg(test)]
mod scalar_tests {
    use super::*;
    use rnrs_core::bind::{AnyNative, ScalarDef};
    use std::sync::atomic::AtomicUsize;
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    static DROPS: AtomicUsize = AtomicUsize::new(0);
    struct Instance;
    impl Drop for Instance { fn drop(&mut self) { DROPS.fetch_add(1, Ordering::SeqCst); } }
    static DEF: ModuleDef = ModuleDef {
        name: "ScalarProbe", hash: "test", methods: &[], native_types: &[],
        instantiate: || Ok(Box::new(Instance)),
        call: |_, _, _, _| unreachable!(),
        scalars: &[ScalarDef {
            method: 3, args: 1, result: 1,
            instance: |v: &AnyNative| v.downcast_ref::<Instance>().unwrap() as *const Instance as *const (),
            call: |p, args| {
                let _instance = unsafe { &*p.cast::<Instance>() };
                CALLS.fetch_add(1, Ordering::SeqCst);
                if args[0] == 42.0 { Err("scalar failed".into()) } else { Ok(args[0]) }
            },
        }],
    };
    extern "C" fn noop(_: *mut c_void) {}
    extern "C" fn delivery(_: *mut c_void) -> u8 { 0 }
    #[test]
    fn scalar_binding_preserves_values_errors_and_owner_until_drop() {
        let notifier = Notifier { notify: noop, release: noop, delivery, ctx: std::ptr::null_mut() };
        let adapter = RnrsAdapter::new(&DEF, 4, Budget::new(4), notifier).unwrap();
        let mut binding = std::mem::MaybeUninit::uninit();
        let mut method = 0;
        assert!(unsafe { rnrs_adapter_scalar(&adapter, 0, &mut method, binding.as_mut_ptr()) });
        assert_eq!(method, 3);
        let binding = unsafe { binding.assume_init() };
        let mut out = 0.0;
        let mut kind = 0;
        let mut error = [0u8; 512];
        for value in [-0.0f64, f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
            let args = [value, 0.0, 0.0, 0.0];
            assert_eq!(unsafe { rnrs_scalar_call(&adapter, &binding, &args, &mut out, &mut kind, error.as_mut_ptr(), error.len()) }, RNRS_CALL_OK);
            assert_eq!(out.to_bits(), value.to_bits());
        }
        let args = [42.0, 0.0, 0.0, 0.0];
        assert_eq!(unsafe { rnrs_scalar_call(&adapter, &binding, &args, &mut out, &mut kind, error.as_mut_ptr(), error.len()) }, RNRS_CALL_ERROR);
        assert_eq!(kind, 2);
        assert_eq!(&error[..14], b"scalar failed\0");
        adapter.teardown(0);
        assert_eq!(DROPS.load(Ordering::SeqCst), 0);
        assert_eq!(unsafe { rnrs_scalar_call(&adapter, &binding, &args, &mut out, &mut kind, error.as_mut_ptr(), error.len()) }, RNRS_CALL_ERROR);
        assert_eq!(CALLS.load(Ordering::SeqCst), 5);
        assert_eq!(&error[..26], b"runtime adapter is closed\0");
        drop(adapter);
        assert_eq!(DROPS.load(Ordering::SeqCst), 1);
    }
}

/// The ABI contract, pinned identically by the static_asserts in packages/runtime/cpp/RnrsAbi.h.
/// Changing anything here (order, size, a constant) requires bumping RNRS_ABI in both places.
#[cfg(test)]
mod abi_contract {
    use super::*;
    use std::mem::{offset_of, size_of};

    const P: usize = size_of::<usize>();

    #[test]
    fn module_table_layout() {
        assert_eq!(RNRS_ABI, 5);
        assert_eq!((offset_of!(ModuleTable, abi), offset_of!(ModuleTable, size)), (0, 4), "frozen prefix");
        assert_eq!((offset_of!(ModuleTable, vtable_size), offset_of!(ModuleTable, scalar_binding_size)), (8, 12));
        let slots = [
            offset_of!(ModuleTable, name), offset_of!(ModuleTable, name_len), offset_of!(ModuleTable, hash),
            offset_of!(ModuleTable, hash_len), offset_of!(ModuleTable, build), offset_of!(ModuleTable, build_len),
            offset_of!(ModuleTable, def), offset_of!(ModuleTable, init), offset_of!(ModuleTable, set_app_data_dir),
            offset_of!(ModuleTable, adapter_new), offset_of!(ModuleTable, adapter_scalar), offset_of!(ModuleTable, scalar_call),
            offset_of!(ModuleTable, adapter_call), offset_of!(ModuleTable, adapter_drain), offset_of!(ModuleTable, adapter_stats),
            offset_of!(ModuleTable, adapter_cancel), offset_of!(ModuleTable, adapter_teardown), offset_of!(ModuleTable, adapter_free),
            offset_of!(ModuleTable, adapter_method_find), offset_of!(ModuleTable, native_share),
            offset_of!(ModuleTable, native_spec_name), offset_of!(ModuleTable, native_release), offset_of!(ModuleTable, bytes_free),
            offset_of!(ModuleTable, diagnostics), offset_of!(ModuleTable, surface),
        ];
        for (i, offset) in slots.into_iter().enumerate() {
            assert_eq!(offset, 16 + i * P, "ModuleTable slot {i}");
        }
        assert_eq!(size_of::<ModuleTable>(), 16 + 25 * P);
    }

    #[test]
    fn vtable_and_binding_layout() {
        let slots = [
            offset_of!(JsiVTable, kind), offset_of!(JsiVTable, to_number), offset_of!(JsiVTable, to_bool),
            offset_of!(JsiVTable, get_property), offset_of!(JsiVTable, array_length), offset_of!(JsiVTable, get_index),
            offset_of!(JsiVTable, undefined), offset_of!(JsiVTable, null), offset_of!(JsiVTable, number),
            offset_of!(JsiVTable, boolean), offset_of!(JsiVTable, string), offset_of!(JsiVTable, object),
            offset_of!(JsiVTable, set_property), offset_of!(JsiVTable, array), offset_of!(JsiVTable, set_index),
            offset_of!(JsiVTable, wrap_native), offset_of!(JsiVTable, unwrap_native), offset_of!(JsiVTable, to_bytes),
            offset_of!(JsiVTable, new_bytes), offset_of!(JsiVTable, to_string_into), offset_of!(JsiVTable, number_array),
            offset_of!(JsiVTable, own_entries), offset_of!(JsiVTable, new_numbers),
        ];
        for (i, offset) in slots.into_iter().enumerate() {
            assert_eq!(offset, i * P, "JsiVTable slot {i}");
        }
        assert_eq!(size_of::<JsiVTable>(), 23 * P);
        assert_eq!(
            (offset_of!(ScalarBinding, args), offset_of!(ScalarBinding, result), offset_of!(ScalarBinding, definition), offset_of!(ScalarBinding, instance)),
            (0, 4, 8, 8 + P)
        );
        assert_eq!(size_of::<ScalarBinding>(), 8 + 2 * P);
    }

    #[test]
    fn exchanged_values() {
        use rnrs_core::bind::{BytesError, ADMIT_CLOSED, ADMIT_OVERLOADED, ADMIT_SATURATED, SETTLE_CANCELLED, SETTLE_DOMAIN, SETTLE_FAILED, SETTLE_LOST, SETTLE_OK};
        // kind(): kKind* in RnrsAbi.h.
        assert_eq!(KINDS, [Kind::Undefined, Kind::Null, Kind::Boolean, Kind::Number, Kind::String, Kind::Array, Kind::Function, Kind::Object, Kind::Other]);
        // toBytes(): kBytes* (1 and anything unknown: not an ArrayBuffer).
        assert_eq!(BytesError::from_status(0), None);
        assert_eq!(
            (1..=7).map(|s| BytesError::from_status(s).unwrap()).collect::<Vec<_>>(),
            [BytesError::NotArrayBuffer, BytesError::Shared, BytesError::Resizable, BytesError::Detached, BytesError::View, BytesError::Thrown, BytesError::TooLarge]
        );
        assert_eq!((RNRS_NUMBERS_OK, RNRS_NUMBERS_INVALID, RNRS_NUMBERS_THROWN), (0, 1, 2));
        assert_eq!((RNRS_ENTRIES_OK, RNRS_ENTRIES_NOT_PLAIN, RNRS_ENTRIES_THROWN), (0, 1, 2));
        assert_eq!((RNRS_UNWRAP_OK, RNRS_UNWRAP_NOT_NATIVE, RNRS_UNWRAP_CLOSED, RNRS_UNWRAP_DISPOSED), (0, 1, 2, 3));
        assert_eq!((RNRS_DELIVERY_QUEUED, RNRS_DELIVERY_RUNNING, RNRS_DELIVERY_DONE, RNRS_DELIVERY_DROPPED), (0, 1, 2, 3));
        // Values the binary produces for the JS runtime (settle status, admission failure code).
        assert_eq!((SETTLE_OK, SETTLE_CANCELLED, SETTLE_FAILED, SETTLE_LOST, SETTLE_DOMAIN), (0, 1, 2, 3, 4));
        assert_eq!((ADMIT_CLOSED, ADMIT_OVERLOADED, ADMIT_SATURATED), (-1.0, -2.0, -3.0));
    }

    #[test]
    fn status_codes() {
        assert_eq!((RNRS_CALL_OK, RNRS_CALL_ERROR, RNRS_CALL_THROWN, RNRS_CALL_DOMAIN), (0, 1, 2, 3));
        assert_eq!((RNRS_TEARDOWN_EXPLICIT, RNRS_TEARDOWN_LIFECYCLE, RNRS_TEARDOWN_DESTRUCTOR, RNRS_TEARDOWN_REFUSED), (0, 1, 2, 3));
        assert_eq!([ErrorKind::TypeError, ErrorKind::RangeError, ErrorKind::Error].map(error_kind_code), [0, 1, 2]);
    }
}

#[cfg(test)]
mod declared_error_tests {
    //! `rnrs_adapter_call` reports a declared error (spec `Throws<T, E>`) as `RNRS_CALL_DOMAIN`
    //! with the converted value in `out` and no message.
    use super::*;
    use rnrs_core::bind::{domain_error, Call, MethodDef};

    /// A call context that only records the values it creates: (kind, payload).
    #[derive(Default)]
    struct Ctx(Vec<(&'static str, String)>);
    fn ctx<'a>(raw: *mut c_void) -> &'a mut Ctx {
        unsafe { &mut *raw.cast::<Ctx>() }
    }
    fn push(raw: *mut c_void, kind: &'static str, payload: String) -> u32 {
        ctx(raw).0.push((kind, payload));
        ctx(raw).0.len() as u32 - 1
    }
    extern "C" fn string(raw: *mut c_void, p: *const u8, n: usize) -> u32 {
        let text = unsafe { str_arg(p, n) }.to_owned();
        push(raw, "string", text)
    }
    extern "C" fn object(raw: *mut c_void) -> u32 {
        push(raw, "object", String::new())
    }
    extern "C" fn undefined(raw: *mut c_void) -> u32 {
        push(raw, "undefined", String::new())
    }
    extern "C" fn set_property(raw: *mut c_void, o: u32, p: *const u8, n: usize, v: u32) -> bool {
        let entry = format!("{}={}", unsafe { str_arg(p, n) }, ctx(raw).0[v as usize].1);
        let target = &mut ctx(raw).0[o as usize].1;
        if !target.is_empty() {
            target.push(',');
        }
        target.push_str(&entry);
        true
    }
    // Entries this test never reaches (no argument is read, no other value is created).
    extern "C" fn kind(_: *mut c_void, _: u32) -> u32 { unreachable!() }
    extern "C" fn to_number(_: *mut c_void, _: u32) -> f64 { unreachable!() }
    extern "C" fn to_bool(_: *mut c_void, _: u32) -> bool { unreachable!() }
    extern "C" fn get_property(_: *mut c_void, _: u32, _: *const u8, _: usize, _: *mut u32) -> bool { unreachable!() }
    extern "C" fn array_length(_: *mut c_void, _: u32, _: *mut f64) -> bool { unreachable!() }
    extern "C" fn get_index(_: *mut c_void, _: u32, _: u32, _: *mut u32) -> bool { unreachable!() }
    extern "C" fn null(_: *mut c_void) -> u32 { unreachable!() }
    extern "C" fn number(_: *mut c_void, _: f64) -> u32 { unreachable!() }
    extern "C" fn boolean(_: *mut c_void, _: bool) -> u32 { unreachable!() }
    extern "C" fn array(_: *mut c_void, _: u32) -> u32 { unreachable!() }
    extern "C" fn set_index(_: *mut c_void, _: u32, _: u32, _: u32) -> bool { unreachable!() }
    extern "C" fn wrap_native(_: *mut c_void, _: *mut c_void, _: *mut u32) -> bool { unreachable!() }
    extern "C" fn unwrap_native(_: *mut c_void, _: u32, _: *mut *const c_void) -> u32 { unreachable!() }
    extern "C" fn to_bytes(_: *mut c_void, _: u32, _: extern "C" fn(*mut c_void, usize) -> *mut u8, _: *mut c_void) -> u32 { unreachable!() }
    extern "C" fn new_bytes(_: *mut c_void, _: *mut u8, _: usize, _: usize, _: *mut u32) { unreachable!() }
    extern "C" fn to_string_into(_: *mut c_void, _: u32, _: extern "C" fn(*mut c_void, usize) -> *mut u8, _: *mut c_void) -> usize { unreachable!() }
    extern "C" fn number_array(_: *mut c_void, _: u32, _: u32, _: extern "C" fn(*mut c_void, usize, usize) -> *mut f64, _: *mut c_void, _: *mut u32, _: *mut u32) -> u32 { unreachable!() }
    extern "C" fn own_entries(_: *mut c_void, _: u32, _: *mut u32) -> u32 { unreachable!() }
    extern "C" fn new_numbers(_: *mut c_void, _: *const f64, _: u32, _: *mut u32) -> bool { unreachable!() }
    static VT: JsiVTable = JsiVTable {
        kind, to_number, to_bool, get_property, array_length, get_index, undefined, null, number, boolean, string, object, set_property,
        array, set_index, wrap_native, unwrap_native, to_bytes, new_bytes, to_string_into, number_array, own_entries, new_numbers,
    };

    static METHODS: [MethodDef; 1] = [MethodDef { name: "busy", kind: MethodKind::Sync }];
    struct Instance;
    static DEF: ModuleDef = ModuleDef {
        name: "DeclaredErrorProbe", hash: "test", methods: &METHODS, scalars: &[], native_types: &[],
        instantiate: || Ok(Box::new(Instance)),
        // What generated glue does for `Err(LookupError::Busy)`.
        call: |cx: &mut Call<'_>, _, _, _| {
            Err(domain_error(cx.env, |env| {
                let o = env.object();
                let tag = env.string("busy");
                env.set_property(o, "kind", tag)?;
                Ok(o)
            }))
        },
    };
    extern "C" fn noop(_: *mut c_void) {}
    extern "C" fn delivery(_: *mut c_void) -> u8 { 0 }

    #[test]
    fn a_declared_error_returns_its_value_with_status_domain() {
        let notifier = Notifier { notify: noop, release: noop, delivery, ctx: std::ptr::null_mut() };
        let adapter = RnrsAdapter::new(&DEF, 4, Budget::new(4), notifier).unwrap();
        let mut c = Ctx::default();
        let this = push(&mut c as *mut Ctx as *mut c_void, "undefined", String::new());
        let (mut out, mut kind, mut error) = (u32::MAX, u32::MAX, [0u8; 64]);
        let status = unsafe {
            rnrs_adapter_call(&adapter, &VT, &mut c as *mut Ctx as *mut c_void, 7, 0, this, std::ptr::null(), 0, &mut out, &mut kind,
                error.as_mut_ptr(), error.len())
        };
        assert_eq!(status, RNRS_CALL_DOMAIN);
        assert_eq!(c.0[out as usize], ("object", "kind=busy".to_string()));
        assert_eq!((kind, error[0]), (u32::MAX, 0), "no error kind or message is written");
        adapter.teardown(0);
    }
}
