//! Input reads are ordinary (prototype-inclusive) reads: inherited values and getters supply
//! record fields, union tags and array holes; type checks, read order, single reads,
//! short-circuiting and exception propagation are unchanged.
use std::cell::RefCell;
use std::rc::Rc;

use bind_tests::harness::Harness;
use bind_tests::modules::values;
use bind_tests::{Obj, Prop, V};

const NONE: V = V::Undefined;

fn h() -> Harness {
    Harness::new(&values::MODULE, 8)
}

fn getter(f: impl Fn(&mut bind_tests::MockEnv) -> Result<V, String> + 'static) -> Prop {
    Prop::Getter(Rc::new(f))
}

/// An object with own `fields` whose prototype has `inherited`.
fn with_proto(fields: Vec<(&str, Prop)>, inherited: Vec<(&str, Prop)>) -> V {
    let proto = Obj::default();
    proto.props.borrow_mut().extend(inherited.into_iter().map(|(k, p)| (k.to_string(), p)));
    let obj = Obj::default();
    obj.props.borrow_mut().extend(fields.into_iter().map(|(k, p)| (k.to_string(), p)));
    *obj.proto.borrow_mut() = Some(Rc::new(proto));
    V::Obj(Rc::new(obj))
}

#[test]
fn inherited_values_and_getters_supply_record_fields() {
    let h = h();
    let mut env = h.env();
    let p = with_proto(vec![("x", Prop::Value(V::Num(1.0)))], vec![("y", Prop::Value(V::Num(7.0)))]);
    let out = h.call(&mut env, "echoPoint", NONE, vec![p]).unwrap();
    assert_eq!((out.get("x").unwrap().num(), out.get("y").unwrap().num()), (1.0, 7.0));
    let p = with_proto(vec![("x", Prop::Value(V::Num(1.0)))], vec![("y", getter(|_| Ok(V::Num(99.0))))]);
    assert_eq!(h.call(&mut env, "echoPoint", NONE, vec![p]).unwrap().get("y").unwrap().num(), 99.0);
    // Outputs stay own data properties.
    let out = h.call(&mut env, "echoPoint", NONE, vec![with_proto(vec![("x", Prop::Value(V::Num(1.0)))], vec![("y", Prop::Value(V::Num(2.0)))])]).unwrap();
    assert_eq!(out.keys(), ["x", "y"]);
}

#[test]
fn absent_and_mistyped_fields_still_fail_with_their_path() {
    let h = h();
    let mut env = h.env();
    let p = with_proto(vec![("x", Prop::Value(V::Num(1.0)))], vec![]);
    assert_eq!(h.call(&mut env, "echoPoint", NONE, vec![p]).unwrap_err(), "TypeError: p.y must be a number, got undefined");
    let p = with_proto(vec![("x", Prop::Value(V::Num(1.0)))], vec![("y", Prop::Value(V::str("2")))]);
    assert_eq!(h.call(&mut env, "echoPoint", NONE, vec![p]).unwrap_err(), "TypeError: p.y must be a number, got a string");
}

#[test]
fn own_properties_shadow_inherited_ones_and_reads_keep_declaration_order() {
    let h = h();
    let mut env = h.env();
    let order = Rc::new(RefCell::new(Vec::new()));
    let log = |key: &'static str, value: f64| {
        let order = order.clone();
        getter(move |_| {
            order.borrow_mut().push(key);
            Ok(V::Num(value))
        })
    };
    // Own getter for y, inherited getters for x and y: x comes from the prototype, y from the
    // object (the inherited y getter never runs); x is read before y.
    let p = with_proto(vec![("y", log("own y", 2.0))], vec![("x", log("proto x", 1.0)), ("y", log("proto y", -1.0))]);
    let out = h.call(&mut env, "echoPoint", NONE, vec![p]).unwrap();
    assert_eq!((out.get("x").unwrap().num(), out.get("y").unwrap().num()), (1.0, 2.0));
    assert_eq!(*order.borrow(), ["proto x", "own y"]);
}

#[test]
fn prototype_getter_exceptions_propagate_and_stop_conversion() {
    let h = h();
    let mut env = h.env();
    let later = Rc::new(RefCell::new(false));
    let l = later.clone();
    let p = with_proto(
        vec![("y", getter(move |_| { *l.borrow_mut() = true; Ok(V::Num(2.0)) }))],
        vec![("x", getter(|_| Err("boom from prototype".into())))],
    );
    assert_eq!(h.call(&mut env, "echoPoint", NONE, vec![p]).unwrap_err(), "thrown: boom from prototype");
    assert!(!*later.borrow(), "the next field is not read after the exception");
}

#[test]
fn inherited_numbers_fill_array_holes_and_bad_values_short_circuit() {
    let h = h();
    let mut env = h.env();
    env.array_proto.props.borrow_mut().push(("1".into(), Prop::Value(V::Num(5.0))));
    let holes = V::Arr(Rc::new(RefCell::new(vec![Some(V::Num(1.0)), None, Some(V::Num(3.0))])));
    assert_eq!(h.call(&mut env, "sum", NONE, vec![holes]).unwrap().num(), 9.0);
    // An own element shadows the inherited one.
    assert_eq!(h.call(&mut env, "sum", NONE, vec![V::arr(vec![V::Num(1.0), V::Num(2.0)])]).unwrap().num(), 3.0);
    // An inherited non-number is still rejected with its index, before later elements are read.
    env.array_proto.props.borrow_mut()[0].1 = Prop::Value(V::str("five"));
    env.array_proto.props.borrow_mut().push(("2".into(), getter(|_| panic!("index 2 must not be read"))));
    let holes = V::Arr(Rc::new(RefCell::new(vec![Some(V::Num(1.0)), None, None])));
    assert_eq!(h.call(&mut env, "sum", NONE, vec![holes]).unwrap_err(), "TypeError: xs[1] must be a number, got a string");
}

#[test]
fn inherited_and_getter_union_tags_select_the_variant() {
    let h = h();
    let mut env = h.env();
    let circle = with_proto(vec![("radius", Prop::Value(V::Num(1.0)))], vec![("kind", Prop::Value(V::str("circle")))]);
    assert_eq!(h.call(&mut env, "area", NONE, vec![circle]).unwrap().num(), std::f64::consts::PI);
    let rect = with_proto(
        vec![("kind", getter(|_| Ok(V::str("rect")))), ("width", Prop::Value(V::Num(2.0))), ("height", Prop::Value(V::Num(3.0)))],
        vec![("kind", Prop::Value(V::str("circle")))],
    );
    assert_eq!(h.call(&mut env, "area", NONE, vec![rect]).unwrap().num(), 6.0, "own tag getter shadows the inherited tag");
    let unknown = with_proto(vec![], vec![("kind", Prop::Value(V::str("hex")))]);
    assert!(h.call(&mut env, "area", NONE, vec![unknown]).unwrap_err().starts_with("TypeError: s.kind: unknown Shape tag \"hex\""));
    let throwing = with_proto(vec![], vec![("kind", getter(|_| Err("tag getter".into())))]);
    assert_eq!(h.call(&mut env, "area", NONE, vec![throwing]).unwrap_err(), "thrown: tag getter");
}
