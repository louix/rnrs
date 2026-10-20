//! M2: records, strings, arrays, optional and nullable values through generated glue.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use bind_tests::harness::Harness;
use bind_tests::modules::values;
use bind_tests::{dispose, Obj, Prop, V};

const NONE: V = V::Undefined;

fn h() -> Harness {
    Harness::new(&values::MODULE, 8)
}

fn point(x: f64, y: f64) -> V {
    V::obj(vec![("x", V::Num(x)), ("y", V::Num(y))])
}

fn labeled(note: Option<V>, parent: V) -> V {
    let mut fields = vec![
        ("label", V::str("L")),
        ("tags", V::arr(vec![V::str("a"), V::str("b")])),
        ("parent", parent),
        ("points", V::arr(vec![point(1.0, 2.0), point(3.0, 4.0)])),
    ];
    if let Some(note) = note {
        fields.push(("note", note));
    }
    V::obj(fields)
}

#[test]
fn strings_are_owned_utf8_with_lone_surrogates_replaced() {
    let h = h();
    let mut env = h.env();
    for s in ["", "plain", "é ü 漢字", "emoji 🦀 and \u{0} nul"] {
        assert_eq!(h.call(&mut env, "echoString", NONE, vec![V::str(s)]).unwrap().string(), s);
    }
    // "\uD800x" and a lone low surrogate: replaced by U+FFFD (3 UTF-8 bytes) each.
    let lone = V::Str(vec![0xD800, 'x' as u16, 0xDC00]);
    assert_eq!(h.call(&mut env, "echoString", NONE, vec![lone.clone()]).unwrap().string(), "\u{FFFD}x\u{FFFD}");
    assert_eq!(h.call(&mut env, "utf8Length", NONE, vec![lone]).unwrap().num(), 7.0);
    assert_eq!(h.call(&mut env, "utf8Length", NONE, vec![V::str("🦀")]).unwrap().num(), 4.0);
    assert_eq!(h.call(&mut env, "echoString", NONE, vec![V::Num(1.0)]).unwrap_err(), "TypeError: s must be a string, got a number");
}

#[test]
fn arrays_convert_element_by_element() {
    let h = h();
    let mut env = h.env();
    let xs = V::arr(vec![V::Num(1.0), V::Num(-0.0), V::Num(f64::INFINITY)]);
    let back = h.call(&mut env, "echoNumbers", NONE, vec![xs]).unwrap().items();
    assert!(back[1].num().is_sign_negative() && back[2].num() == f64::INFINITY);
    assert_eq!(h.call(&mut env, "sum", NONE, vec![V::arr(vec![])]).unwrap().num(), 0.0);
    let nested = V::arr(vec![V::arr(vec![V::Num(1.0), V::Num(2.0)]), V::arr(vec![]), V::arr(vec![V::Num(3.0)])]);
    assert_eq!(h.call(&mut env, "nestedSum", NONE, vec![nested]).unwrap().num(), 6.0);
    // A hole reads as undefined and is rejected with its index.
    let holes = V::Arr(Rc::new(RefCell::new(vec![Some(V::Num(1.0)), None, Some(V::Num(3.0))])));
    assert_eq!(h.call(&mut env, "sum", NONE, vec![holes]).unwrap_err(), "TypeError: xs[1] must be a number, got undefined");
    let bad = V::arr(vec![V::arr(vec![V::Num(1.0)]), V::arr(vec![V::str("2")])]);
    assert_eq!(h.call(&mut env, "nestedSum", NONE, vec![bad]).unwrap_err(), "TypeError: xs[1][0] must be a number, got a string");
    assert_eq!(h.call(&mut env, "sum", NONE, vec![V::obj(vec![("length", V::Num(1.0))])]).unwrap_err(), "TypeError: xs must be an array, got an object");
    let strs = h.call(&mut env, "echoStrings", NONE, vec![V::arr(vec![V::str("x"), V::str("")])]).unwrap().items();
    assert_eq!((strs[0].string(), strs[1].string()), ("x".into(), "".into()));
    assert_eq!(h.call(&mut env, "points", NONE, vec![V::Num(3.0)]).unwrap().items()[2].get("y").unwrap().num(), -2.0);
}

#[test]
fn records_round_trip_with_optional_and_nullable_fields() {
    let h = h();
    let mut env = h.env();
    let full = labeled(Some(V::str("n")), point(9.0, 8.0));
    assert_eq!(h.call(&mut env, "describe", NONE, vec![full.clone()]).unwrap().string(), "L|a,b|n|(9,8)|(1,2);(3,4)");
    let out = h.call(&mut env, "echoLabeled", NONE, vec![full]).unwrap();
    assert_eq!(out.keys(), ["label", "tags", "note", "parent", "points"]);
    // Missing optional and undefined optional are both None, and None is omitted on output.
    for note in [None, Some(V::Undefined)] {
        let l = labeled(note, V::Null);
        assert_eq!(h.call(&mut env, "describe", NONE, vec![l.clone()]).unwrap().string(), "L|a,b|<none>|null|(1,2);(3,4)");
        let out = h.call(&mut env, "echoLabeled", NONE, vec![l]).unwrap();
        assert!(!out.keys().contains(&"note".to_string()), "None optional is omitted");
        assert!(out.get("parent").unwrap().is_null(), "None nullable is null");
    }
    // null is not a value of an optional field; undefined is not a value of a nullable one.
    assert_eq!(h.call(&mut env, "describe", NONE, vec![labeled(Some(V::Null), V::Null)]).unwrap_err(), "TypeError: l.note must be a string, got null");
    assert_eq!(h.call(&mut env, "describe", NONE, vec![labeled(None, V::Undefined)]).unwrap_err(), "TypeError: l.parent must be a Point object, got undefined");
    // Extra properties are ignored.
    let extra = V::obj(vec![("x", V::Num(1.0)), ("y", V::Num(2.0)), ("z", V::Num(3.0))]);
    assert_eq!(h.call(&mut env, "echoPoint", NONE, vec![extra]).unwrap().keys(), ["x", "y"]);
}

#[test]
fn invalid_records_name_the_failing_path() {
    let h = h();
    let mut env = h.env();
    let missing = V::obj(vec![("x", V::Num(1.0))]);
    assert_eq!(h.call(&mut env, "echoPoint", NONE, vec![missing]).unwrap_err(), "TypeError: p.y must be a number, got undefined");
    let nested = V::obj(vec![
        ("label", V::str("L")), ("tags", V::arr(vec![])), ("parent", V::Null),
        ("points", V::arr(vec![point(1.0, 2.0), V::obj(vec![("x", V::str("1")), ("y", V::Num(0.0))])])),
    ]);
    assert_eq!(h.call(&mut env, "describe", NONE, vec![nested]).unwrap_err(), "TypeError: l.points[1].x must be a number, got a string");
    assert_eq!(h.call(&mut env, "echoPoint", NONE, vec![V::Num(1.0)]).unwrap_err(), "TypeError: p must be a Point object, got a number");
    assert_eq!(h.call(&mut env, "echoPoint", NONE, vec![V::arr(vec![V::Num(1.0), V::Num(2.0)])]).unwrap_err(), "TypeError: p must be a Point object, got an array");
    assert_eq!(h.call(&mut env, "echoPoint", NONE, vec![V::Null]).unwrap_err(), "TypeError: p must be a Point object, got null");
    // A native wrapper is not a record.
    let bag = h.call(&mut env, "bag", NONE, vec![]).unwrap();
    assert_eq!(h.call(&mut env, "echoPoint", NONE, vec![bag]).unwrap_err(), "TypeError: p must be a Point object, got an object");
}

#[test]
fn nullable_and_optional_arguments() {
    let h = h();
    let mut env = h.env();
    assert_eq!(h.call(&mut env, "maybe", NONE, vec![V::Num(2.0)]).unwrap().num(), 4.0);
    assert!(h.call(&mut env, "maybe", NONE, vec![V::Null]).unwrap().is_null());
    assert_eq!(h.call(&mut env, "maybe", NONE, vec![]).unwrap_err(), "TypeError: x must be a number, got undefined");
    assert!(h.call(&mut env, "maybeString", NONE, vec![V::Null]).unwrap().is_null());
    assert_eq!(h.call(&mut env, "maybeString", NONE, vec![V::str("ab")]).unwrap().string(), "AB");
    assert_eq!(h.call(&mut env, "maybePoint", NONE, vec![point(1.0, 2.0)]).unwrap().get("x").unwrap().num(), 2.0);
    assert!(h.call(&mut env, "maybePoint", NONE, vec![V::Null]).unwrap().is_null());
    assert_eq!(h.call(&mut env, "optionalArg", NONE, vec![V::Num(1.0)]).unwrap().string(), "1+none");
    assert_eq!(h.call(&mut env, "optionalArg", NONE, vec![V::Num(1.0), V::Undefined]).unwrap().string(), "1+none");
    assert_eq!(h.call(&mut env, "optionalArg", NONE, vec![V::Num(1.0), V::Num(2.0)]).unwrap().string(), "1+2");
    assert_eq!(h.call(&mut env, "optionalArg", NONE, vec![V::Num(1.0), V::Null]).unwrap_err(), "TypeError: b must be a number, got null");
}

fn getter(f: impl Fn(&mut bind_tests::MockEnv) -> Result<V, String> + 'static) -> Prop {
    Prop::Getter(Rc::new(f))
}

#[test]
fn getters_run_once_in_field_order_and_their_exceptions_propagate() {
    let h = h();
    let mut env = h.env();
    let order = Rc::new(RefCell::new(Vec::new()));
    let obj = Obj::default();
    for (key, value) in [("y", 2.0), ("x", 1.0)] {
        let order = order.clone();
        obj.props.borrow_mut().push((key.into(), getter(move |_| { order.borrow_mut().push(key); Ok(V::Num(value)) })));
    }
    let out = h.call(&mut env, "echoPoint", NONE, vec![V::Obj(Rc::new(obj))]).unwrap();
    assert_eq!((out.get("x").unwrap().num(), out.get("y").unwrap().num()), (1.0, 2.0));
    assert_eq!(*order.borrow(), ["x", "y"], "declaration order, each read once");

    let throwing = Obj::default();
    throwing.props.borrow_mut().push(("x".into(), getter(|_| Err("boom from getter".into()))));
    assert_eq!(h.call(&mut env, "echoPoint", NONE, vec![V::Obj(Rc::new(throwing))]).unwrap_err(), "thrown: boom from getter");
}

#[test]
fn a_getter_that_disposes_the_receiver_cannot_invalidate_a_borrow() {
    let h = h();
    let mut env = h.env();
    let bag = h.call(&mut env, "bag", NONE, vec![]).unwrap();
    assert_eq!(h.call(&mut env, "Bag.add", bag.clone(), vec![point(0.0, 0.0)]).unwrap().num(), 1.0);
    // Arguments are converted before the receiver is taken, so disposal during conversion
    // is observed as a disposed receiver, not a use-after-free.
    let disposed = Rc::new(Cell::new(false));
    let p = Obj::default();
    let (b, d) = (bag.clone(), disposed.clone());
    p.props.borrow_mut().push(("x".into(), getter(move |_| { dispose(&b); d.set(true); Ok(V::Num(1.0)) })));
    p.props.borrow_mut().push(("y".into(), Prop::Value(V::Num(2.0))));
    assert_eq!(h.call(&mut env, "Bag.add", bag, vec![V::Obj(Rc::new(p))]).unwrap_err(), "Error: Bag is disposed");
    assert!(disposed.get());
}

#[test]
fn async_records_convert_on_settlement() {
    let h = h();
    let mut env = h.env();
    h.call(&mut env, "echoLabeledLater", NONE, vec![labeled(Some(V::str("later")), point(1.0, 1.0)), V::Num(5.0)]).unwrap();
    let settled = h.settle(&mut env, 1);
    let v = &settled[0].2;
    assert_eq!(v.get("note").unwrap().string(), "later");
    assert_eq!(v.get("points").unwrap().items().len(), 2);
}
