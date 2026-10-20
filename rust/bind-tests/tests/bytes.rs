//! ArrayBuffer conversions: owned copies in, new buffers out, rejected buffer kinds.
use std::cell::RefCell;
use std::rc::Rc;

use bind_tests::harness::Harness;
use bind_tests::modules::values;
use bind_tests::{BufState, Obj, Prop, V};

const NONE: V = V::Undefined;

fn h() -> Harness {
    Harness::new(&values::MODULE, 8)
}

#[test]
fn bytes_round_trip_including_empty_and_all_byte_values() {
    let h = h();
    let mut env = h.env();
    let all: Vec<u8> = (0..=255).collect();
    for input in [vec![], vec![0], all.clone()] {
        let out = h.call(&mut env, "echoBytes", NONE, vec![V::buf(&input)]).unwrap();
        assert_eq!(out.bytes(), input);
    }
    assert_eq!(h.call(&mut env, "byteSum", NONE, vec![V::buf(&all)]).unwrap().num(), 32640.0);
    assert_eq!(h.call(&mut env, "makeBytes", NONE, vec![V::Num(300.0)]).unwrap().bytes()[257], 1);
    assert!(h.call(&mut env, "makeBytes", NONE, vec![V::Num(0.0)]).unwrap().bytes().is_empty());
}

#[test]
fn inputs_are_snapshots_and_outputs_are_independent() {
    let h = h();
    let mut env = h.env();
    let shared = Rc::new(RefCell::new(vec![1u8, 2, 3]));
    h.call(&mut env, "bytesLater", NONE, vec![V::Buf(shared.clone(), BufState::Plain), V::Num(5.0)]).unwrap();
    shared.borrow_mut()[0] = 99; // after the call returned: the operation has its own copy
    assert_eq!(h.settle(&mut env, 1)[0].2.bytes(), vec![1, 2, 3]);
    let out = h.call(&mut env, "echoBytes", NONE, vec![V::Buf(shared.clone(), BufState::Plain)]).unwrap();
    shared.borrow_mut()[1] = 77;
    assert_eq!(out.bytes(), vec![99, 2, 3], "output does not alias the input");
}

#[test]
fn unsupported_buffers_are_rejected_with_paths() {
    let h = h();
    let mut env = h.env();
    let cases = [
        (BufState::View, "TypeError: b must be an ArrayBuffer, got a typed array or DataView; pass view.buffer.slice(start, end)"),
        (BufState::Shared, "TypeError: b must be an ArrayBuffer, got a SharedArrayBuffer (not supported)"),
        (BufState::Resizable, "TypeError: b must be a fixed-length ArrayBuffer, got a resizable one"),
        (BufState::Detached, "TypeError: b is a detached ArrayBuffer"),
    ];
    for (state, message) in cases {
        let v = V::Buf(Rc::new(RefCell::new(vec![1])), state);
        assert_eq!(h.call(&mut env, "byteSum", NONE, vec![v]).unwrap_err(), message);
    }
    assert_eq!(h.call(&mut env, "byteSum", NONE, vec![V::arr(vec![V::Num(1.0)])]).unwrap_err(), "TypeError: b must be an ArrayBuffer, got an array");
    assert_eq!(h.call(&mut env, "byteSum", NONE, vec![V::str("x")]).unwrap_err(), "TypeError: b must be an ArrayBuffer, got a string");
    assert_eq!(h.call(&mut env, "byteSum", NONE, vec![]).unwrap_err(), "TypeError: b must be an ArrayBuffer, got undefined");
}

#[test]
fn bytes_in_records_arrays_and_nullable_values() {
    let h = h();
    let mut env = h.env();
    assert!(h.call(&mut env, "maybeBytes", NONE, vec![V::Null]).unwrap().is_null());
    assert_eq!(h.call(&mut env, "maybeBytes", NONE, vec![V::buf(&[5])]).unwrap().bytes(), vec![5]);
    let lengths = h.call(&mut env, "byteLengths", NONE, vec![V::arr(vec![V::buf(&[]), V::buf(&[1, 2])])]).unwrap().items();
    assert_eq!((lengths[0].num(), lengths[1].num()), (0.0, 2.0));
    assert_eq!(h.call(&mut env, "byteLengths", NONE, vec![V::arr(vec![V::buf(&[]), V::Num(1.0)])]).unwrap_err(),
        "TypeError: xs[1] must be an ArrayBuffer, got a number");
    // Field order: `data` is copied before `after` is read, so a getter on `after` that
    // mutates the buffer does not change what Rust received.
    let data = Rc::new(RefCell::new(vec![1u8, 2]));
    let blob = Obj::default();
    blob.props.borrow_mut().push(("name".into(), Prop::Value(V::str("n"))));
    blob.props.borrow_mut().push(("data".into(), Prop::Value(V::Buf(data.clone(), BufState::Plain))));
    let d = data.clone();
    blob.props.borrow_mut().push(("after".into(), Prop::Getter(Rc::new(move |_| { d.borrow_mut()[0] = 42; Ok(V::Num(1.0)) }))));
    let out = h.call(&mut env, "echoBlob", NONE, vec![V::Obj(Rc::new(blob))]).unwrap();
    assert_eq!(out.get("data").unwrap().bytes(), vec![1, 2]);
    assert_eq!(data.borrow()[0], 42, "the getter did run");
}
