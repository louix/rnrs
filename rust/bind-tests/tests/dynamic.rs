//! `Record<string, T>` and `JsonValue`: plain objects enumerate their own enumerable string keys
//! (`Object.entries`), JSON values are checked recursively, and outputs are new objects with
//! own data properties. Records keep reading declared fields (see ordinary_reads.rs).
use std::cell::RefCell;
use std::rc::Rc;

use bind_tests::harness::{Harness, Settled};
use bind_tests::modules::values;
use bind_tests::{Obj, Prop, V};

const NONE: V = V::Undefined;

fn h() -> Harness {
    Harness::new(&values::MODULE, 8)
}

fn obj(fields: Vec<(&str, V)>) -> V {
    V::obj(fields)
}

fn num(x: f64) -> V {
    V::Num(x)
}

fn s(x: &str) -> V {
    V::str(x)
}

fn getter(f: impl Fn(&mut bind_tests::MockEnv) -> Result<V, String> + 'static) -> Prop {
    Prop::Getter(Rc::new(f))
}

fn obj_of(o: Obj) -> V {
    V::Obj(Rc::new(o))
}

fn props(fields: Vec<(&str, Prop)>) -> Obj {
    let o = Obj::default();
    o.props.borrow_mut().extend(fields.into_iter().map(|(k, p)| (k.to_string(), p)));
    o
}

/// Structural rendering for comparisons (key order as the object holds them).
fn show(v: &V) -> String {
    match v {
        V::Obj(o) => {
            let entries: Vec<String> = o
                .props
                .borrow()
                .iter()
                .map(|(k, p)| match p {
                    Prop::Value(v) => format!("{k}:{}", show(v)),
                    Prop::Getter(_) => format!("{k}:<getter>"),
                })
                .collect();
            format!("{{{}}}", entries.join(","))
        }
        V::Arr(_) => format!("[{}]", v.items().iter().map(show).collect::<Vec<_>>().join(",")),
        other => format!("{other:?}"),
    }
}

#[test]
fn sql_style_rows_map_columns_to_values() {
    let h = h();
    let mut env = h.env();
    let columns = V::arr(vec![s("id"), s("name"), s("score"), s("tags"), s("extra")]);
    let rows = V::arr(vec![
        V::arr(vec![num(1.0), s("ada"), num(9.5), V::arr(vec![s("x")]), obj(vec![("k", V::Bool(true))])]),
        V::arr(vec![num(2.0), s("bob"), V::Null, V::arr(vec![]), obj(vec![])]),
    ]);
    let out = h.call(&mut env, "query", NONE, vec![columns, rows]).unwrap();
    let rows: Vec<String> = out.items().iter().map(show).collect();
    // Rust keeps rows as BTreeMaps: output keys come in sorted order.
    assert_eq!(rows, [
        r#"{extra:{k:true},id:1.0,name:"ada",score:9.5,tags:["x"]}"#,
        r#"{extra:{},id:2.0,name:"bob",score:null,tags:[]}"#,
    ]);
    let err = h.call(&mut env, "query", NONE, vec![V::arr(vec![s("id")]), V::arr(vec![V::arr(vec![])])]).unwrap_err();
    assert_eq!(err, "Error: row 0 has 0 values for 1 columns");
}

#[test]
fn row_keys_are_own_enumerable_string_keys() {
    let h = h();
    let mut env = h.env();
    // An inherited enumerable property and a non-enumerable own one are not entries.
    let row = props(vec![("z", Prop::Value(num(1.0))), ("a", Prop::Value(num(2.0))), ("hidden", Prop::Value(num(3.0)))]);
    row.hidden.borrow_mut().push("hidden".into());
    *row.proto.borrow_mut() = Some(Rc::new(props(vec![("inherited", Prop::Value(num(4.0)))])));
    let out = h.call(&mut env, "rowKeys", NONE, vec![V::arr(vec![obj_of(row), obj(vec![])])]).unwrap();
    assert_eq!(show(&out), r#"[["a","z"],[]]"#);
}

#[test]
fn nested_json_roundtrips_and_keeps_negative_zero() {
    let h = h();
    let mut env = h.env();
    let value = obj(vec![
        ("n", V::Null),
        ("b", V::Bool(false)),
        ("z", num(-0.0)),
        ("big", num(9007199254740993.0)),
        ("s", s("héllo")),
        ("deep", V::arr(vec![obj(vec![("a", V::arr(vec![V::arr(vec![num(1.0)])]))]), V::Null])),
        ("odd key", obj(vec![("__proto__", num(1.0)), ("constructor", s("c"))])),
    ]);
    let out = h.call(&mut env, "echoJson", NONE, vec![value]).unwrap();
    assert_eq!(
        show(&out),
        r#"{b:false,big:9007199254740992.0,deep:[{a:[[1.0]]},null],n:null,odd key:{__proto__:1.0,constructor:"c"},s:"héllo",z:-0.0}"#
    );
    assert!(out.get("z").unwrap().num().is_sign_negative());
    for scalar in [V::Null, V::Bool(true), num(3.5), s("x")] {
        assert_eq!(show(&h.call(&mut env, "echoJson", NONE, vec![scalar.clone()]).unwrap()), show(&scalar));
    }
}

#[test]
fn invalid_json_values_are_rejected_at_their_path() {
    let h = h();
    let mut env = h.env();
    let bag = h.call(&mut env, "bag", NONE, vec![]).unwrap();
    let class_instance = Obj::default();
    class_instance.non_plain.set(true);
    let cases: Vec<(V, &str)> = vec![
        (obj(vec![("a", V::arr(vec![num(1.0), num(f64::NAN)]))]), "TypeError: v.a[1] must be a finite number (JsonValue), got NaN"),
        (V::arr(vec![num(f64::INFINITY)]), "TypeError: v[0] must be a finite number (JsonValue), got Infinity"),
        (num(f64::NEG_INFINITY), "TypeError: v must be a finite number (JsonValue), got -Infinity"),
        (V::Undefined, "TypeError: v must be a JsonValue, got undefined"),
        (V::arr(vec![V::Undefined]), "TypeError: v[0] must be a JsonValue, got undefined"),
        (obj(vec![("a b", V::Undefined)]), r#"TypeError: v["a b"] must be a JsonValue, got undefined"#),
        (obj(vec![("f", V::Func)]), "TypeError: v.f must be a JsonValue, got a function"),
        (V::arr(vec![V::Sym]), "TypeError: v[0] must be a JsonValue, got an unsupported value"),
        (obj(vec![("o", bag)]), "TypeError: v.o must be a JsonValue (plain object), got a native object"),
        (V::buf(&[1]), "TypeError: v must be a JsonValue (plain object), got an object whose prototype is not Object.prototype or null"),
        (obj_of(class_instance), "TypeError: v must be a JsonValue (plain object), got an object whose prototype is not Object.prototype or null"),
    ];
    for (value, message) in cases {
        assert_eq!(h.call(&mut env, "echoJson", NONE, vec![value]).unwrap_err(), message);
    }
}

#[test]
fn optional_json_tells_absent_from_null() {
    let h = h();
    let mut env = h.env();
    assert_eq!(h.call(&mut env, "optionalJson", NONE, vec![]).unwrap().string(), "absent");
    assert_eq!(h.call(&mut env, "optionalJson", NONE, vec![V::Undefined]).unwrap().string(), "absent");
    assert_eq!(h.call(&mut env, "optionalJson", NONE, vec![V::Null]).unwrap().string(), "null");
    assert_eq!(h.call(&mut env, "optionalJson", NONE, vec![obj(vec![])]).unwrap().string(), "object");
}

#[test]
fn records_of_numbers_check_values_and_shape() {
    let h = h();
    let mut env = h.env();
    let out = h.call(&mut env, "echoCounts", NONE, vec![obj(vec![("b", num(2.0)), ("a", num(1.0)), ("10", num(10.0))])]).unwrap();
    assert_eq!(show(&out), "{10:10.0,a:1.0,b:2.0}");
    let bag = h.call(&mut env, "bag", NONE, vec![]).unwrap();
    let cases: Vec<(V, &str)> = vec![
        (V::arr(vec![]), "TypeError: c must be a plain object, got an array"),
        (V::Null, "TypeError: c must be a plain object, got null"),
        (V::Undefined, "TypeError: c must be a plain object, got undefined"),
        (V::Func, "TypeError: c must be a plain object, got a function"),
        (bag, "TypeError: c must be a plain object, got a native object"),
        (obj(vec![("ok", num(1.0)), ("two words", s("2"))]), r#"TypeError: c["two words"] must be a number, got a string"#),
        (obj(vec![("x", V::Undefined)]), "TypeError: c.x must be a number, got undefined"),
    ];
    for (value, message) in cases {
        assert_eq!(h.call(&mut env, "echoCounts", NONE, vec![value]).unwrap_err(), message);
    }
    assert!(h.call(&mut env, "maybeCounts", NONE, vec![V::Null]).unwrap().is_null());
    assert_eq!(show(&h.call(&mut env, "maybeCounts", NONE, vec![obj(vec![("k", num(1.0))])]).unwrap()), "{k:1.0}");
}

#[test]
fn proto_and_constructor_keys_are_ordinary_own_output_keys() {
    let h = h();
    let mut env = h.env();
    let input = obj(vec![("__proto__", num(1.0)), ("constructor", num(2.0)), ("hasOwnProperty", num(3.0))]);
    let out = h.call(&mut env, "echoCounts", NONE, vec![input]).unwrap();
    assert_eq!(show(&out), "{__proto__:1.0,constructor:2.0,hasOwnProperty:3.0}");
}

#[test]
fn getter_exceptions_propagate_and_entries_are_read_before_conversion() {
    let h = h();
    let mut env = h.env();
    let thrown = props(vec![("a", Prop::Value(num(1.0))), ("b", getter(|_| Err("boom".into())))]);
    assert_eq!(h.call(&mut env, "echoCounts", NONE, vec![obj_of(thrown)]).unwrap_err(), "thrown: boom");
    // Object.entries reads every value first: `b`'s getter runs although `a` is invalid.
    let ran = Rc::new(RefCell::new(false));
    let r = ran.clone();
    let order = props(vec![("a", Prop::Value(s("bad"))), ("b", getter(move |_| {
        *r.borrow_mut() = true;
        Ok(num(2.0))
    }))]);
    assert_eq!(h.call(&mut env, "echoCounts", NONE, vec![obj_of(order)]).unwrap_err(), "TypeError: c.a must be a number, got a string");
    assert!(*ran.borrow());
    // A throwing proxy trap (ownKeys / getPrototypeOf) propagates too.
    let trap = Obj::default();
    *trap.entries.borrow_mut() = Some(Err("trap".into()));
    assert_eq!(h.call(&mut env, "echoJson", NONE, vec![obj_of(trap)]).unwrap_err(), "thrown: trap");
}

#[test]
fn a_getter_deleting_a_later_key_removes_that_entry() {
    let h = h();
    let mut env = h.env();
    let o = Rc::new(props(vec![("b", Prop::Value(num(2.0)))]));
    let weak = Rc::downgrade(&o);
    o.props.borrow_mut().insert(0, ("a".into(), getter(move |_| {
        weak.upgrade().unwrap().props.borrow_mut().retain(|(k, _)| k != "b");
        Ok(num(1.0))
    })));
    assert_eq!(show(&h.call(&mut env, "echoCounts", NONE, vec![V::Obj(o)]).unwrap()), "{a:1.0}");
}

#[test]
fn keys_that_collide_after_utf8_conversion_are_rejected() {
    let h = h();
    let mut env = h.env();
    let o = Obj::default();
    *o.entries.borrow_mut() = Some(Ok(vec![(V::Str(vec![0xD800]), num(1.0)), (V::Str(vec![0xDC00]), num(2.0))]));
    assert_eq!(
        h.call(&mut env, "echoCounts", NONE, vec![obj_of(o)]).unwrap_err(),
        "TypeError: c[\"\u{FFFD}\"]: two keys become the same Rust string (lone UTF-16 surrogates become U+FFFD)"
    );
}

fn nested_arrays(depth: usize) -> V {
    (0..depth).fold(V::Null, |inner, _| V::arr(vec![inner]))
}

#[test]
fn json_depth_is_limited_both_ways_and_cycles_stop_there() {
    let h = h();
    let mut env = h.env();
    assert!(h.call(&mut env, "echoJson", NONE, vec![nested_arrays(128)]).is_ok());
    let err = h.call(&mut env, "echoJson", NONE, vec![nested_arrays(129)]).unwrap_err();
    assert!(err.starts_with("RangeError: v[0][0]") && err.ends_with("JsonValue nesting is deeper than 128 levels (a cyclic value?)"), "{err}");
    // A cycle: o.self === o.
    let o = Rc::new(Obj::default());
    o.props.borrow_mut().push(("self".into(), Prop::Value(V::Obj(o.clone()))));
    let err = h.call(&mut env, "echoJson", NONE, vec![V::Obj(o.clone())]).unwrap_err();
    assert!(err.starts_with("RangeError: v.self.self") && err.contains("deeper than 128 levels"), "{err}");
    o.props.borrow_mut().clear(); // break the Rc cycle
    // Output: Rust can build deeper values; converting them fails with a RangeError.
    assert_eq!(show(&h.call(&mut env, "nestedJson", NONE, vec![num(2.0)]).unwrap()), "[[null]]");
    assert!(h.call(&mut env, "nestedJson", NONE, vec![num(128.0)]).is_ok());
    let err = h.call(&mut env, "nestedJson", NONE, vec![num(129.0)]).unwrap_err();
    assert!(err.starts_with("RangeError: JsonValue result[0][0]") && err.ends_with("is nested deeper than 128 levels"), "{err}");
}

#[test]
fn records_with_dictionaries_and_dictionaries_of_unions() {
    let h = h();
    let mut env = h.env();
    let inventory = obj(vec![
        ("counts", obj(vec![("apples", num(3.0))])),
        ("places", obj(vec![("home", obj(vec![("door", obj(vec![("x", num(1.0)), ("y", num(2.0))]))]))])),
        ("meta", V::arr(vec![s("m")])),
    ]);
    let out = h.call(&mut env, "echoInventory", NONE, vec![inventory]).unwrap();
    assert_eq!(show(&out), r#"{counts:{apples:3.0},places:{home:{door:{x:1.0,y:2.0}}},meta:["m"]}"#);
    // Optional dictionary absent: omitted on output; a nested error names the full path.
    let out = h.call(&mut env, "echoInventory", NONE, vec![obj(vec![("counts", obj(vec![])), ("meta", V::Null)])]).unwrap();
    assert_eq!(show(&out), "{counts:{},meta:null}");
    let bad = obj(vec![("counts", obj(vec![])), ("places", obj(vec![("home", obj(vec![("door", obj(vec![("x", num(1.0))]))]))])), ("meta", V::Null)]);
    assert_eq!(h.call(&mut env, "echoInventory", NONE, vec![bad]).unwrap_err(), "TypeError: i.places.home.door.y must be a number, got undefined");
    let shapes = obj(vec![("c", obj(vec![("kind", s("circle")), ("radius", num(1.0))])), ("e", obj(vec![("kind", s("empty"))]))]);
    assert_eq!(show(&h.call(&mut env, "echoShapesByName", NONE, vec![shapes]).unwrap()), r#"{c:{kind:"circle",radius:1.0},e:{kind:"empty"}}"#);
    let bad = obj(vec![("c", obj(vec![("kind", s("blob"))]))]);
    assert!(h.call(&mut env, "echoShapesByName", NONE, vec![bad]).unwrap_err().starts_with("TypeError: s.c.kind: unknown Shape tag \"blob\""));
}

#[test]
fn async_operations_own_their_converted_dictionaries() {
    let h = h();
    let mut env = h.env();
    let inner = Rc::new(props(vec![("k", Prop::Value(num(1.0)))]));
    let value = obj(vec![("inner", V::Obj(inner.clone()))]);
    let id = h.call(&mut env, "echoJsonLater", NONE, vec![value, num(5.0)]).unwrap();
    assert!(matches!(id, V::Num(_)));
    // Mutating the JS object after the call does not reach the operation.
    inner.props.borrow_mut().clear();
    let settled = h.settle(&mut env, 1);
    assert_eq!(settled[0].1, Settled::Ok(String::new()));
    assert_eq!(show(&settled[0].2), "{inner:{k:1.0}}");

    let id = h.call(&mut env, "byteTotalLater", NONE, vec![obj(vec![("a", V::buf(&[1, 2])), ("b", V::buf(&[3]))]), num(1.0)]).unwrap();
    assert!(matches!(id, V::Num(_)));
    let settled = h.settle(&mut env, 1);
    assert_eq!((settled[0].1.clone(), settled[0].2.num()), (Settled::Ok(String::new()), 3.0));

    // An invalid argument rejects before admission: nothing starts.
    let admitted = h.adapter.stats().admitted;
    let err = h.call(&mut env, "byteTotalLater", NONE, vec![obj(vec![("a", V::buf(&[1])), ("b", num(1.0))]), num(1.0)]).unwrap_err();
    assert_eq!(err, "TypeError: b.b must be an ArrayBuffer, got a number");
    assert_eq!(h.adapter.stats().admitted, admitted);

    // A result that cannot convert fails the operation at settlement.
    h.call(&mut env, "jsonNumberLater", NONE, vec![num(f64::NAN)]).unwrap();
    let settled = h.settle(&mut env, 1);
    assert_eq!(settled[0].1, Settled::Failed("result conversion failed: JsonValue result must be a finite number, got NaN".into()));
}
