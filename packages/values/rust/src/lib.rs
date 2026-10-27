//! Implementation of the Values fixture spec (packages/values/values.spec.ts): plain Rust
//! over the generated records, arrays, strings and options.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rnrs_core::{CancelToken, JsonValue, Native};

pub mod rnrs_interface;
use rnrs_interface as spec;
use spec::{Blob, Event, Inventory, Labeled, LookupError, Overflow, Point, Prepared, Shape, Size, Slot, StatementSlot, Tagged};

#[derive(Default)]
pub struct Values;

#[derive(Default)]
pub struct PointBag(Mutex<Vec<Point>>);

impl spec::Bag for PointBag {
    fn add(&self, p: Point) -> Result<f64, String> {
        let mut points = self.0.lock().unwrap_or_else(|e| e.into_inner());
        points.push(p);
        Ok(points.len() as f64)
    }

    fn count(&self) -> Result<f64, String> {
        Ok(self.0.lock().unwrap_or_else(|e| e.into_inner()).len() as f64)
    }

    fn at(&self, index: f64) -> Result<Point, LookupError> {
        let points = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let found = (index >= 0.0 && index.fract() == 0.0).then(|| points.get(index as usize)).flatten();
        found.cloned().ok_or_else(|| LookupError::NotFound { key: index.to_string() })
    }
}

/// Calls of the declared-error fixture methods (each Rust method runs exactly once per call).
static LOOKUP_CALLS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn lookup(key: &str) -> Result<f64, LookupError> {
    LOOKUP_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    match key {
        "one" => Ok(1.0),
        "missing" => Err(LookupError::NotFound { key: key.to_owned() }),
        "bad" => Err(LookupError::Invalid { reason: "bad key".to_owned(), at: 0.0 }),
        "busy" => Err(LookupError::Busy),
        "nan" => Err(LookupError::Detail { info: JsonValue::Number(f64::NAN) }),
        _ => Ok(0.0),
    }
}

/// Native-object composition: plain Rust types holding `Native` handles of each other.
pub struct NamedShader(String);

impl spec::Shader for NamedShader {
    fn name(&self) -> Result<String, String> {
        Ok(self.0.clone())
    }
}

#[derive(Default)]
pub struct ShaderPaint(Mutex<Option<Native<NamedShader>>>);

impl spec::Paint for ShaderPaint {
    fn set_shader(&self, shader: Option<Native<NamedShader>>) -> Result<(), String> {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = shader;
        Ok(())
    }
    fn shader(&self) -> Result<Option<Native<NamedShader>>, String> {
        Ok(self.0.lock().unwrap_or_else(|e| e.into_inner()).clone())
    }
    async fn shader_name_later(&self, shader: Native<NamedShader>, ms: f64, _cancel: CancelToken) -> Result<String, String> {
        sleep(Duration::from_secs_f64(ms.clamp(0.0, 1000.0) / 1000.0)).await;
        Ok(shader.0.clone())
    }
}

/// Shared by a database and its statements; each `Database` handle is a view of it.
struct DatabaseState {
    name: String,
}

pub struct Database(Arc<DatabaseState>);

pub struct Statement {
    sql: String,
    database: Arc<DatabaseState>,
}

impl Database {
    fn statement(&self, sql: String) -> Native<Statement> {
        Native::new(Statement { sql, database: self.0.clone() })
    }
}

impl spec::Statement for Statement {
    fn sql(&self) -> Result<String, String> {
        Ok(self.sql.clone())
    }
    fn database(&self) -> Result<Native<Database>, String> {
        Ok(Native::new(Database(self.database.clone())))
    }
}

impl spec::Database for Database {
    fn name(&self) -> Result<String, String> {
        Ok(self.0.name.clone())
    }
    fn prepare(&self, sql: String) -> Result<Native<Statement>, String> {
        Ok(self.statement(sql))
    }
    async fn prepare_all(&self, sql: Vec<String>, _cancel: CancelToken) -> Result<Vec<Native<Statement>>, String> {
        sleep(Duration::from_millis(1)).await;
        Ok(sql.into_iter().map(|sql| self.statement(sql)).collect())
    }
    fn prepared(&self, sql: String, shader: Option<Native<NamedShader>>) -> Result<Prepared, String> {
        Ok(Prepared { statement: self.statement(sql.clone()), sql, shader, others: vec![] })
    }
    fn describe_prepared(&self, p: Prepared) -> Result<String, String> {
        let shader = p.shader.as_ref().map_or("<none>".into(), |s| s.0.clone());
        let others: Vec<&str> = p.others.iter().map(|s| s.sql.as_str()).collect();
        Ok(format!("{}|{}|{}", p.statement.sql, shader, others.join(",")))
    }
    fn pick(&self, slot: Option<StatementSlot>) -> Result<Option<Native<Statement>>, String> {
        Ok(match slot {
            Some(StatementSlot::One { statement }) => Some(statement),
            Some(StatementSlot::Many { first, .. }) => first,
            Some(StatementSlot::Empty) | None => None,
        })
    }
}

impl spec::ValuesModule for Values {
    type BagImpl = PointBag;
    type ShaderImpl = NamedShader;
    type PaintImpl = ShaderPaint;
    type StatementImpl = Statement;
    type DatabaseImpl = Database;

    fn echo_number(&self, x: f64) -> Result<f64, String> {
        Ok(x)
    }
    fn echo_bool(&self, b: bool) -> Result<bool, String> {
        Ok(b)
    }
    fn checked_divide(&self, a: f64, b: f64) -> Result<f64, String> {
        if b == 0.0 {
            return Err("division by zero".into());
        }
        Ok(a / b)
    }
    fn echo_string(&self, s: String) -> Result<String, String> {
        Ok(s)
    }
    fn utf8_length(&self, s: String) -> Result<f64, String> {
        Ok(s.len() as f64)
    }
    fn echo_numbers(&self, xs: Vec<f64>) -> Result<Vec<f64>, String> {
        Ok(xs)
    }
    fn sum(&self, xs: Vec<f64>) -> Result<f64, String> {
        Ok(xs.iter().sum())
    }
    fn nested_sum(&self, xs: Vec<Vec<f64>>) -> Result<f64, String> {
        Ok(xs.iter().flatten().sum())
    }
    fn echo_strings(&self, xs: Vec<String>) -> Result<Vec<String>, String> {
        Ok(xs)
    }
    fn echo_point(&self, p: Point) -> Result<Point, String> {
        Ok(p)
    }
    fn echo_labeled(&self, l: Labeled) -> Result<Labeled, String> {
        Ok(l)
    }
    fn describe(&self, l: Labeled) -> Result<String, String> {
        let parent = l.parent.map_or("null".into(), |p| format!("({},{})", p.x, p.y));
        let points: Vec<String> = l.points.iter().map(|p| format!("({},{})", p.x, p.y)).collect();
        Ok(format!("{}|{}|{}|{}|{}", l.label, l.tags.join(","), l.note.as_deref().unwrap_or("<none>"), parent, points.join(";")))
    }
    fn maybe(&self, x: Option<f64>) -> Result<Option<f64>, String> {
        Ok(x.map(|x| x * 2.0))
    }
    fn maybe_string(&self, s: Option<String>) -> Result<Option<String>, String> {
        Ok(s.map(|s| s.to_uppercase()))
    }
    fn maybe_point(&self, p: Option<Point>) -> Result<Option<Point>, String> {
        Ok(p.map(|p| Point { x: p.y, y: p.x }))
    }
    fn optional_arg(&self, a: f64, b: Option<f64>) -> Result<String, String> {
        Ok(match b {
            Some(b) => format!("{a}+{b}"),
            None => format!("{a}+none"),
        })
    }
    fn points(&self, n: f64) -> Result<Vec<Point>, String> {
        if !(0.0..=1000.0).contains(&n) || n.fract() != 0.0 {
            return Err("n must be an integer from 0 to 1000".into());
        }
        Ok((0..n as usize).map(|i| Point { x: i as f64, y: -(i as f64) }).collect())
    }
    async fn echo_labeled_later(&self, l: Labeled, ms: f64, _cancel: CancelToken) -> Result<Labeled, String> {
        sleep(Duration::from_secs_f64(ms.clamp(0.0, 1000.0) / 1000.0)).await;
        Ok(l)
    }
    fn echo_shape(&self, s: Shape) -> Result<Shape, String> {
        Ok(s)
    }
    fn area(&self, s: Shape) -> Result<f64, String> {
        Ok(match s {
            Shape::Circle { radius } => std::f64::consts::PI * radius * radius,
            Shape::Rect { width, height } => width * height,
            Shape::Empty => 0.0,
        })
    }
    fn echo_tagged(&self, t: Tagged) -> Result<Tagged, String> {
        Ok(t)
    }
    fn echo_event(&self, e: Event) -> Result<Event, String> {
        Ok(e)
    }
    fn all_shapes(&self) -> Result<Vec<Shape>, String> {
        Ok(vec![Shape::Circle { radius: 1.0 }, Shape::Rect { width: 2.0, height: 3.0 }, Shape::Empty])
    }
    fn maybe_shape(&self, s: Option<Shape>) -> Result<Option<Shape>, String> {
        Ok(s)
    }
    async fn scale_later(&self, s: Shape, factor: f64, _cancel: CancelToken) -> Result<Shape, String> {
        sleep(Duration::from_millis(1)).await;
        Ok(match s {
            Shape::Circle { radius } => Shape::Circle { radius: radius * factor },
            Shape::Rect { width, height } => Shape::Rect { width: width * factor, height: height * factor },
            Shape::Empty => Shape::Empty,
        })
    }
    fn size_area(&self, s: Size) -> Result<f64, String> {
        Ok(s.width * s.height)
    }
    fn query(&self, columns: Vec<String>, rows: Vec<Vec<JsonValue>>) -> Result<Vec<BTreeMap<String, JsonValue>>, String> {
        rows.into_iter()
            .enumerate()
            .map(|(i, row)| {
                if row.len() != columns.len() {
                    return Err(format!("row {i} has {} values for {} columns", row.len(), columns.len()));
                }
                Ok(columns.iter().cloned().zip(row).collect())
            })
            .collect()
    }
    fn row_keys(&self, rows: Vec<BTreeMap<String, JsonValue>>) -> Result<Vec<Vec<String>>, String> {
        Ok(rows.into_iter().map(|row| row.into_keys().collect()).collect())
    }
    fn echo_json(&self, v: JsonValue) -> Result<JsonValue, String> {
        Ok(v)
    }
    async fn echo_json_later(&self, v: JsonValue, ms: f64, _cancel: CancelToken) -> Result<JsonValue, String> {
        sleep(Duration::from_secs_f64(ms.clamp(0.0, 1000.0) / 1000.0)).await;
        Ok(v)
    }
    async fn json_number_later(&self, x: f64, _cancel: CancelToken) -> Result<JsonValue, String> {
        sleep(Duration::from_millis(1)).await;
        Ok(JsonValue::Number(x))
    }
    fn nested_json(&self, depth: f64) -> Result<JsonValue, String> {
        if !(0.0..=1000.0).contains(&depth) || depth.fract() != 0.0 {
            return Err("depth must be an integer from 0 to 1000".into());
        }
        Ok((0..depth as usize).fold(JsonValue::Null, |inner, _| JsonValue::Array(vec![inner])))
    }
    fn optional_json(&self, v: Option<JsonValue>) -> Result<String, String> {
        Ok(match v {
            None => "absent",
            Some(JsonValue::Null) => "null",
            Some(JsonValue::Bool(_)) => "bool",
            Some(JsonValue::Number(_)) => "number",
            Some(JsonValue::String(_)) => "string",
            Some(JsonValue::Array(_)) => "array",
            Some(JsonValue::Object(_)) => "object",
        }
        .into())
    }
    fn echo_counts(&self, c: BTreeMap<String, f64>) -> Result<BTreeMap<String, f64>, String> {
        Ok(c)
    }
    fn maybe_counts(&self, c: Option<BTreeMap<String, f64>>) -> Result<Option<BTreeMap<String, f64>>, String> {
        Ok(c)
    }
    fn echo_inventory(&self, i: Inventory) -> Result<Inventory, String> {
        Ok(i)
    }
    fn echo_shapes_by_name(&self, s: BTreeMap<String, Shape>) -> Result<BTreeMap<String, Shape>, String> {
        Ok(s)
    }
    async fn byte_total_later(&self, b: BTreeMap<String, Vec<u8>>, ms: f64, _cancel: CancelToken) -> Result<f64, String> {
        sleep(Duration::from_secs_f64(ms.clamp(0.0, 1000.0) / 1000.0)).await;
        Ok(b.values().map(|bytes| bytes.len() as f64).sum())
    }
    fn echo_slot(&self, slot: Slot) -> Result<Slot, String> {
        Ok(slot)
    }
    fn echo_bytes(&self, b: Vec<u8>) -> Result<Vec<u8>, String> {
        Ok(b)
    }
    fn byte_sum(&self, b: Vec<u8>) -> Result<f64, String> {
        Ok(b.iter().map(|&x| x as f64).sum())
    }
    fn make_bytes(&self, n: f64) -> Result<Vec<u8>, String> {
        if !(0.0..=16_777_216.0).contains(&n) || n.fract() != 0.0 {
            return Err("n must be an integer from 0 to 16777216".into());
        }
        Ok((0..n as usize).map(|i| i as u8).collect())
    }
    fn maybe_bytes(&self, b: Option<Vec<u8>>) -> Result<Option<Vec<u8>>, String> {
        Ok(b)
    }
    fn byte_lengths(&self, xs: Vec<Vec<u8>>) -> Result<Vec<f64>, String> {
        Ok(xs.iter().map(|x| x.len() as f64).collect())
    }
    fn echo_blob(&self, b: Blob) -> Result<Blob, String> {
        Ok(b)
    }
    async fn bytes_later(&self, b: Vec<u8>, ms: f64, _cancel: CancelToken) -> Result<Vec<u8>, String> {
        sleep(Duration::from_secs_f64(ms.clamp(0.0, 1000.0) / 1000.0)).await;
        Ok(b)
    }
    async fn double_later(&self, x: f64, _cancel: CancelToken) -> Result<f64, String> {
        sleep(Duration::from_millis(1)).await;
        Ok(x * 2.0)
    }
    fn mix(&self, env: f64, receiver: String, result: bool) -> Result<String, String> {
        Ok(format!("{env}|{receiver}|{result}"))
    }
    fn bag(&self) -> Result<Native<PointBag>, String> {
        Ok(Native::new(PointBag::default()))
    }
    fn open_database(&self, name: String) -> Result<Native<Database>, String> {
        Ok(Native::new(Database(Arc::new(DatabaseState { name }))))
    }
    fn paint(&self) -> Result<Native<ShaderPaint>, String> {
        Ok(Native::new(ShaderPaint::default()))
    }
    fn shader(&self, name: String) -> Result<Native<NamedShader>, String> {
        Ok(Native::new(NamedShader(name)))
    }
    fn statement_slots(&self, db: Native<Database>) -> Result<Vec<StatementSlot>, String> {
        let (a, b) = (db.statement("a".into()), db.statement("b".into()));
        Ok(vec![
            StatementSlot::One { statement: a.clone() },
            StatementSlot::Many { statements: vec![a, b], first: None },
            StatementSlot::Empty,
        ])
    }
    fn echo_prepared(&self, p: Prepared) -> Result<Prepared, String> {
        Ok(p)
    }
    fn maybe_prepared(&self, p: Option<Prepared>) -> Result<Option<Prepared>, String> {
        Ok(p)
    }
    async fn prepared_later(&self, db: Native<Database>, sql: String, ms: f64, _cancel: CancelToken) -> Result<Prepared, String> {
        sleep(Duration::from_secs_f64(ms.clamp(0.0, 1000.0) / 1000.0)).await;
        let statement = db.statement(sql.clone());
        Ok(Prepared { others: vec![statement.clone()], statement, sql, shader: None })
    }
    fn echo_statements_by_name(&self, m: BTreeMap<String, Native<Statement>>) -> Result<BTreeMap<String, Native<Statement>>, String> {
        Ok(m)
    }
    fn echo_prepared_by_name(&self, m: BTreeMap<String, Option<Prepared>>) -> Result<BTreeMap<String, Option<Prepared>>, String> {
        Ok(m)
    }
    async fn statements_by_name_later(&self, db: Native<Database>, sql: Vec<String>, ms: f64, _cancel: CancelToken) -> Result<BTreeMap<String, Native<Statement>>, String> {
        sleep(Duration::from_secs_f64(ms.clamp(0.0, 1000.0) / 1000.0)).await;
        Ok(sql.into_iter().map(|sql| (sql.clone(), db.statement(sql))).collect())
    }
    fn lookup(&self, key: String) -> Result<f64, LookupError> {
        lookup(&key)
    }
    async fn lookup_later(&self, key: String, ms: f64, _cancel: CancelToken) -> Result<f64, LookupError> {
        sleep(Duration::from_millis(ms as u64)).await;
        lookup(&key)
    }
    fn lookup_calls(&self) -> Result<f64, String> {
        Ok(LOOKUP_CALLS.load(std::sync::atomic::Ordering::SeqCst) as f64)
    }
    fn half(&self, x: f64) -> Result<f64, LookupError> {
        LOOKUP_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if x % 2.0 == 0.0 {
            Ok(x / 2.0)
        } else {
            Err(LookupError::Invalid { reason: "odd".to_owned(), at: x })
        }
    }
    fn limited_sum(&self, xs: Vec<f64>, limit: f64) -> Result<f64, Overflow> {
        let sum: f64 = xs.iter().sum();
        if sum > limit {
            Err(Overflow { limit, got: xs })
        } else {
            Ok(sum)
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
async fn sleep(delay: Duration) {
    tokio::time::sleep(delay).await
}

#[cfg(target_arch = "wasm32")]
async fn sleep(delay: Duration) {
    gloo_timers::future::sleep(delay).await
}
