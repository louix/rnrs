//! [`JsonValue`]: the spec's `JsonValue` (`@rnrs/runtime/spec`), a JSON data-model value
//! converted directly between JS and Rust (no JSON text in between).
use std::collections::BTreeMap;

use crate::bind::{duplicate_key, entries_from_js, expected, BindError, Env, FromJs, IntoJs, Kind, Path, Val};

/// A JSON value: `null`, a boolean, a finite number, a string, an array or an object with
/// string keys. Objects are ordered by key (Rust does not keep JS property order).
#[derive(Debug, Clone, PartialEq, Default)]
pub enum JsonValue {
    #[default]
    Null,
    Bool(bool),
    /// Finite; `-0.0` is kept. NaN and infinities are refused in both directions.
    Number(f64),
    String(String),
    Array(Vec<JsonValue>),
    Object(BTreeMap<String, JsonValue>),
}

/// Nesting limit of arrays and objects, in both directions (it also stops cyclic JS values).
pub const JSON_MAX_DEPTH: usize = 128;

impl From<bool> for JsonValue {
    fn from(value: bool) -> Self {
        JsonValue::Bool(value)
    }
}

impl From<f64> for JsonValue {
    fn from(value: f64) -> Self {
        JsonValue::Number(value)
    }
}

impl From<String> for JsonValue {
    fn from(value: String) -> Self {
        JsonValue::String(value)
    }
}

impl From<&str> for JsonValue {
    fn from(value: &str) -> Self {
        JsonValue::String(value.to_owned())
    }
}

impl From<Vec<JsonValue>> for JsonValue {
    fn from(value: Vec<JsonValue>) -> Self {
        JsonValue::Array(value)
    }
}

impl From<BTreeMap<String, JsonValue>> for JsonValue {
    fn from(value: BTreeMap<String, JsonValue>) -> Self {
        JsonValue::Object(value)
    }
}

impl<T: Into<JsonValue>> From<Option<T>> for JsonValue {
    fn from(value: Option<T>) -> Self {
        value.map_or(JsonValue::Null, Into::into)
    }
}

const WHAT: &str = "a JsonValue";

/// A non-finite number as JS prints it.
fn js_number(x: f64) -> &'static str {
    if x.is_nan() {
        "NaN"
    } else if x > 0.0 {
        "Infinity"
    } else {
        "-Infinity"
    }
}

fn too_deep(path: &Path<'_>) -> BindError {
    BindError::range_error(format!("{path}: JsonValue nesting is deeper than {JSON_MAX_DEPTH} levels (a cyclic value?)"))
}

fn read(env: &mut dyn Env, v: Val, path: &Path<'_>, depth: usize) -> Result<JsonValue, BindError> {
    match env.kind(v) {
        Kind::Null => Ok(JsonValue::Null),
        Kind::Boolean => Ok(JsonValue::Bool(env.to_bool(v))),
        Kind::Number => {
            let x = env.to_number(v);
            if x.is_finite() {
                Ok(JsonValue::Number(x))
            } else {
                Err(BindError::type_error(format!("{path} must be a finite number (JsonValue), got {}", js_number(x))))
            }
        }
        Kind::String => Ok(JsonValue::String(env.to_string(v))),
        Kind::Array => {
            if depth == JSON_MAX_DEPTH {
                return Err(too_deep(path));
            }
            let length = env.array_length(v)?;
            let mut out = Vec::with_capacity(length.min(4096) as usize);
            for i in 0..length {
                let element = env.get_index(v, i)?;
                out.push(read(env, element, &path.index(i), depth + 1)?);
            }
            Ok(JsonValue::Array(out))
        }
        Kind::Object => {
            if depth == JSON_MAX_DEPTH {
                return Err(too_deep(path));
            }
            let mut out = BTreeMap::new();
            entries_from_js(env, v, path, "a JsonValue (plain object)", &mut |env, key, value, path| {
                if out.contains_key(&key) {
                    return Err(duplicate_key(path));
                }
                let value = read(env, value, path, depth + 1)?;
                out.insert(key, value);
                Ok(())
            })?;
            Ok(JsonValue::Object(out))
        }
        Kind::Undefined | Kind::Function | Kind::Other => Err(expected(env, v, path, WHAT)),
    }
}

fn write(value: JsonValue, env: &mut dyn Env, path: &Path<'_>, depth: usize) -> Result<Val, BindError> {
    match value {
        JsonValue::Null => Ok(env.null()),
        JsonValue::Bool(b) => Ok(env.boolean(b)),
        JsonValue::Number(x) if x.is_finite() => Ok(env.number(x)),
        JsonValue::Number(x) => Err(BindError::type_error(format!("JsonValue result{path} must be a finite number, got {}", js_number(x)))),
        JsonValue::String(s) => Ok(env.string(&s)),
        JsonValue::Array(items) => {
            if depth == JSON_MAX_DEPTH {
                return Err(BindError::range_error(format!("JsonValue result{path} is nested deeper than {JSON_MAX_DEPTH} levels")));
            }
            let length = u32::try_from(items.len()).map_err(|_| BindError::range_error("array too long"))?;
            let array = env.array(length);
            for (i, item) in items.into_iter().enumerate() {
                let item = write(item, env, &path.index(i as u32), depth + 1)?;
                env.set_index(array, i as u32, item)?;
            }
            Ok(array)
        }
        JsonValue::Object(entries) => {
            if depth == JSON_MAX_DEPTH {
                return Err(BindError::range_error(format!("JsonValue result{path} is nested deeper than {JSON_MAX_DEPTH} levels")));
            }
            let object = env.object();
            for (key, item) in entries {
                let item = write(item, env, &path.key(&key), depth + 1)?;
                // Defined as an own data property: `__proto__` stays an ordinary key.
                env.set_property(object, &key, item)?;
            }
            Ok(object)
        }
    }
}

/// Input: `null`, booleans, finite numbers, strings, arrays and plain objects (prototype
/// `Object.prototype` or `null`; own enumerable string keys, as `Object.entries`). Anything else
/// (`undefined`, NaN, infinities, functions, symbols, bigints, buffers, native objects, other
/// objects) is a TypeError at its path; nesting deeper than [`JSON_MAX_DEPTH`] a RangeError.
impl FromJs for JsonValue {
    fn from_js(env: &mut dyn Env, v: Val, path: &Path<'_>) -> Result<Self, BindError> {
        read(env, v, path, 0)
    }
}

/// Output: new ordinary arrays and objects (own data properties, in key order). Non-finite
/// numbers are a TypeError and nesting deeper than [`JSON_MAX_DEPTH`] a RangeError.
impl IntoJs for JsonValue {
    fn into_js(self, env: &mut dyn Env) -> Result<Val, BindError> {
        // A root segment that prints nothing: errors read `JsonValue result.a[2] ...`.
        write(self, env, &Path::root(""), 0)
    }
}
