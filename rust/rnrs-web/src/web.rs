//! The wasm32 backend (see the crate docs).
use std::cell::{Cell, OnceCell, RefCell};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use js_sys::{Array, Function, Reflect};
use rnrs_core::bind::{expected, valid_length, Adapter, BindError, BytesError, Env, ErrorKind, Kind, ModuleDef, NativeBox, Path, Spawner, UnwrapError, Val};
use rnrs_core::{Budget, Notify, SpawnLocal};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

static HOSTS_CREATED: AtomicU64 = AtomicU64::new(0);
static HOSTS_TORN_DOWN: AtomicU64 = AtomicU64::new(0);
static HOSTS_FREED: AtomicU64 = AtomicU64::new(0);


pub(crate) static MODULES: OnceLock<&'static [&'static ModuleDef]> = OnceLock::new();

/// Registers the app's generated modules (called once by the bundle crate's start hook).
pub fn register(modules: &'static [&'static ModuleDef]) {
    let _ = MODULES.set(modules);
}


struct Microtasks;

impl SpawnLocal for Microtasks {
    fn spawn_local(&self, task: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'static>>) {
        wasm_bindgen_futures::spawn_local(task);
    }
}

static MICROTASKS: Microtasks = Microtasks;

/// Calls a JS function that schedules a drain; it must not call back into the adapter
/// synchronously (it is invoked while the host lock is held).
struct JsNotify(Function);

impl Notify for JsNotify {
    fn notify(&self) {
        let _ = self.0.call0(&JsValue::UNDEFINED);
    }
}

// ---- Native slab ---------------------------------------------------------------------

struct Entry {
    version: u32,
    /// Module name (`ModuleDef::name`): wrappers of other modules are a type mismatch.
    module: &'static str,
    generation: u64,
    native: Option<Rc<NativeBox>>,
}

thread_local! {
    static SLAB: RefCell<(Vec<Entry>, Vec<u32>)> = const { RefCell::new((Vec::new(), Vec::new())) };
}

fn slab_insert(module: &'static str, generation: u64, native: NativeBox) -> (u32, u32) {
    SLAB.with(|s| {
        let (entries, free) = &mut *s.borrow_mut();
        let native = Some(Rc::new(native));
        if let Some(slot) = free.pop() {
            let e = &mut entries[slot as usize];
            e.version = e.version.wrapping_add(1);
            e.module = module;
            e.generation = generation;
            e.native = native;
            (slot, e.version)
        } else {
            entries.push(Entry { version: 1, module, generation, native });
            (entries.len() as u32 - 1, 1)
        }
    })
}

/// `Ok(native)` for a live wrapper of `generation`.
fn slab_get(slot: u32, version: u32, module: &str, generation: u64) -> Result<Rc<NativeBox>, UnwrapError> {
    SLAB.with(|s| {
        let (entries, _) = &*s.borrow();
        let e = entries.get(slot as usize).filter(|e| e.version == version).ok_or(UnwrapError::NotNative)?;
        if e.module != module {
            return Err(UnwrapError::NotNative);
        }
        if e.generation != generation {
            return Err(UnwrapError::Closed);
        }
        e.native.clone().ok_or(UnwrapError::Disposed)
    })
}

/// `dispose()`: releases the native now; the slot stays reserved for the wrapper.
fn slab_dispose(slot: u32, version: u32) {
    let released = SLAB.with(|s| {
        let (entries, _) = &mut *s.borrow_mut();
        entries.get_mut(slot as usize).filter(|e| e.version == version).and_then(|e| e.native.take())
    });
    drop(released); // outside the borrow: dropping may run arbitrary Rust drops
}

/// Called by the wrappers' FinalizationRegistry: frees the slot for reuse.
#[wasm_bindgen]
pub fn rnrs_release_slot(slot: u32, version: u32) {
    let released = SLAB.with(|s| {
        let (entries, free) = &mut *s.borrow_mut();
        match entries.get_mut(slot as usize) {
            Some(e) if e.version == version => {
                free.push(slot);
                e.native.take()
            }
            _ => None,
        }
    });
    drop(released);
}

// ---- Diagnostics (feature `diagnostics` only) ------------------------------------------

/// Attribution events: 0 helper lookups, 1 helper calls, 2 property-key strings created,
/// 3 arena puts, 4 adapter calls. No-ops unless built with `diagnostics`.
#[inline(always)]
fn diag(_event: usize) {
    #[cfg(feature = "diagnostics")]
    rnrs_core::diagnostics::count(_event);
}

/// [allocations, allocated bytes, events 0..8] (diagnostics builds only).
#[cfg(feature = "diagnostics")]
#[wasm_bindgen]
pub fn rnrs_diagnostics() -> Vec<f64> {
    rnrs_core::diagnostics::snapshot().iter().map(|&x| x as f64).collect()
}

// ---- Helpers -------------------------------------------------------------------------

const HELPER_NAMES: [&str; 10] = ["get", "define", "isArray", "length", "byteLength", "copyBuffer", "bytesFromMemory", "numbers", "wrap", "unwrap"];

/// Elements per `numbers` helper call: the destination grows per chunk, as the generic
/// reader's capacity does, so a lying `length` never reserves memory up front.
const NUMBER_CHUNK: u32 = 4096;

/// The adapter's helpers object (the framework's frozen conversion helpers plus wrap/unwrap)
/// and its functions, each resolved once, at first use, and kept for the adapter's lifetime
/// next to the object itself (same owner, same thread, released together). The object is
/// frozen, so a cached function is the one a fresh lookup would return.
struct Helpers {
    object: JsValue,
    resolved: [OnceCell<Option<Function>>; HELPER_NAMES.len()],
}

impl Helpers {
    fn new(object: JsValue) -> Self {
        Helpers { object, resolved: Default::default() }
    }
    /// The helper, or None if this helpers object lacks it (an older @rnrs/runtime).
    fn find(&self, name: &str) -> Option<&Function> {
        let i = HELPER_NAMES.iter().position(|n| *n == name).expect("known helper");
        self.resolved[i]
            .get_or_init(|| {
                diag(0);
                Reflect::get(&self.object, &JsValue::from_str(name)).ok().and_then(|f| f.dyn_into().ok())
            })
            .as_ref()
    }
    fn get(&self, name: &str) -> &Function {
        self.find(name).expect("rnrs-web helpers")
    }
}

// ---- Env -----------------------------------------------------------------------------

pub struct WebEnv<'a> {
    module: &'static str,
    arena: Vec<JsValue>,
    epoch: u32,
    generation: u64,
    /// The adapter's live torn-down flag: JS run during conversion may tear it down.
    torn_down: &'a Cell<bool>,
    helpers: &'a Helpers,
    /// Natives unwrapped during this call (kept alive while borrowed).
    held: Vec<Rc<NativeBox>>,
    thrown: Option<JsValue>,
}

impl<'a> WebEnv<'a> {
    fn new(module: &'static str, generation: u64, torn_down: &'a Cell<bool>, helpers: &'a Helpers) -> Self {
        static EPOCH: AtomicU64 = AtomicU64::new(1);
        Self { module, arena: Vec::new(), epoch: EPOCH.fetch_add(1, Ordering::Relaxed) as u32, generation, torn_down, helpers, held: Vec::new(), thrown: None }
    }
    fn put(&mut self, v: JsValue) -> Val {
        diag(3);
        self.arena.push(v);
        Val::new(self.arena.len() as u32 - 1, self.epoch)
    }
    fn get(&self, v: Val) -> &JsValue {
        assert_eq!(v.epoch(), self.epoch, "JS value handle used outside the call that created it");
        &self.arena[v.index() as usize]
    }
    fn caught<T>(&mut self, r: Result<T, JsValue>) -> Result<T, BindError> {
        r.map_err(|e| {
            self.thrown = Some(e);
            BindError::Thrown
        })
    }
    fn helper(&self, name: &str) -> &'a Function {
        self.helpers.get(name)
    }
    fn open(&self) -> bool {
        !self.torn_down.get()
    }
    /// Calls a framework helper; JS exceptions (getters, proxy traps) become `Thrown`.
    /// Arguments are passed directly (no JS array is built, so `Array.prototype` setters
    /// cannot intercept them).
    fn call_helper(&mut self, name: &str, args: &[&JsValue]) -> Result<JsValue, BindError> {
        diag(1);
        let f = self.helper(name);
        let this = JsValue::UNDEFINED;
        let r = match args {
            [a] => f.call1(&this, a),
            [a, b] => f.call2(&this, a, b),
            [a, b, c] => f.call3(&this, a, b, c),
            [a, b, c, d] => f.call4(&this, a, b, c, d),
            [a, b, c, d, e] => f.call5(&this, a, b, c, d, e),
            _ => unreachable!("helpers take one to five arguments"),
        };
        self.caught(r)
    }
}

impl Env for WebEnv<'_> {
    fn kind(&mut self, v: Val) -> Kind {
        let x = self.get(v);
        if x.is_undefined() {
            Kind::Undefined
        } else if x.is_null() {
            Kind::Null
        } else if x.as_bool().is_some() {
            Kind::Boolean
        } else if x.as_f64().is_some() {
            Kind::Number
        } else if x.is_string() {
            Kind::String
        } else if x.is_function() {
            Kind::Function
        } else if x.is_object() {
            // Array.isArray semantics through the framework helper; a throwing check (a revoked
            // proxy) reads as an unsupported value, as on Android.
            let x = x.clone();
            match self.call_helper("isArray", &[&x]) {
                Ok(v) if v.as_bool() == Some(true) => Kind::Array,
                Ok(_) => Kind::Object,
                Err(_) => {
                    self.thrown = None;
                    Kind::Other
                }
            }
        } else {
            Kind::Other
        }
    }
    fn to_number(&mut self, v: Val) -> f64 {
        self.get(v).as_f64().unwrap_or(f64::NAN)
    }
    fn to_bool(&mut self, v: Val) -> bool {
        self.get(v).as_bool().unwrap_or(false)
    }
    fn to_string(&mut self, v: Val) -> String {
        // wasm-bindgen encodes with TextEncoder: lone surrogates become U+FFFD.
        self.get(v).as_string().unwrap_or_default()
    }
    // One wasm-bindgen typeof check each (kind() costs up to four crossings for a number).
    fn number_value(&mut self, v: Val) -> Option<f64> {
        self.get(v).as_f64()
    }
    fn bool_value(&mut self, v: Val) -> Option<bool> {
        self.get(v).as_bool()
    }
    fn string_value(&mut self, v: Val) -> Option<String> {
        // wasm-bindgen encodes with TextEncoder: lone surrogates become U+FFFD.
        self.get(v).as_string()
    }
    fn get_property(&mut self, object: Val, key: &str) -> Result<Val, BindError> {
        let o = self.get(object).clone();
        diag(2);
        // Ordinary read (`object[key]`, prototype-inclusive) through the captured Reflect.get.
        let v = self.call_helper("get", &[&o, &JsValue::from_str(key)])?;
        Ok(self.put(v))
    }
    fn array_length(&mut self, array: Val) -> Result<u32, BindError> {
        let a = self.get(array).clone();
        let v = self.call_helper("length", &[&a])?;
        valid_length(v.as_f64().unwrap_or(f64::NAN))
    }
    /// Fused: one `numbers` helper call per chunk reads the elements in JS (ordinary reads,
    /// in order, stopping at the first non-number) straight into the Vec's spare capacity,
    /// instead of several JS/Wasm crossings per element. Same checks, length read, error
    /// texts and exception identity as the generic reader.
    fn number_array(&mut self, v: Val, path: &Path<'_>) -> Result<Vec<f64>, BindError> {
        if self.helpers.find("numbers").is_none() {
            // Helpers from an @rnrs/runtime older than this bundle: read element by element.
            return number_array_by_element(self, v, path);
        }
        if self.kind(v) != Kind::Array {
            return Err(expected(self, v, path, "an array"));
        }
        let length = self.array_length(v)?;
        let array = self.get(v).clone();
        let memory = wasm_bindgen::memory();
        let mut out: Vec<f64> = Vec::new();
        while (out.len() as u32) < length {
            let start = out.len() as u32;
            let count = (length - start).min(NUMBER_CHUNK);
            out.reserve(count as usize);
            // The helper writes `count` f64 slots here (8-aligned, inside the reservation),
            // re-deriving its view if re-entrant JS grew Wasm memory. No Rust reference to
            // the spare capacity exists while it runs.
            let ptr = out.spare_capacity_mut().as_mut_ptr() as usize as f64;
            let stop = self.call_helper("numbers", &[&array, &JsValue::from(start), &JsValue::from(count), &memory, &JsValue::from_f64(ptr)])?;
            if stop.is_undefined() {
                // SAFETY: the helper returned normally having written all `count` slots.
                unsafe { out.set_len((start + count) as usize) };
                continue;
            }
            // `[index, value]` of the first non-number; nothing after it was read.
            let stop: Array = stop.unchecked_into();
            let index = stop.get(0).as_f64().unwrap_or(0.0) as u32;
            let element = self.put(stop.get(1));
            return Err(expected(self, element, &path.index(index), "a number"));
        }
        Ok(out)
    }
    fn get_index(&mut self, array: Val, index: u32) -> Result<Val, BindError> {
        let a = self.get(array).clone();
        let v = self.call_helper("get", &[&a, &JsValue::from(index)])?;
        Ok(self.put(v))
    }
    fn undefined(&mut self) -> Val {
        self.put(JsValue::UNDEFINED)
    }
    fn null(&mut self) -> Val {
        self.put(JsValue::NULL)
    }
    fn number(&mut self, value: f64) -> Val {
        self.put(JsValue::from_f64(value))
    }
    fn boolean(&mut self, value: bool) -> Val {
        self.put(JsValue::from_bool(value))
    }
    fn string(&mut self, value: &str) -> Val {
        self.put(JsValue::from_str(value))
    }
    fn object(&mut self) -> Val {
        self.put(js_sys::Object::new().into())
    }
    fn set_property(&mut self, object: Val, key: &str, value: Val) -> Result<(), BindError> {
        let (o, v) = (self.get(object).clone(), self.get(value).clone());
        diag(2);
        self.call_helper("define", &[&o, &JsValue::from_str(key), &v]).map(drop)
    }
    fn array(&mut self, length: u32) -> Val {
        self.put(Array::new_with_length(length).into())
    }
    fn set_index(&mut self, array: Val, index: u32, value: Val) -> Result<(), BindError> {
        let (a, v) = (self.get(array).clone(), self.get(value).clone());
        self.call_helper("define", &[&a, &JsValue::from(index), &v]).map(drop)
    }
    fn to_bytes(&mut self, v: Val, out: &mut Vec<u8>) -> Result<(), BytesError> {
        // Both helpers use intrinsics captured at init and run no user code: the length is the
        // brand-checked byte length (never a patchable `length` getter), and the copy is
        // bounded by it on both sides. No JS runs between the two calls.
        let x = self.get(v).clone();
        let n = match self.call_helper("byteLength", &[&x]) {
            Ok(n) => n.as_f64().unwrap_or(-1.0),
            Err(_) => return Err(BytesError::Thrown),
        };
        if n < 0.0 {
            return Err(BytesError::from_status((-n) as u32).unwrap_or(BytesError::NotArrayBuffer));
        }
        if n.fract() != 0.0 || n > u32::MAX as f64 {
            return Err(BytesError::NotArrayBuffer);
        }
        let mut storage = rnrs_core::bind::alloc_bytes(n as usize)?;
        let args = [&x, &wasm_bindgen::memory(), &JsValue::from(storage.as_mut_ptr() as usize as f64), &JsValue::from_f64(n)];
        match self.call_helper("copyBuffer", &args) {
            Ok(done) if done.as_bool() == Some(true) => {}
            Ok(_) => return Err(BytesError::Detached),
            Err(_) => return Err(BytesError::Thrown),
        }
        *out = storage;
        Ok(())
    }
    fn new_bytes(&mut self, data: Vec<u8>) -> Result<Val, BindError> {
        // A copy out of Wasm memory into a new JS ArrayBuffer (Wasm memory can grow and move),
        // made by the framework helper with captured intrinsics. `data` stays alive until the
        // copy has returned.
        let args = [&wasm_bindgen::memory(), &JsValue::from(data.as_ptr() as usize as f64), &JsValue::from(data.len() as f64)];
        let buffer = self.call_helper("bytesFromMemory", &args[..])?;
        drop(data);
        Ok(self.put(buffer))
    }
    fn wrap_native(&mut self, object: NativeBox) -> Result<Val, BindError> {
        if !self.open() {
            return Err(BindError::error("runtime adapter is closed"));
        }
        let (slot, version) = slab_insert(self.module, self.generation, object);
        let r = self.helper("wrap").call2(&JsValue::UNDEFINED, &slot.into(), &version.into());
        let wrapper = self.caught(r)?;
        Ok(self.put(wrapper))
    }
    fn unwrap_native(&mut self, v: Val) -> Result<&NativeBox, UnwrapError> {
        let o = self.get(v).clone();
        let found = self.helper("unwrap").call1(&JsValue::UNDEFINED, &o).map_err(|_| UnwrapError::NotNative)?;
        if found.is_null() || found.is_undefined() {
            return Err(UnwrapError::NotNative);
        }
        let pair: Array = found.unchecked_into();
        let (slot, version) = (pair.get(0).as_f64().unwrap_or(-1.0) as u32, pair.get(1).as_f64().unwrap_or(-1.0) as u32);
        if !self.open() {
            return Err(UnwrapError::Closed);
        }
        let native = slab_get(slot, version, self.module, self.generation)?;
        self.held.push(native);
        Ok(self.held.last().unwrap())
    }
}

/// The generic reader (`Env::number_array`'s default): one ordinary read per element.
fn number_array_by_element(env: &mut dyn Env, v: Val, path: &Path<'_>) -> Result<Vec<f64>, BindError> {
    if env.kind(v) != Kind::Array {
        return Err(expected(env, v, path, "an array"));
    }
    let length = env.array_length(v)?;
    let mut out = Vec::with_capacity(length.min(NUMBER_CHUNK) as usize);
    for i in 0..length {
        let element = env.get_index(v, i)?;
        match env.number_value(element) {
            Some(x) => out.push(x),
            None => return Err(expected(env, element, &path.index(i), "a number")),
        }
    }
    Ok(out)
}

fn js_error(error: BindError, thrown: Option<JsValue>) -> JsValue {
    match error {
        BindError::Thrown => thrown.unwrap_or_else(|| js_sys::Error::new("native call failed").into()),
        BindError::Js { kind, message } => match kind {
            ErrorKind::TypeError => js_sys::TypeError::new(&message).into(),
            ErrorKind::RangeError => js_sys::RangeError::new(&message).into(),
            ErrorKind::Error => js_sys::Error::new(&message).into(),
        },
    }
}

// ---- Adapter -------------------------------------------------------------------------

#[wasm_bindgen]
pub struct RnrsWebAdapter {
    adapter: Adapter<JsNotify>,
    helpers: Helpers,
    torn_down: Cell<bool>,
    /// The error of the last failed `scalar` call, until `take_scalar_error`.
    scalar_error: Cell<Option<JsValue>>,
}

impl RnrsWebAdapter {
    fn call_with<const N: usize>(&self, index: u32, receiver: JsValue, args: [JsValue; N]) -> Result<JsValue, JsValue> {
        diag(4);
        let mut env = self.env();
        let this = env.put(receiver);
        let args = args.map(|a| env.put(a));
        match self.adapter.call(&mut env, index, this, &args) {
            Ok(v) => Ok(env.get(v).clone()),
            Err(e) => Err(js_error(e, env.thrown.take())),
        }
    }
}

#[wasm_bindgen]
impl RnrsWebAdapter {
    /// `helpers`: `{wrap(slot, version) -> object, unwrap(object) -> [slot, version] | null}`.
    #[wasm_bindgen(constructor)]
    pub fn new(name: &str, hash: &str, max_in_flight: f64, notify: Function, helpers: JsValue) -> Result<RnrsWebAdapter, JsValue> {
        if !(1.0..=1024.0).contains(&max_in_flight) || max_in_flight.fract() != 0.0 {
            return Err(js_sys::RangeError::new("maxInFlight must be an integer from 1 to 1024").into());
        }
        let modules = MODULES.get().copied().unwrap_or(&[]);
        let def = modules.iter().find(|d| d.name == name).ok_or_else(|| {
            let known: Vec<_> = modules.iter().map(|d| d.name).collect();
            JsValue::from(js_sys::Error::new(&format!("module {name} is not in this app's Wasm bundle (bundled: {})", known.join(", "))))
        })?;
        if def.hash != hash {
            return Err(js_sys::Error::new(&format!(
                "module {name}: JS wrapper (IR {hash}) and Wasm glue (IR {}) were generated from different specs; rebuild both", def.hash)).into());
        }
        let spawner: &'static Spawner = &MICROTASKS;
        let adapter = Adapter::new(def, max_in_flight as usize, Budget::unlimited(), spawner, JsNotify(notify))
            .map_err(|m| JsValue::from(js_sys::Error::new(&m)))?;
        HOSTS_CREATED.fetch_add(1, Ordering::SeqCst);
        Ok(RnrsWebAdapter { adapter, helpers: Helpers::new(helpers), torn_down: Cell::new(false), scalar_error: Cell::new(None) })
    }

    #[wasm_bindgen(getter)]
    pub fn generation(&self) -> f64 {
        self.adapter.generation() as f64
    }

    fn env(&self) -> WebEnv<'_> {
        WebEnv::new(self.adapter.def().name, self.adapter.generation(), &self.torn_down, &self.helpers)
    }

    /// Sync methods return their result; async methods an operation id or `{code, message}`.
    pub fn call(&self, index: u32, receiver: JsValue, args: Array) -> Result<JsValue, JsValue> {
        diag(4);
        let mut env = self.env();
        let this = env.put(receiver);
        let args: Vec<Val> = args.iter().map(|a| env.put(a)).collect();
        match self.adapter.call(&mut env, index, this, &args) {
            Ok(v) => Ok(env.get(v).clone()),
            Err(e) => Err(js_error(e, env.thrown.take())),
        }
    }

    /// Sync calls with 0 to 4 positional arguments (generated wrappers): no JS array is
    /// built or iterated.
    pub fn call0(&self, index: u32, receiver: JsValue) -> Result<JsValue, JsValue> {
        self.call_with(index, receiver, [])
    }
    pub fn call1(&self, index: u32, receiver: JsValue, a0: JsValue) -> Result<JsValue, JsValue> {
        self.call_with(index, receiver, [a0])
    }
    pub fn call2(&self, index: u32, receiver: JsValue, a0: JsValue, a1: JsValue) -> Result<JsValue, JsValue> {
        self.call_with(index, receiver, [a0, a1])
    }
    pub fn call3(&self, index: u32, receiver: JsValue, a0: JsValue, a1: JsValue, a2: JsValue) -> Result<JsValue, JsValue> {
        self.call_with(index, receiver, [a0, a1, a2])
    }
    pub fn call4(&self, index: u32, receiver: JsValue, a0: JsValue, a1: JsValue, a2: JsValue, a3: JsValue) -> Result<JsValue, JsValue> {
        self.call_with(index, receiver, [a0, a1, a2, a3])
    }

    /// The prepared scalar leaf of method `index` (ModuleDef.scalars), as
    /// `[slot, argument kinds (2 bits each: 1 number, 2 boolean), result (0 void, 1 number,
    /// 2 boolean)]`, or undefined if the method has none.
    pub fn scalar_signature(&self, index: u32) -> Option<Vec<u32>> {
        let scalars = self.adapter.def().scalars;
        let slot = scalars.iter().position(|d| d.method == index)?;
        Some(vec![slot as u32, scalars[slot].args, scalars[slot].result])
    }

    /// Calls scalar leaf `slot` with plain f64 slots (booleans as 0/1; unused slots ignored).
    /// The JS entry has already checked every argument's type, so no JS value crosses and no
    /// JS runs. Returns the result as f64; on failure returns NaN and keeps the error for
    /// `take_scalar_error` (the entry asks only when the result is NaN).
    pub fn scalar(&self, slot: u32, a0: f64, a1: f64, a2: f64, a3: f64) -> f64 {
        drop(self.scalar_error.take());
        diag(4);
        let Some(def) = self.adapter.def().scalars.get(slot as usize) else {
            self.scalar_error.set(Some(js_sys::RangeError::new("no scalar entry").into()));
            return f64::NAN;
        };
        let mut args = [a0, a1, a2, a3];
        // Boolean slots hold exactly 0/1 (the leaf's contract), whatever a caller passed.
        for (i, x) in args.iter_mut().enumerate() {
            if (def.args >> (2 * i)) & 3 == 2 {
                *x = if *x != 0.0 { 1.0 } else { 0.0 };
            }
        }
        let result = self.adapter.check_open().and_then(|()| {
            // SAFETY: the instance pointer comes from this adapter's own instance, which lives
            // until the adapter is dropped (teardown never frees it); `&self` keeps it alive
            // through this synchronous call, and boolean slots are 0/1.
            unsafe { (def.call)(self.adapter.scalar_instance(def), &args) }.map_err(BindError::error)
        });
        match result {
            Ok(value) => value,
            Err(error) => {
                self.scalar_error.set(Some(js_error(error, None)));
                f64::NAN
            }
        }
    }

    /// The error of the last failed `scalar` call (cleared), or undefined.
    pub fn take_scalar_error(&self) -> JsValue {
        self.scalar_error.take().unwrap_or(JsValue::UNDEFINED)
    }

    /// Converts and settles queued outcomes: `settle(id, status, value, message)`.
    pub fn drain(&self, settle: Function) {
        let mut env = self.env();
        loop {
            let n = self.adapter.drain(&mut env, 64, |env, id, status, value, message| {
                let args = Array::of4(&JsValue::from_f64(id as f64), &JsValue::from(status), &env.get(value).clone(), &JsValue::from_str(message));
                // The outcome is already removed from Rust; a throwing handler only loses itself.
                let _ = settle.apply(&JsValue::UNDEFINED, &args);
            });
            if n == 0 {
                return;
            }
        }
    }

    /// Accepts only ids that are exact integers in 1..=Number.MAX_SAFE_INTEGER.
    pub fn cancel(&self, id: f64) -> bool {
        crate::valid_operation_id(id) && !self.torn_down.get() && self.adapter.cancel(id as u64)
    }

    /// Releases a wrapper's native now (the wrapper becomes "disposed").
    pub fn dispose(&self, handle: JsValue) {
        let unwrap = self.helpers.get("unwrap");
        let Some(pair) = unwrap.call1(&JsValue::UNDEFINED, &handle).ok().filter(|v| v.is_object()) else { return };
        let pair: Array = pair.unchecked_into();
        slab_dispose(pair.get(0).as_f64().unwrap_or(-1.0) as u32, pair.get(1).as_f64().unwrap_or(-1.0) as u32);
    }

    pub fn teardown(&self) {
        if !self.torn_down.replace(true) {
            HOSTS_TORN_DOWN.fetch_add(1, Ordering::SeqCst);
            let _ = self.adapter.teardown();
        }
    }

    pub fn stats(&self) -> Result<JsValue, JsValue> {
        let mut env = self.env();
        let load = |c: &AtomicU64| c.load(Ordering::SeqCst) as f64;
        let v = self
            .adapter
            .stats_js(&mut env, &[("hostsCreated", load(&HOSTS_CREATED)), ("hostsTornDown", load(&HOSTS_TORN_DOWN)), ("hostsFreed", load(&HOSTS_FREED))])
            .map_err(|e| js_error(e, None))?;
        Ok(env.get(v).clone())
    }
}

impl Drop for RnrsWebAdapter {
    fn drop(&mut self) {
        self.teardown();
        HOSTS_FREED.fetch_add(1, Ordering::SeqCst);
    }
}
