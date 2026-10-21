//! Regressions from the generator review: teardown during argument conversion, glue-local
//! name shadowing, imported records.
use std::rc::Rc;

use bind_tests::harness::Harness;
use bind_tests::modules::values;
use bind_tests::{Obj, Prop, V};
use rnrs_core::bind::NativeBox;
use rnrs_core::Native;
use ::values::rnrs_interface::Bag as _;

const NONE: V = V::Undefined;

/// The Bag behind a wrapper, read directly (no adapter call), to observe side effects.
fn bag_count(wrapper: &V) -> f64 {
    let V::Native(slot) = wrapper else { panic!("not a wrapper") };
    let native = slot.native.borrow();
    let boxed: &NativeBox = native.as_ref().expect("live");
    boxed.value.downcast_ref::<Native<::values::PointBag>>().expect("a Bag").count().unwrap()
}

#[test]
fn a_getter_that_tears_the_adapter_down_stops_the_call_before_any_side_effect() {
    let h = Harness::new(&values::MODULE, 8);
    let mut env = h.env();
    let bag = h.call(&mut env, "bag", NONE, vec![]).unwrap();
    assert_eq!(h.call(&mut env, "Bag.add", bag.clone(), vec![V::obj(vec![("x", V::Num(0.0)), ("y", V::Num(0.0))])]).unwrap().num(), 1.0);
    let adapter = Rc::clone(&h.adapter);
    let p = Obj::default();
    p.props.borrow_mut().push(("x".into(), Prop::Getter(Rc::new(move |_| {
        adapter.teardown(); // e.g. a test-hook teardown(), or runtime invalidation, from JS
        Ok(V::Num(1.0))
    }))));
    p.props.borrow_mut().push(("y".into(), Prop::Value(V::Num(2.0))));
    assert_eq!(h.call(&mut env, "Bag.add", bag.clone(), vec![V::Obj(Rc::new(p))]).unwrap_err(), "Error: runtime adapter is closed");
    assert_eq!(bag_count(&bag), 1.0, "the method did not run");
}

#[test]
fn module_methods_also_revalidate_after_conversion() {
    let h = Harness::new(&values::MODULE, 8);
    let mut env = h.env();
    let adapter = Rc::clone(&h.adapter);
    let size = Obj::default();
    size.props.borrow_mut().push(("width".into(), Prop::Getter(Rc::new(move |_| { adapter.teardown(); Ok(V::Num(2.0)) }))));
    size.props.borrow_mut().push(("height".into(), Prop::Value(V::Num(3.0))));
    assert_eq!(h.call(&mut env, "sizeArea", NONE, vec![V::Obj(Rc::new(size))]).unwrap_err(), "Error: runtime adapter is closed");
    // Async: no operation admitted either.
    assert_eq!(h.adapter.stats().admitted, 0);
}

#[test]
fn an_aliased_promise_result_is_async() {
    let h = Harness::new(&values::MODULE, 8);
    let mut env = h.env();
    assert!(h.call(&mut env, "doubleLater", NONE, vec![V::Num(21.0)]).unwrap().num() >= 1.0, "an operation id");
    assert_eq!(h.settle(&mut env, 1)[0].2.num(), 42.0);
}

#[test]
fn names_matching_glue_locals_and_imported_records_round_trip() {
    let h = Harness::new(&values::MODULE, 8);
    let mut env = h.env();
    assert_eq!(h.call(&mut env, "mix", NONE, vec![V::Num(1.5), V::str("r"), V::Bool(true)]).unwrap().string(), "1.5|r|true");
    let filled = V::obj(vec![("kind", V::str("filled")), ("object", V::Num(7.0)), ("value", V::str("v"))]);
    let back = h.call(&mut env, "echoSlot", NONE, vec![filled]).unwrap();
    assert_eq!(back.keys(), ["kind", "object", "value"]);
    assert_eq!((back.get("object").unwrap().num(), back.get("value").unwrap().string()), (7.0, "v".into()));
    let size = V::obj(vec![("width", V::Num(2.0)), ("height", V::Num(4.0))]);
    assert_eq!(h.call(&mut env, "sizeArea", NONE, vec![size]).unwrap().num(), 8.0);
    assert_eq!(h.call(&mut env, "sizeArea", NONE, vec![V::obj(vec![("width", V::Num(2.0))])]).unwrap_err(),
        "TypeError: s.height must be a number, got undefined");
}

/// The worklet boxed handle takes a second owner through `NativeBox::share`: releasing either
/// box leaves the object alive for the other, and the object is dropped with the last one.
#[test]
fn shared_native_boxes_own_the_same_object_independently() {
    struct Probe;
    let first = NativeBox::new(Native::new(Probe), "Probe");
    let object = first.value.downcast_ref::<Native<Probe>>().unwrap().clone();
    let second = first.share();
    assert_eq!(second.spec_name, "Probe");
    let shared = second.value.downcast_ref::<Native<Probe>>().expect("same Rust type");
    assert!(Native::ptr_eq(shared, &object), "one object, two owners");
    assert_eq!(Native::owners(&object), 3);
    drop(first);
    assert_eq!(Native::owners(&object), 2);
    drop(second);
    assert_eq!(Native::owners(&object), 1);
}
