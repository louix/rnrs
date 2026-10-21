//! A deterministic, single-threaded model of a JS engine for testing generated glue:
//! values, plain objects with optional throwing or side-effecting getters, arrays (with
//! holes), UTF-16 strings (lone surrogates allowed), and unforgeable native wrappers tied
//! to an adapter generation. `MockEnv` implements `rnrs_core::bind::Env` like a backend.
use std::cell::RefCell;
use std::rc::Rc;

use rnrs_core::bind::{BindError, Env, Kind, NativeBox, UnwrapError, Val};

pub mod harness;

pub mod modules {
    include!(concat!(env!("RNRS_GEN_DIR"), "/bundle-android.rs"));
}

pub type Getter = Rc<dyn Fn(&mut MockEnv) -> Result<V, String>>;

#[derive(Clone)]
pub enum V {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(Vec<u16>),
    Arr(Rc<RefCell<Vec<Option<V>>>>),
    Obj(Rc<Obj>),
    Native(Rc<Slot>),
    /// An ArrayBuffer-like: bytes plus the state a real engine can report.
    Buf(Rc<RefCell<Vec<u8>>>, BufState),
    Func,
    Sym,
}

#[derive(Default)]
pub struct Obj {
    pub props: RefCell<Vec<(String, Prop)>>,
}

#[derive(Clone)]
pub enum Prop {
    Value(V),
    Getter(Getter),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BufState {
    Plain,
    Shared,
    Resizable,
    Detached,
    /// A typed array or DataView over a buffer.
    View,
}

pub struct Slot {
    pub generation: u64,
    pub native: RefCell<Option<NativeBox>>,
}

impl V {
    pub fn str(s: &str) -> V {
        V::Str(s.encode_utf16().collect())
    }
    pub fn obj(fields: Vec<(&str, V)>) -> V {
        V::Obj(Rc::new(Obj { props: RefCell::new(fields.into_iter().map(|(k, v)| (k.to_string(), Prop::Value(v))).collect()) }))
    }
    pub fn arr(items: Vec<V>) -> V {
        V::Arr(Rc::new(RefCell::new(items.into_iter().map(Some).collect())))
    }
    pub fn get(&self, key: &str) -> Option<V> {
        match self {
            V::Obj(o) => o.props.borrow().iter().find(|(k, _)| k == key).and_then(|(_, p)| match p {
                Prop::Value(v) => Some(v.clone()),
                Prop::Getter(_) => None,
            }),
            _ => None,
        }
    }
    pub fn num(&self) -> f64 {
        match self {
            V::Num(n) => *n,
            _ => panic!("not a number"),
        }
    }
    pub fn string(&self) -> String {
        match self {
            V::Str(s) => String::from_utf16_lossy(s),
            _ => panic!("not a string"),
        }
    }
    pub fn items(&self) -> Vec<V> {
        match self {
            V::Arr(a) => a.borrow().iter().map(|v| v.clone().unwrap_or(V::Undefined)).collect(),
            _ => panic!("not an array"),
        }
    }
    pub fn is_undefined(&self) -> bool {
        matches!(self, V::Undefined)
    }
    pub fn is_null(&self) -> bool {
        matches!(self, V::Null)
    }
    pub fn buf(bytes: &[u8]) -> V {
        V::Buf(Rc::new(RefCell::new(bytes.to_vec())), BufState::Plain)
    }
    pub fn bytes(&self) -> Vec<u8> {
        match self {
            V::Buf(data, _) => data.borrow().clone(),
            _ => panic!("not a buffer: {self:?}"),
        }
    }
    pub fn keys(&self) -> Vec<String> {
        match self {
            V::Obj(o) => o.props.borrow().iter().map(|(k, _)| k.clone()).collect(),
            _ => vec![],
        }
    }
}

pub struct MockEnv {
    arena: Vec<V>,
    epoch: u32,
    /// The adapter generation whose wrappers this call accepts.
    pub generation: u64,
    pub open: bool,
    /// Message of a JS exception thrown by a getter during conversion.
    pub thrown: Option<String>,
}

impl MockEnv {
    pub fn new(generation: u64) -> Self {
        static EPOCH: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
        Self { arena: Vec::new(), epoch: EPOCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed), generation, open: true, thrown: None }
    }
    pub fn put(&mut self, v: V) -> Val {
        self.arena.push(v);
        Val::new(self.arena.len() as u32 - 1, self.epoch)
    }
    pub fn take(&self, v: Val) -> V {
        assert_eq!(v.epoch(), self.epoch, "handle from another call");
        self.arena[v.index() as usize].clone()
    }
}

impl Env for MockEnv {
    fn kind(&mut self, v: Val) -> Kind {
        match self.take(v) {
            V::Undefined => Kind::Undefined,
            V::Null => Kind::Null,
            V::Bool(_) => Kind::Boolean,
            V::Num(_) => Kind::Number,
            V::Str(_) => Kind::String,
            V::Arr(_) => Kind::Array,
            V::Obj(_) | V::Native(_) | V::Buf(..) => Kind::Object,
            V::Func => Kind::Function,
            V::Sym => Kind::Other,
        }
    }
    fn to_number(&mut self, v: Val) -> f64 {
        self.take(v).num()
    }
    fn to_bool(&mut self, v: Val) -> bool {
        matches!(self.take(v), V::Bool(true))
    }
    fn to_string(&mut self, v: Val) -> String {
        self.take(v).string()
    }
    fn get_property(&mut self, object: Val, key: &str) -> Result<Val, BindError> {
        let prop = match self.take(object) {
            V::Obj(o) => o.props.borrow().iter().find(|(k, _)| k == key).map(|(_, p)| p.clone()),
            _ => None,
        };
        let value = match prop {
            None => V::Undefined,
            Some(Prop::Value(v)) => v,
            Some(Prop::Getter(g)) => match g(self) {
                Ok(v) => v,
                Err(message) => {
                    self.thrown = Some(message);
                    return Err(BindError::Thrown);
                }
            },
        };
        Ok(self.put(value))
    }
    fn array_length(&mut self, array: Val) -> Result<u32, BindError> {
        Ok(match self.take(array) {
            V::Arr(a) => a.borrow().len() as u32,
            _ => 0,
        })
    }
    fn get_index(&mut self, array: Val, index: u32) -> Result<Val, BindError> {
        let value = match self.take(array) {
            V::Arr(a) => a.borrow().get(index as usize).cloned().flatten().unwrap_or(V::Undefined),
            _ => V::Undefined,
        };
        Ok(self.put(value))
    }
    fn undefined(&mut self) -> Val {
        self.put(V::Undefined)
    }
    fn null(&mut self) -> Val {
        self.put(V::Null)
    }
    fn number(&mut self, value: f64) -> Val {
        self.put(V::Num(value))
    }
    fn boolean(&mut self, value: bool) -> Val {
        self.put(V::Bool(value))
    }
    fn string(&mut self, value: &str) -> Val {
        self.put(V::str(value))
    }
    fn object(&mut self) -> Val {
        self.put(V::Obj(Rc::default()))
    }
    fn set_property(&mut self, object: Val, key: &str, value: Val) -> Result<(), BindError> {
        let value = self.take(value);
        match self.take(object) {
            V::Obj(o) => {
                let mut props = o.props.borrow_mut();
                props.retain(|(k, _)| k != key);
                props.push((key.to_string(), Prop::Value(value)));
                Ok(())
            }
            _ => Err(BindError::type_error("not an object")),
        }
    }
    fn array(&mut self, length: u32) -> Val {
        self.put(V::Arr(Rc::new(RefCell::new(vec![None; length as usize]))))
    }
    fn set_index(&mut self, array: Val, index: u32, value: Val) -> Result<(), BindError> {
        let value = self.take(value);
        match self.take(array) {
            V::Arr(a) => {
                a.borrow_mut()[index as usize] = Some(value);
                Ok(())
            }
            _ => Err(BindError::type_error("not an array")),
        }
    }
    fn to_bytes(&mut self, v: Val, out: &mut Vec<u8>) -> Result<(), rnrs_core::bind::BytesError> {
        use rnrs_core::bind::BytesError;
        match self.take(v) {
            V::Buf(data, BufState::Plain) => {
                *out = data.borrow().clone();
                Ok(())
            }
            V::Buf(_, BufState::Shared) => Err(BytesError::Shared),
            V::Buf(_, BufState::Resizable) => Err(BytesError::Resizable),
            V::Buf(_, BufState::Detached) => Err(BytesError::Detached),
            V::Buf(_, BufState::View) => Err(BytesError::View),
            _ => Err(BytesError::NotArrayBuffer),
        }
    }
    fn new_bytes(&mut self, data: Vec<u8>) -> Result<Val, BindError> {
        Ok(self.put(V::Buf(Rc::new(RefCell::new(data)), BufState::Plain)))
    }
    fn wrap_native(&mut self, object: NativeBox) -> Result<Val, BindError> {
        if !self.open {
            return Err(BindError::error("runtime adapter is closed"));
        }
        let slot = Rc::new(Slot { generation: self.generation, native: RefCell::new(Some(object)) });
        Ok(self.put(V::Native(slot)))
    }
    fn unwrap_native(&mut self, v: Val) -> Result<&NativeBox, UnwrapError> {
        let V::Native(slot) = self.take(v) else { return Err(UnwrapError::NotNative) };
        if slot.generation != self.generation || !self.open {
            return Err(UnwrapError::Closed);
        }
        if slot.native.borrow().is_none() {
            return Err(UnwrapError::Disposed);
        }
        // The slot lives in the arena for this call, so the reference stays valid while
        // `self` is borrowed.
        let index = v.index() as usize;
        let V::Native(slot) = &self.arena[index] else { unreachable!() };
        let guard = slot.native.borrow();
        let ptr: *const NativeBox = guard.as_ref().unwrap();
        drop(guard);
        // SAFETY: the box is only removed by `dispose` below, which needs `&mut self`.
        Ok(unsafe { &*ptr })
    }
}

/// `dispose()`: releases the wrapper's owner now.
pub fn dispose(v: &V) {
    if let V::Native(slot) = v {
        slot.native.borrow_mut().take();
    }
}

impl std::fmt::Debug for V {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            V::Undefined => f.write_str("undefined"),
            V::Null => f.write_str("null"),
            V::Bool(b) => write!(f, "{b}"),
            V::Num(n) => write!(f, "{n:?}"),
            V::Str(s) => write!(f, "{:?}", String::from_utf16_lossy(s)),
            V::Arr(_) => f.debug_list().entries(self.items()).finish(),
            V::Obj(o) => {
                let mut m = f.debug_map();
                for (k, p) in o.props.borrow().iter() {
                    match p {
                        Prop::Value(v) => m.entry(k, v),
                        Prop::Getter(_) => m.entry(k, &"<getter>"),
                    };
                }
                m.finish()
            }
            V::Native(_) => f.write_str("<native>"),
            V::Buf(data, state) => write!(f, "<{state:?} buffer {:?}>", data.borrow()),
            V::Func => f.write_str("<function>"),
            V::Sym => f.write_str("<symbol>"),
        }
    }
}
