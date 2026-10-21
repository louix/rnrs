//! M1: generated glue for Counter and Meter (numbers, booleans, void, native objects, async).
use bind_tests::harness::{Harness, Settled};
use bind_tests::modules::{counter, meter};
use bind_tests::{dispose, V};
use rnrs_core::Budget;

const NONE: V = V::Undefined;

fn counter() -> Harness {
    Harness::new(&counter::MODULE, 8)
}

#[test]
fn module_def_matches_ir_order_and_hash() {
    let def = &counter::MODULE;
    assert_eq!(def.name, "CounterModule");
    let names: Vec<_> = def.methods.iter().map(|m| m.name).collect();
    assert_eq!(names, ["create", "Counter.increment", "Counter.add", "Counter.value", "Counter.addLater"]);
    assert_eq!(def.hash.len(), 16);
    assert_eq!(meter::MODULE.native_types[0].spec_name, "Gauge");
}

#[test]
fn f64_semantics_round_trip() {
    let h = counter();
    let mut env = h.env();
    for (initial, delta, expected) in [(1.5, 1.0, 2.5), (f64::INFINITY, 1.0, f64::INFINITY), (-0.0, -0.0, -0.0)] {
        let c = h.call(&mut env, "create", NONE, vec![V::Num(initial)]).unwrap();
        let r = h.call(&mut env, "Counter.add", c, vec![V::Num(delta)]).unwrap().num();
        assert!(r == expected && r.is_sign_negative() == expected.is_sign_negative(), "{r} vs {expected}");
    }
    let c = h.call(&mut env, "create", NONE, vec![V::Num(f64::NAN)]).unwrap();
    assert!(h.call(&mut env, "Counter.increment", c, vec![]).unwrap().num().is_nan());
}

#[test]
fn invalid_arguments_are_type_errors_with_paths() {
    let h = counter();
    let mut env = h.env();
    let c = h.call(&mut env, "create", NONE, vec![V::Num(0.0)]).unwrap();
    assert_eq!(h.call(&mut env, "Counter.add", c.clone(), vec![V::str("1")]).unwrap_err(), "TypeError: delta must be a number, got a string");
    assert_eq!(h.call(&mut env, "Counter.add", c.clone(), vec![]).unwrap_err(), "TypeError: delta must be a number, got undefined");
    assert_eq!(h.call(&mut env, "Counter.add", c, vec![V::Null]).unwrap_err(), "TypeError: delta must be a number, got null");
    assert_eq!(h.call(&mut env, "create", NONE, vec![V::Bool(true)]).unwrap_err(), "TypeError: initial must be a number, got a boolean");
}

#[test]
fn receivers_are_unforgeable_generation_checked_and_disposable() {
    let h = counter();
    let mut env = h.env();
    assert_eq!(h.call(&mut env, "Counter.add", V::obj(vec![]), vec![V::Num(1.0)]).unwrap_err(), "TypeError: this must be a Counter");
    // A Gauge is not a Counter even though both are native wrappers.
    let m = Harness::new(&meter::MODULE, 4);
    let mut menv = m.env();
    let g = m.call(&mut menv, "gauge", NONE, vec![V::Num(1.0)]).unwrap();
    assert_eq!(h.call(&mut menv, "Counter.add", g, vec![V::Num(1.0)]).unwrap_err(), "TypeError: this must be a Counter");
    // Another generation's wrapper.
    let other = counter();
    let mut oenv = other.env();
    let foreign = other.call(&mut oenv, "create", NONE, vec![V::Num(0.0)]).unwrap();
    assert_eq!(h.call(&mut env, "Counter.add", foreign, vec![V::Num(1.0)]).unwrap_err(), "Error: Counter belongs to a closed runtime adapter");
    let c = h.call(&mut env, "create", NONE, vec![V::Num(0.0)]).unwrap();
    dispose(&c);
    assert_eq!(h.call(&mut env, "Counter.value", c, vec![]).unwrap_err(), "Error: Counter is disposed");
}

#[test]
fn async_validation_rejects_before_admission_and_results_settle() {
    let h = counter();
    let mut env = h.env();
    let c = h.call(&mut env, "create", NONE, vec![V::Num(1.0)]).unwrap();
    let before = h.adapter.stats().admitted;
    let err = h.call(&mut env, "Counter.addLater", c.clone(), vec![V::Num(1.0), V::Num(-5.0), V::Bool(false)]).unwrap_err();
    assert!(err.starts_with("RangeError: delayMs"), "{err}");
    assert_eq!(h.adapter.stats().admitted, before, "rejected before admission");
    let id = h.call(&mut env, "Counter.addLater", c.clone(), vec![V::Num(2.0), V::Num(5.0), V::Bool(false)]).unwrap().num();
    assert_eq!(id, 1.0);
    let settled = h.settle(&mut env, 1);
    assert_eq!(settled[0].1, Settled::Ok(String::new()));
    assert_eq!(settled[0].2.num(), 3.0);
    // The receiver is retained by the operation even after the wrapper is disposed.
    let id2 = h.call(&mut env, "Counter.addLater", c.clone(), vec![V::Num(1.0), V::Num(20.0), V::Bool(false)]).unwrap().num();
    dispose(&c);
    let settled = h.settle(&mut env, 1);
    assert_eq!((settled[0].0 as f64, settled[0].2.num()), (id2, 4.0));
}

#[test]
fn admission_failures_carry_rust_messages() {
    let h = Harness::with_budget(&counter::MODULE, 8, Budget::new(1));
    let mut env = h.env();
    let c = h.call(&mut env, "create", NONE, vec![V::Num(0.0)]).unwrap();
    h.call(&mut env, "Counter.addLater", c.clone(), vec![V::Num(1.0), V::Num(200.0), V::Bool(true)]).unwrap();
    let failure = h.call(&mut env, "Counter.addLater", c.clone(), vec![V::Num(1.0), V::Num(1.0), V::Bool(false)]).unwrap();
    assert_eq!(failure.get("code").unwrap().num(), -3.0);
    assert_eq!(failure.get("message").unwrap().string(),
        "executor budget exhausted: 1/1 operations running, 0 of them from closed runtimes; retry after they exit");
    h.adapter.teardown();
    assert_eq!(h.call(&mut env, "Counter.value", c, vec![]).unwrap_err(), "Error: runtime adapter is closed");
}

#[test]
fn meter_module_state_natives_and_async_shapes() {
    let h = Harness::new(&meter::MODULE, 4);
    let mut env = h.env();
    assert_eq!(h.call(&mut env, "hypot", NONE, vec![V::Num(3.0), V::Num(4.0)]).unwrap().num(), 5.0);
    assert!(matches!(h.call(&mut env, "isNegativeZero", NONE, vec![V::Num(-0.0)]).unwrap(), V::Bool(true)));
    assert!(matches!(h.call(&mut env, "isNegativeZero", NONE, vec![V::Num(0.0)]).unwrap(), V::Bool(false)));
    assert!(h.call(&mut env, "reset", NONE, vec![]).unwrap().is_undefined(), "void -> undefined");
    let a = h.call(&mut env, "gauge", NONE, vec![V::Num(2.0)]).unwrap();
    let b = h.call(&mut env, "gauge", NONE, vec![V::Num(5.0)]).unwrap();
    // The same object twice: two owned clones, no aliasing of borrows.
    let sum = h.call(&mut env, "combine", NONE, vec![a.clone(), a.clone()]).unwrap();
    assert_eq!(h.call(&mut env, "Gauge.get", sum, vec![]).unwrap().num(), 4.0);
    let max = h.call(&mut env, "Gauge.maxWith", a.clone(), vec![b]).unwrap();
    assert_eq!(h.call(&mut env, "Gauge.get", max, vec![]).unwrap().num(), 5.0);
    assert!(h.call(&mut env, "Gauge.set", a.clone(), vec![V::Num(9.0)]).unwrap().is_undefined());
    assert!(matches!(h.call(&mut env, "Gauge.isAbove", a, vec![V::Num(8.0)]).unwrap(), V::Bool(true)));
    assert_eq!(h.call(&mut env, "calls", NONE, vec![]).unwrap().num(), 3.0, "gauge, gauge, combine after reset");

    h.call(&mut env, "settleAfter", NONE, vec![V::Num(7.0), V::Num(1.0)]).unwrap();
    h.call(&mut env, "gaugeLater", NONE, vec![V::Num(3.0), V::Num(1.0)]).unwrap();
    h.call(&mut env, "checkLater", NONE, vec![V::Num(-1.0)]).unwrap();
    h.call(&mut env, "checkLater", NONE, vec![V::Num(1.0)]).unwrap();
    let mut settled = h.settle(&mut env, 4);
    settled.sort_by_key(|s| s.0);
    assert_eq!(settled[0].2.num(), 7.0);
    let g = settled[1].2.clone();
    assert_eq!(h.call(&mut env, "Gauge.get", g, vec![]).unwrap().num(), 3.0, "native returned from async is a live wrapper");
    assert_eq!(settled[2].1, Settled::Failed("negative reading: -1".into()));
    assert!(settled[3].2.is_undefined() && settled[3].1 == Settled::Ok(String::new()));
    assert!(h.call(&mut env, "settleAfter", NONE, vec![V::Num(1.0), V::Num(-1.0)]).unwrap_err().starts_with("RangeError: ms"));
}

#[test]
fn receiver_errors_for_every_value_kind() {
    // Pinned before the receiver fast path (unwrap first, kind() only for non-wrappers), so
    // the reordering cannot change any outcome or message.
    let h = counter();
    let mut env = h.env();
    let cases = [
        (V::Num(1.0), "TypeError: this must be a Counter, got a number"),
        (V::str("x"), "TypeError: this must be a Counter, got a string"),
        (V::Undefined, "TypeError: this must be a Counter, got undefined"),
        (V::Null, "TypeError: this must be a Counter, got null"),
        (V::Bool(true), "TypeError: this must be a Counter, got a boolean"),
        (V::arr(vec![]), "TypeError: this must be a Counter, got an array"),
        (V::arr(vec![V::Num(1.0)]), "TypeError: this must be a Counter, got an array"),
        (V::Func, "TypeError: this must be a Counter, got a function"),
        (V::obj(vec![]), "TypeError: this must be a Counter"),
    ];
    for (receiver, expected) in cases {
        assert_eq!(h.call(&mut env, "Counter.value", receiver, vec![]).unwrap_err(), expected);
    }
}
