//! Framework side of generated bindings: the contract between generated per-module glue
//! (emitted by `tools/rnrs-gen`) and the handwritten platform backends.
//!
//! Generated glue converts arguments and results through [`Env`], an object-safe view of
//! one JS call (or one settlement turn) on the JS thread. Each backend implements it once:
//! over JSI on Android (`rust/rnrs-android`) and over wasm-bindgen in the browser
//! (`rust/rnrs-web`). The same generated conversion code therefore runs on both, with no
//! intermediate serialization format.
//!
//! [`Val`] handles name JS values held by the backend for the current call only. They are
//! plain indices, checked by the backend against the call that issued them; generated code
//! never stores them beyond the call, never holds a JS value across an await, and never
//! keeps a borrowed native object across a conversion that could run JS. Native objects are
//! always taken as owned [`Native`] clones.
use std::fmt;
use std::future::Future;

use crate::host::{AdmitError, Host, Notify, OpError};
use crate::{Budget, CancelToken, HostStats, Native, TeardownReport};

#[cfg(not(target_arch = "wasm32"))]
mod bounds {
    /// `Send` on multithreaded (native) targets; no bound in the browser.
    pub trait MaybeSend: Send {}
    impl<T: Send + ?Sized> MaybeSend for T {}
    /// `Send + Sync` on native targets; no bound in the browser.
    pub trait MaybeSendSync: Send + Sync {}
    impl<T: Send + Sync + ?Sized> MaybeSendSync for T {}
    pub type AnyNative = dyn std::any::Any + Send + Sync;
    pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;
}
#[cfg(target_arch = "wasm32")]
mod bounds {
    pub trait MaybeSend {}
    impl<T: ?Sized> MaybeSend for T {}
    pub trait MaybeSendSync {}
    impl<T: ?Sized> MaybeSendSync for T {}
    pub type AnyNative = dyn std::any::Any;
    pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T>>>;
}
pub use bounds::{AnyNative, BoxFuture, MaybeSend, MaybeSendSync};

/// A JS value held by the backend for the duration of one call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Val {
    index: u32,
    epoch: u32,
}

impl Val {
    /// For backends: `epoch` identifies the call whose arena holds `index`.
    pub fn new(index: u32, epoch: u32) -> Self {
        Self { index, epoch }
    }
    pub fn index(self) -> u32 {
        self.index
    }
    pub fn epoch(self) -> u32 {
        self.epoch
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Undefined,
    Null,
    Boolean,
    Number,
    String,
    Array,
    Function,
    /// Any other object, including native-object wrappers.
    Object,
    /// Symbols, bigints and anything else the contract does not accept.
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    TypeError,
    RangeError,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindError {
    /// Raise a new JS error of `kind`.
    Js { kind: ErrorKind, message: String },
    /// JS code run during conversion (a getter, a proxy trap) threw; the backend holds the
    /// original exception and rethrows it.
    Thrown,
}

impl BindError {
    pub fn type_error(message: impl Into<String>) -> Self {
        BindError::Js { kind: ErrorKind::TypeError, message: message.into() }
    }
    pub fn range_error(message: impl Into<String>) -> Self {
        BindError::Js { kind: ErrorKind::RangeError, message: message.into() }
    }
    pub fn error(message: impl Into<String>) -> Self {
        BindError::Js { kind: ErrorKind::Error, message: message.into() }
    }
    pub fn message(&self) -> &str {
        match self {
            BindError::Js { message, .. } => message,
            BindError::Thrown => "a JS exception was thrown during conversion",
        }
    }
}

/// Where a value sits in the arguments, for error messages (`shape.points[2].x`).
#[derive(Clone, Copy)]
pub struct Path<'a> {
    parent: Option<&'a Path<'a>>,
    segment: Segment<'a>,
}

#[derive(Clone, Copy)]
enum Segment<'a> {
    Name(&'a str),
    Index(u32),
}

impl<'a> Path<'a> {
    pub const fn root(name: &'a str) -> Self {
        Self { parent: None, segment: Segment::Name(name) }
    }
    pub fn field<'b>(&'b self, name: &'b str) -> Path<'b> {
        Path { parent: Some(self), segment: Segment::Name(name) }
    }
    pub fn index<'b>(&'b self, index: u32) -> Path<'b> {
        Path { parent: Some(self), segment: Segment::Index(index) }
    }
}

impl fmt::Display for Path<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(parent) = self.parent {
            parent.fmt(f)?;
            match self.segment {
                Segment::Name(name) => write!(f, ".{name}"),
                Segment::Index(i) => write!(f, "[{i}]"),
            }
        } else {
            match self.segment {
                Segment::Name(name) => f.write_str(name),
                Segment::Index(i) => write!(f, "[{i}]"),
            }
        }
    }
}

/// A native object as the backend stores it in a JS wrapper.
pub struct NativeBox {
    /// Spec interface name, checked on every unwrap alongside the Rust type.
    pub spec_name: &'static str,
    /// A `Native<T>`.
    pub value: Box<AnyNative>,
    /// Clones `value` (another owner of the same object; set by `native_into_js`).
    share: fn(&AnyNative) -> Box<AnyNative>,
}

impl NativeBox {
    pub fn new<T: NativeObject>(native: Native<T>, spec_name: &'static str) -> Self {
        Self { spec_name, value: Box::new(native), share: share_native::<T> }
    }

    /// Another box owning the same object, for a backend that hands one object to a second
    /// holder (the worklet boxed handle) whose lifetime is independent of this box's.
    pub fn share(&self) -> NativeBox {
        NativeBox { spec_name: self.spec_name, value: (self.share)(&*self.value), share: self.share }
    }
}

fn share_native<T: NativeObject>(value: &AnyNative) -> Box<AnyNative> {
    Box::new(value.downcast_ref::<Native<T>>().expect("NativeBox holds a Native<T> of its own share function's T").clone())
}

/// Why `to_bytes` refused a value (status codes shared with the JS `bufferKind` helper).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BytesError {
    NotArrayBuffer,
    Shared,
    Resizable,
    Detached,
    View,
    /// JS threw (the backend holds the exception).
    Thrown,
    /// The copy's storage could not be allocated (reported instead of aborting).
    TooLarge,
}

impl BytesError {
    /// Status codes: 1 not an ArrayBuffer, 2 shared, 3 resizable, 4 detached, 5 view,
    /// 6 JS threw, 7 allocation failed.
    pub fn from_status(status: u32) -> Option<Self> {
        Some(match status {
            0 => return None,
            2 => BytesError::Shared,
            3 => BytesError::Resizable,
            4 => BytesError::Detached,
            5 => BytesError::View,
            6 => BytesError::Thrown,
            7 => BytesError::TooLarge,
            _ => BytesError::NotArrayBuffer,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnwrapError {
    /// Not a native-object wrapper (or forged).
    NotNative,
    /// The wrapper belongs to a torn-down adapter generation or another runtime.
    Closed,
    /// `dispose()` already released this wrapper's handle.
    Disposed,
}

/// One JS call (or settlement turn) on the JS thread. Implemented by platform backends.
///
/// Semantics shared by every backend:
/// - `get_property` / `get_index` are ordinary reads (`object[key]`): prototype-inclusive, so
///   inherited values and getters count and array holes fall through to the prototype chain.
///   Getters and proxy traps run once, and their exceptions propagate (`BindError::Thrown`).
/// - `set_property` / `set_index` **define** own data properties (`Object.defineProperty`
///   with a null-prototype descriptor, through a framework helper captured when the JS runtime
///   module initializes), so inherited setters never intercept output.
/// - `kind` reports `Array` per `Array.isArray` (proxies of arrays included); an exception
///   there (a revoked proxy) reads as `Other`.
/// - `array_length` reads `length` (proxy traps run) and fails unless it is an integer in
///   `0..=u32::MAX`.
///
/// Scope: outputs resist inherited setters and descriptor-shaped prototype properties (prototype
/// pollution); inputs deliberately follow ordinary JS reads. It is not a sandbox: functions the
/// backends look up when called (wasm-bindgen's `Array.of`, `Function.prototype.call`,
/// `Reflect.get` imports on the web, or the writable `__rnrsSettle` global on Android) can
/// still be monkey-patched by code running in the same JS realm.
///
/// Readers that can run JS return `BindError::Thrown` when that JS throws. Value readers
/// (`to_number`, ...) are only called after `kind` agreed.
pub trait Env {
    fn kind(&mut self, v: Val) -> Kind;
    fn to_number(&mut self, v: Val) -> f64;
    fn to_bool(&mut self, v: Val) -> bool;
    /// UTF-8 copy. Lone UTF-16 surrogates become U+FFFD (the documented policy).
    fn to_string(&mut self, v: Val) -> String;
    /// The value if it is a number, in one check where the backend can (same result as
    /// `kind` == Number then `to_number`). Default: exactly that.
    fn number_value(&mut self, v: Val) -> Option<f64> {
        if self.kind(v) == Kind::Number { Some(self.to_number(v)) } else { None }
    }
    /// The value if it is a boolean (same contract as `number_value`).
    fn bool_value(&mut self, v: Val) -> Option<bool> {
        if self.kind(v) == Kind::Boolean { Some(self.to_bool(v)) } else { None }
    }
    /// The value's UTF-8 copy if it is a string (same contract as `number_value`).
    fn string_value(&mut self, v: Val) -> Option<String> {
        if self.kind(v) == Kind::String { Some(self.to_string(v)) } else { None }
    }
    fn get_property(&mut self, object: Val, key: &str) -> Result<Val, BindError>;
    fn array_length(&mut self, array: Val) -> Result<u32, BindError>;
    fn get_index(&mut self, array: Val, index: u32) -> Result<Val, BindError>;
    /// Owned numeric array conversion. Backends may fuse reads, but must preserve
    /// ordinary reads, one length read, first-error ordering and IEEE numbers.
    fn number_array(&mut self, v: Val, path: &Path<'_>) -> Result<Vec<f64>, BindError> {
        if self.kind(v) != Kind::Array {
            return Err(BindError::type_error(format!("{path} must be an array, got {}", kind_name(self.kind(v)))));
        }
        let length = self.array_length(v)?;
        let mut out = Vec::with_capacity(length.min(4096) as usize);
        for i in 0..length {
            let element = self.get_index(v, i)?;
            match self.number_value(element) {
                Some(x) => out.push(x),
                None => return Err(BindError::type_error(format!("{} must be a number, got {}", path.index(i), kind_name(self.kind(element))))),
            }
        }
        Ok(out)
    }

    fn undefined(&mut self) -> Val;
    fn null(&mut self) -> Val;
    fn number(&mut self, value: f64) -> Val;
    fn boolean(&mut self, value: bool) -> Val;
    fn string(&mut self, value: &str) -> Val;
    fn object(&mut self) -> Val;
    fn set_property(&mut self, object: Val, key: &str, value: Val) -> Result<(), BindError>;
    fn array(&mut self, length: u32) -> Val;
    fn set_index(&mut self, array: Val, index: u32, value: Val) -> Result<(), BindError>;

    /// Copies an ArrayBuffer's bytes into `out` (replacing its contents), after checking with
    /// framework helpers that `v` is a plain ArrayBuffer: not a view, not a
    /// SharedArrayBuffer, not resizable, not detached, where the engine can tell. The checks
    /// and the copy happen in one backend call, with no JS run in between.
    fn to_bytes(&mut self, v: Val, out: &mut Vec<u8>) -> Result<(), BytesError>;
    /// A new ArrayBuffer holding `data` (the backend may adopt the allocation or copy it).
    fn new_bytes(&mut self, data: Vec<u8>) -> Result<Val, BindError>;

    /// Creates an unforgeable JS wrapper owning `object` for the current adapter generation.
    fn wrap_native(&mut self, object: NativeBox) -> Result<Val, BindError>;
    /// Looks up the native object in a wrapper created by this adapter generation.
    fn unwrap_native(&mut self, v: Val) -> Result<&NativeBox, UnwrapError>;
}

/// Conversion of an owned Rust value from JS. Implementations must read only through `env`.
pub trait FromJs: Sized {
    fn from_js(env: &mut dyn Env, v: Val, path: &Path<'_>) -> Result<Self, BindError>;
}

/// Conversion of an owned Rust value into a new JS value.
pub trait IntoJs {
    fn into_js(self, env: &mut dyn Env) -> Result<Val, BindError>;
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Undefined => "undefined",
        Kind::Null => "null",
        Kind::Boolean => "a boolean",
        Kind::Number => "a number",
        Kind::String => "a string",
        Kind::Array => "an array",
        Kind::Function => "a function",
        Kind::Object => "an object",
        Kind::Other => "an unsupported value",
    }
}

/// `TypeError: {path} must be {expected}, got {actual}`.
pub fn expected(env: &mut dyn Env, v: Val, path: &Path<'_>, what: &str) -> BindError {
    let actual = kind_name(env.kind(v));
    BindError::type_error(format!("{path} must be {what}, got {actual}"))
}

impl FromJs for f64 {
    fn from_js(env: &mut dyn Env, v: Val, path: &Path<'_>) -> Result<Self, BindError> {
        match env.number_value(v) {
            Some(x) => Ok(x),
            None => Err(expected(env, v, path, "a number")),
        }
    }
}

impl IntoJs for f64 {
    fn into_js(self, env: &mut dyn Env) -> Result<Val, BindError> {
        Ok(env.number(self))
    }
}

impl FromJs for bool {
    fn from_js(env: &mut dyn Env, v: Val, path: &Path<'_>) -> Result<Self, BindError> {
        match env.bool_value(v) {
            Some(x) => Ok(x),
            None => Err(expected(env, v, path, "a boolean")),
        }
    }
}

impl IntoJs for bool {
    fn into_js(self, env: &mut dyn Env) -> Result<Val, BindError> {
        Ok(env.boolean(self))
    }
}

impl IntoJs for () {
    fn into_js(self, env: &mut dyn Env) -> Result<Val, BindError> {
        Ok(env.undefined())
    }
}

impl FromJs for String {
    fn from_js(env: &mut dyn Env, v: Val, path: &Path<'_>) -> Result<Self, BindError> {
        match env.string_value(v) {
            Some(x) => Ok(x),
            None => Err(expected(env, v, path, "a string")),
        }
    }
}

impl IntoJs for String {
    fn into_js(self, env: &mut dyn Env) -> Result<Val, BindError> {
        Ok(env.string(&self))
    }
}

/// Arrays convert element by element into an owned `Vec` with ordinary reads: holes and sparse
/// entries read through the prototype chain (normally `undefined`, rejected by the element
/// conversion unless it accepts `undefined`).
impl<T: FromJs> FromJs for Vec<T> {
    fn from_js(env: &mut dyn Env, v: Val, path: &Path<'_>) -> Result<Self, BindError> {
        if env.kind(v) != Kind::Array {
            return Err(expected(env, v, path, "an array"));
        }
        let length = env.array_length(v)?;
        let mut out = Vec::with_capacity(length.min(4096) as usize);
        for i in 0..length {
            let element = env.get_index(v, i)?;
            out.push(T::from_js(env, element, &path.index(i))?);
        }
        Ok(out)
    }
}

impl<T: IntoJs> IntoJs for Vec<T> {
    fn into_js(self, env: &mut dyn Env) -> Result<Val, BindError> {
        let array = env.array(u32::try_from(self.len()).map_err(|_| BindError::range_error("array too long"))?);
        for (i, element) in self.into_iter().enumerate() {
            let value = element.into_js(env)?;
            env.set_index(array, i as u32, value)?;
        }
        Ok(array)
    }
}

/// `ArrayBuffer` input: an owned copy (snapshot at conversion time).
pub fn bytes_from_js(env: &mut dyn Env, v: Val, path: &Path<'_>) -> Result<Vec<u8>, BindError> {
    let mut out = Vec::new();
    match env.to_bytes(v, &mut out) {
        Ok(()) => Ok(out),
        Err(BytesError::Thrown) => Err(BindError::Thrown),
        Err(BytesError::View) => Err(BindError::type_error(format!(
            "{path} must be an ArrayBuffer, got a typed array or DataView; pass view.buffer.slice(start, end)"))),
        Err(BytesError::Shared) => Err(BindError::type_error(format!("{path} must be an ArrayBuffer, got a SharedArrayBuffer (not supported)"))),
        Err(BytesError::Resizable) => Err(BindError::type_error(format!("{path} must be a fixed-length ArrayBuffer, got a resizable one"))),
        Err(BytesError::Detached) => Err(BindError::type_error(format!("{path} is a detached ArrayBuffer"))),
        Err(BytesError::TooLarge) => Err(BindError::range_error(format!("{path} is too large: its copy could not be allocated"))),
        Err(BytesError::NotArrayBuffer) => Err(expected(env, v, path, "an ArrayBuffer")),
    }
}

/// Zero-initialized storage for a backend's input copy, or `TooLarge` if it cannot be
/// allocated (so a huge buffer is a JS RangeError, not an allocation-failure abort).
pub fn alloc_bytes(len: usize) -> Result<Vec<u8>, BytesError> {
    let mut out = Vec::new();
    out.try_reserve_exact(len).map_err(|_| BytesError::TooLarge)?;
    out.resize(len, 0);
    Ok(out)
}

/// `ArrayBuffer` output: the backend owns or copies `data`; Rust keeps no access to it.
pub fn bytes_into_js(data: Vec<u8>, env: &mut dyn Env) -> Result<Val, BindError> {
    env.new_bytes(data)
}

/// `T | null`: `null` is `None`; `undefined` is rejected (it is not part of the type).
pub fn nullable_from_js<T: FromJs>(env: &mut dyn Env, v: Val, path: &Path<'_>) -> Result<Option<T>, BindError> {
    match env.kind(v) {
        Kind::Null => Ok(None),
        _ => T::from_js(env, v, path).map(Some),
    }
}

pub fn nullable_into_js<T: IntoJs>(value: Option<T>, env: &mut dyn Env) -> Result<Val, BindError> {
    match value {
        None => Ok(env.null()),
        Some(value) => value.into_js(env),
    }
}

/// Optional field or parameter (`x?: T`): missing or `undefined` is `None`.
pub fn optional_field<T: FromJs>(env: &mut dyn Env, object: Val, key: &str, path: &Path<'_>) -> Result<Option<T>, BindError> {
    let v = env.get_property(object, key)?;
    match env.kind(v) {
        Kind::Undefined => Ok(None),
        _ => T::from_js(env, v, &path.field(key)).map(Some),
    }
}

/// Required field: missing or `undefined` is rejected by `T`'s conversion with the field path.
pub fn required_field<T: FromJs>(env: &mut dyn Env, object: Val, key: &str, path: &Path<'_>) -> Result<T, BindError> {
    let v = env.get_property(object, key)?;
    T::from_js(env, v, &path.field(key))
}

/// Records are plain objects: not arrays, functions, null or native wrappers.
pub fn expect_record(env: &mut dyn Env, v: Val, path: &Path<'_>, name: &str) -> Result<(), BindError> {
    match env.kind(v) {
        Kind::Object if env.unwrap_native(v).is_err_and(|e| e == UnwrapError::NotNative) => Ok(()),
        _ => Err(expected(env, v, path, &format!("a {name} object"))),
    }
}

/// Reads a string-literal discriminator; `Ok(None)` if absent or not a string.
pub fn tag_of(env: &mut dyn Env, object: Val, key: &str) -> Result<Option<String>, BindError> {
    let v = env.get_property(object, key)?;
    Ok(env.string_value(v))
}

/// Marker bound for native-object implementation types.
pub trait NativeObject: MaybeSendSync + 'static {}
impl<T: MaybeSendSync + 'static> NativeObject for T {}

/// Takes an owned clone of the native object in `v`, checking spec type and generation.
pub fn native_from_js<T: NativeObject>(env: &mut dyn Env, v: Val, path: &Path<'_>, spec_name: &'static str) -> Result<Native<T>, BindError> {
    // Wrappers are always plain (non-array, non-function) objects, and unwrapping runs no JS
    // on any backend, so trying it first decides exactly what checking kind() first did;
    // kind() (which for objects may call the isArray helper) is only needed to word the
    // error for values that are not wrappers.
    match env.unwrap_native(v) {
        Ok(native) if native.spec_name == spec_name => match native.value.downcast_ref::<Native<T>>() {
            Some(native) => Ok(native.clone()),
            None => Err(BindError::type_error(format!("{path} must be a {spec_name}"))),
        },
        Ok(_) => Err(BindError::type_error(format!("{path} must be a {spec_name}"))),
        Err(UnwrapError::NotNative) => {
            if env.kind(v) != Kind::Object {
                return Err(expected(env, v, path, &format!("a {spec_name}")));
            }
            Err(BindError::type_error(format!("{path} must be a {spec_name}")))
        }
        Err(UnwrapError::Closed) => Err(BindError::error(format!("{spec_name} belongs to a closed runtime adapter"))),
        Err(UnwrapError::Disposed) => Err(BindError::error(format!("{spec_name} is disposed"))),
    }
}

pub fn native_into_js<T: NativeObject>(env: &mut dyn Env, native: Native<T>, spec_name: &'static str) -> Result<Val, BindError> {
    env.wrap_native(NativeBox::new(native, spec_name))
}

/// A completed async result waiting for conversion on the JS thread.
pub type Pending = Box<dyn IntoJsBoxed>;

pub trait IntoJsBoxed: MaybeSend {
    fn into_js_boxed(self: Box<Self>, env: &mut dyn Env) -> Result<Val, BindError>;
}

/// Wraps a conversion closure; generated glue uses it so async results convert on the JS
/// thread with the same code as sync results.
pub struct Deferred<F>(pub F);

impl<F: FnOnce(&mut dyn Env) -> Result<Val, BindError> + MaybeSend> IntoJsBoxed for Deferred<F> {
    fn into_js_boxed(self: Box<Self>, env: &mut dyn Env) -> Result<Val, BindError> {
        (self.0)(env)
    }
}

pub fn pending<F: FnOnce(&mut dyn Env) -> Result<Val, BindError> + MaybeSend + 'static>(convert: F) -> Pending {
    Box::new(Deferred(convert))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MethodKind {
    Sync,
    Async,
}

/// One callable entry, in IR order. `name` is `method` or `Object.method`.
pub struct MethodDef {
    pub name: &'static str,
    pub kind: MethodKind,
}

/// A native-object type of a module: spec name and the Rust type's name (for counts).
pub struct NativeTypeDef {
    pub spec_name: &'static str,
    pub rust_type: fn() -> &'static str,
}

/// Private generated scalar leaf. Two bits per argument: 1 number, 2 boolean;
/// result: 0 void, 1 number, 2 boolean. Booleans use 0/1 in fixed scalar slots.
/// No JS values, callbacks, or dynamic conversion are permitted in this leaf.
pub struct ScalarDef {
    pub method: u32,
    pub args: u32,
    pub result: u32,
    pub instance: fn(&AnyNative) -> *const (),
    /// # Safety
    /// Pointer is from this definition's instance function and its adapter is live.
    /// Arguments have the declared types and boolean slots contain only 0/1.
    pub call: unsafe fn(*const (), &[f64; 4]) -> Result<f64, String>,
}

/// Generated description of one module. `hash` identifies the IR it was generated from;
/// platform entry points refuse to install a module whose JS wrapper has a different hash.
pub struct ModuleDef {
    pub name: &'static str,
    pub hash: &'static str,
    pub methods: &'static [MethodDef],
    pub scalars: &'static [ScalarDef],
    pub native_types: &'static [NativeTypeDef],
    /// Creates the module implementation for one adapter generation (`Native<Impl>`).
    pub instantiate: fn() -> Result<Box<AnyNative>, String>,
    pub call: fn(&mut Call<'_>, u32, Val, &[Val]) -> Result<Val, BindError>,
}

/// Starts admitted async work for a call. Implemented by [`Adapter`].
pub trait Start {
    fn start(&self, work: Box<dyn FnOnce(CancelToken) -> BoxFuture<Result<Pending, String>>>) -> Result<u64, AdmitError>;
    /// Whether the adapter generation is still open (not torn down).
    fn is_open(&self) -> bool;
}

/// What generated `call` functions get: the call's JS values and the module instance.
pub struct Call<'a> {
    pub env: &'a mut dyn Env,
    instance: &'a AnyNative,
    starter: &'a dyn Start,
}

impl<'a> Call<'a> {
    /// Called by generated glue after converting all arguments: conversion can run JS
    /// (getters, proxy traps) that tears this adapter down, and no method may then run.
    pub fn check_open(&self) -> Result<(), BindError> {
        if self.starter.is_open() {
            Ok(())
        } else {
            Err(BindError::error("runtime adapter is closed"))
        }
    }

    /// The module implementation of this adapter generation.
    pub fn instance<M: NativeObject>(&self) -> &Native<M> {
        self.instance.downcast_ref::<Native<M>>().expect("module instance type matches its ModuleDef")
    }

    /// Admits and starts async work; returns the JS value for the wrapper: an operation id
    /// (number) or an admission failure `{code, message}`.
    pub fn start<F>(&mut self, work: impl FnOnce(CancelToken) -> F + 'static) -> Result<Val, BindError>
    where
        F: Future<Output = Result<Pending, String>> + MaybeSend + 'static,
    {
        let started = self.starter.start(Box::new(move |token| -> BoxFuture<Result<Pending, String>> { Box::pin(work(token)) }));
        match started {
            Ok(id) => Ok(self.env.number(id as f64)),
            Err(error) => admit_failure(self.env, error),
        }
    }
}

/// Admission failure codes shared with the JS runtime (`AdmitFailure`).
pub const ADMIT_CLOSED: f64 = -1.0;
pub const ADMIT_OVERLOADED: f64 = -2.0;
pub const ADMIT_SATURATED: f64 = -3.0;

/// `{code, message}` with the Rust error text: -1 closed, -2 module overloaded, -3 executor
/// budget full (the message carries the budget snapshot taken at refusal).
pub fn admit_failure(env: &mut dyn Env, error: AdmitError) -> Result<Val, BindError> {
    let code = match error {
        AdmitError::Closed => ADMIT_CLOSED,
        AdmitError::Overloaded => ADMIT_OVERLOADED,
        AdmitError::Saturated(_) => ADMIT_SATURATED,
    };
    let object = env.object();
    let code = env.number(code);
    env.set_property(object, "code", code)?;
    let message = env.string(&error.to_string());
    env.set_property(object, "message", message)?;
    Ok(object)
}

/// Positional argument: missing arguments read as `undefined`.
pub fn arg<T: FromJs>(env: &mut dyn Env, args: &[Val], index: usize, name: &str) -> Result<T, BindError> {
    let v = match args.get(index) {
        Some(v) => *v,
        None => env.undefined(),
    };
    T::from_js(env, v, &Path::root(name))
}

/// Optional positional argument (`x?: T`).
pub fn optional_arg<T: FromJs>(env: &mut dyn Env, args: &[Val], index: usize, name: &str) -> Result<Option<T>, BindError> {
    match args.get(index) {
        None => Ok(None),
        Some(v) if env.kind(*v) == Kind::Undefined => Ok(None),
        Some(v) => T::from_js(env, *v, &Path::root(name)).map(Some),
    }
}

/// Settlement status codes shared with the JS runtime.
pub const SETTLE_OK: u32 = 0;
pub const SETTLE_CANCELLED: u32 = 1;
pub const SETTLE_FAILED: u32 = 2;
pub const SETTLE_LOST: u32 = 3;

/// Platform-specific spawner for an adapter's async work.
#[cfg(not(target_arch = "wasm32"))]
pub type Spawner = dyn crate::Spawn + Send + Sync;
#[cfg(target_arch = "wasm32")]
pub type Spawner = dyn crate::SpawnLocal;

/// One module's adapter generation: its operation host and its implementation instance.
/// Platform backends own one per `install` and drive it from the JS thread.
pub struct Adapter<N: Notify> {
    def: &'static ModuleDef,
    host: Host<Pending, N>,
    instance: Box<AnyNative>,
    spawner: &'static Spawner,
    /// Resources the module registered for retirement at this generation's teardown.
    scope: crate::lifecycle::TeardownScope,
}

impl<N: Notify + MaybeSend + 'static> Adapter<N> {
    pub fn new(def: &'static ModuleDef, max_in_flight: usize, budget: Budget, spawner: &'static Spawner, notify: N) -> Result<Self, String> {
        // The module instance can capture this generation's teardown scope while it is
        // created (TeardownScope::current); the previous current scope is restored after.
        let scope = crate::lifecycle::TeardownScope::new();
        let instance = {
            let _current = scope.enter();
            (def.instantiate)()
        };
        // A failed instantiate may already have registered resources: retire them.
        let instance = instance.inspect_err(|_| scope.retire_all())?;
        Ok(Self { def, host: Host::with_budget(max_in_flight, budget, notify), instance, spawner, scope })
    }

    pub fn def(&self) -> &'static ModuleDef {
        self.def
    }

    /// Bind once; the returned pointer is borrowed from this adapter's instance.
    /// It remains valid through teardown, until the adapter is dropped.
    pub fn scalar_instance(&self, def: &ScalarDef) -> *const () {
        (def.instance)(&*self.instance)
    }

    pub fn check_open(&self) -> Result<(), BindError> {
        if self.host.is_open() { Ok(()) } else { Err(BindError::error("runtime adapter is closed")) }
    }

    pub fn generation(&self) -> u64 {
        self.host.generation()
    }

    /// Dispatches method `index` (IR order). `this` is the receiver wrapper for object
    /// methods and `undefined` for module methods.
    pub fn call(&self, env: &mut dyn Env, index: u32, this: Val, args: &[Val]) -> Result<Val, BindError> {
        if !self.host.is_open() {
            return Err(BindError::error("runtime adapter is closed"));
        }
        if index as usize >= self.def.methods.len() {
            return Err(BindError::range_error(format!("{}: no method #{index}", self.def.name)));
        }
        let mut call = Call { env, instance: &*self.instance, starter: self };
        (self.def.call)(&mut call, index, this, args)
    }

    /// Converts and settles up to `max` queued outcomes on the JS thread. `settle` receives
    /// `(env, id, status, value, message)`. Outcomes are removed from Rust before `settle`
    /// runs, so a settle handler that tears this adapter down cannot see them again.
    pub fn drain<E: Env>(&self, env: &mut E, max: usize, mut settle: impl FnMut(&mut E, u64, u32, Val, &str)) -> usize {
        let outcomes = self.host.drain(max);
        let count = outcomes.len();
        for outcome in outcomes {
            let (status, value, message) = match outcome.result {
                Ok(pending) => match pending.into_js_boxed(env) {
                    Ok(value) => (SETTLE_OK, value, String::new()),
                    Err(error) => (SETTLE_FAILED, env.undefined(), format!("result conversion failed: {}", error.message())),
                },
                Err(OpError::Cancelled) => (SETTLE_CANCELLED, env.undefined(), String::new()),
                Err(OpError::Failed(message)) => (SETTLE_FAILED, env.undefined(), message),
                Err(OpError::Lost) => (SETTLE_LOST, env.undefined(), String::new()),
            };
            settle(env, outcome.id, status, value, &message);
        }
        count
    }

    pub fn cancel(&self, id: u64) -> bool {
        self.host.cancel(id)
    }

    /// Opts this generation's host into posting lost wakes again (`Host::monitor_delivery`).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn monitor_delivery(&self, timer: &'static dyn crate::Timer)
    where
        N: Send,
    {
        self.host.monitor_delivery(timer);
    }

    /// Stops admission and cancels work (`Host::teardown`), then retires the resources the
    /// module registered with this generation's `TeardownScope`. Idempotent; never blocks
    /// (`Retire` implementations only close and notify).
    pub fn teardown(&self) -> TeardownReport {
        let report = self.host.teardown();
        self.scope.retire_all();
        report
    }

    /// This generation's teardown scope (diagnostics and tests).
    pub fn teardown_scope(&self) -> &crate::lifecycle::TeardownScope {
        &self.scope
    }

    pub fn stats(&self) -> HostStats {
        self.host.stats()
    }
}

/// Backstop for backends that drop an adapter without tearing it down: registered resources
/// are still retired (idempotent; the Android/iOS and web backends tear down in their Drop).
impl<N: Notify> Drop for Adapter<N> {
    fn drop(&mut self) {
        self.scope.retire_all();
    }
}

impl<N: Notify + MaybeSend + 'static> Start for Adapter<N> {
    fn start(&self, work: Box<dyn FnOnce(CancelToken) -> BoxFuture<Result<Pending, String>>>) -> Result<u64, AdmitError> {
        #[cfg(not(target_arch = "wasm32"))]
        return self.host.start(self.spawner, work);
        #[cfg(target_arch = "wasm32")]
        return self.host.start_local(self.spawner, work);
    }

    fn is_open(&self) -> bool {
        self.host.is_open()
    }
}

// Closure-based helpers used by generated glue for composite types (arrays, nullable values
// and fields of generated records/unions, whose conversions are generated free functions).

pub type Reader<'r, T> = &'r mut dyn FnMut(&mut dyn Env, Val, &Path<'_>) -> Result<T, BindError>;
pub type Writer<'w, T> = &'w mut dyn FnMut(T, &mut dyn Env) -> Result<Val, BindError>;

pub fn array_from_js_with<T>(env: &mut dyn Env, v: Val, path: &Path<'_>, read: Reader<'_, T>) -> Result<Vec<T>, BindError> {
    if env.kind(v) != Kind::Array {
        return Err(expected(env, v, path, "an array"));
    }
    let length = env.array_length(v)?;
    let mut out = Vec::with_capacity(length.min(4096) as usize);
    for i in 0..length {
        let element = env.get_index(v, i)?;
        out.push(read(env, element, &path.index(i))?);
    }
    Ok(out)
}

pub fn array_into_js_with<T>(values: Vec<T>, env: &mut dyn Env, write: Writer<'_, T>) -> Result<Val, BindError> {
    let array = env.array(u32::try_from(values.len()).map_err(|_| BindError::range_error("array too long"))?);
    for (i, value) in values.into_iter().enumerate() {
        let value = write(value, env)?;
        env.set_index(array, i as u32, value)?;
    }
    Ok(array)
}

pub fn nullable_from_js_with<T>(env: &mut dyn Env, v: Val, path: &Path<'_>, read: Reader<'_, T>) -> Result<Option<T>, BindError> {
    match env.kind(v) {
        Kind::Null => Ok(None),
        _ => read(env, v, path).map(Some),
    }
}

pub fn nullable_into_js_with<T>(value: Option<T>, env: &mut dyn Env, write: Writer<'_, T>) -> Result<Val, BindError> {
    match value {
        None => Ok(env.null()),
        Some(value) => write(value, env),
    }
}

/// Reads a property; `Ok(None)` when it is missing or `undefined` (optional fields).
pub fn optional_with<T>(env: &mut dyn Env, v: Val, path: &Path<'_>, read: Reader<'_, T>) -> Result<Option<T>, BindError> {
    match env.kind(v) {
        Kind::Undefined => Ok(None),
        _ => read(env, v, path).map(Some),
    }
}

/// Positional argument value; missing arguments read as `undefined`.
pub fn arg_val(env: &mut dyn Env, args: &[Val], index: usize) -> Val {
    match args.get(index) {
        Some(v) => *v,
        None => env.undefined(),
    }
}

/// Checks a constant literal field of a union variant on input.
pub fn expect_literal(env: &mut dyn Env, object: Val, key: &str, value: &str, path: &Path<'_>) -> Result<(), BindError> {
    match tag_of(env, object, key)? {
        Some(actual) if actual == value => Ok(()),
        _ => Err(BindError::type_error(format!("{} must be {value:?}", path.field(key)))),
    }
}

impl<N: Notify + MaybeSend + 'static> Adapter<N> {
    /// Diagnostics object shared by backends: this adapter's host counters, the given
    /// backend-specific `extra` numbers, and live counts of the module's native types as
    /// `native.<Spec>.{created,dropped}`.
    pub fn stats_js(&self, env: &mut dyn Env, extra: &[(&str, f64)]) -> Result<Val, BindError> {
        let h = self.stats();
        let object = env.object();
        let host = [
            ("generation", h.generation as f64),
            ("open", h.open as u8 as f64),
            ("pending", h.pending as f64),
            ("inFlight", h.in_flight as f64),
            ("queued", h.queued as f64),
            ("slots", h.slots as f64),
            ("admitted", h.admitted as f64),
            ("delivered", h.delivered as f64),
            ("discarded", h.discarded as f64),
            ("lost", h.lost as f64),
        ];
        for (key, value) in host.iter().chain(extra.iter()) {
            let v = env.number(*value);
            env.set_property(object, key, v)?;
        }
        let natives = env.object();
        for t in self.def.native_types {
            let counts = crate::live_counts_by_name((t.rust_type)());
            let entry = env.object();
            let created = env.number(counts.created as f64);
            env.set_property(entry, "created", created)?;
            let dropped = env.number(counts.dropped as f64);
            env.set_property(entry, "dropped", dropped)?;
            env.set_property(natives, t.spec_name, entry)?;
        }
        env.set_property(object, "native", natives)?;
        Ok(object)
    }
}

/// JS array lengths are integers in 0..=2^32-1; anything else (a proxy's trap) is rejected.
pub fn valid_length(length: f64) -> Result<u32, BindError> {
    if length.fract() == 0.0 && (0.0..=u32::MAX as f64).contains(&length) {
        Ok(length as u32)
    } else {
        Err(BindError::type_error(format!("array length {length} is not an integer in 0..=4294967295")))
    }
}
