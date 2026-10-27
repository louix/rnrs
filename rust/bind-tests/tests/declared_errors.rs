//! Declared errors (spec `Throws<T, E>`): `Err(E)` leaves as `BindError::Domain` (sync) or
//! settlement status 4 (async) carrying the converted `E`; everything else keeps its error.
use std::rc::Rc;
use std::time::{Duration, Instant};

use bind_tests::harness::{Harness, Settled};
use bind_tests::modules::values;
use bind_tests::{Obj, Prop, V};
use rnrs_core::bind::{pending, BindError, Call, MethodDef, MethodKind, ModuleDef, Val};

const NONE: V = V::Undefined;

fn h() -> Harness {
    Harness::new(&values::MODULE, 8)
}

fn s(x: &str) -> V {
    V::str(x)
}

fn start(h: &Harness, env: &mut bind_tests::MockEnv, name: &str, args: Vec<V>) -> u64 {
    h.call(env, name, NONE, args).unwrap().num() as u64
}

/// Waits until the adapter holds `n` undrained outcomes.
fn wait_queued(h: &Harness, n: usize) {
    let begin = Instant::now();
    while h.adapter.stats().queued < n {
        assert!(begin.elapsed() < Duration::from_secs(5), "timed out waiting for a queued outcome");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn sync_declared_errors_carry_the_converted_union() {
    let h = h();
    let mut env = h.env();
    assert_eq!(h.call(&mut env, "lookup", NONE, vec![s("one")]).unwrap().num(), 1.0);
    assert_eq!(h.call(&mut env, "lookup", NONE, vec![s("missing")]).unwrap_err(), r#"domain: {"kind": "notFound", "key": "missing"}"#);
    assert_eq!(h.call(&mut env, "lookup", NONE, vec![s("bad")]).unwrap_err(), r#"domain: {"kind": "invalid", "reason": "bad key", "at": 0.0}"#);
    assert_eq!(h.call(&mut env, "lookup", NONE, vec![s("busy")]).unwrap_err(), r#"domain: {"kind": "busy"}"#);
}

#[test]
fn a_record_can_be_the_declared_error() {
    let h = h();
    let mut env = h.env();
    let xs = V::arr(vec![V::Num(2.0), V::Num(3.0)]);
    assert_eq!(h.call(&mut env, "limitedSum", NONE, vec![xs.clone(), V::Num(10.0)]).unwrap().num(), 5.0);
    assert_eq!(h.call(&mut env, "limitedSum", NONE, vec![xs, V::Num(4.0)]).unwrap_err(), r#"domain: {"limit": 4.0, "got": [2.0, 3.0]}"#);
}

#[test]
fn object_methods_and_scalar_shaped_methods_declare_errors_too() {
    let h = h();
    let mut env = h.env();
    let bag = h.call(&mut env, "bag", NONE, vec![]).unwrap();
    h.call(&mut env, "Bag.add", bag.clone(), vec![V::obj(vec![("x", V::Num(1.0)), ("y", V::Num(2.0))])]).unwrap();
    assert_eq!(h.call(&mut env, "Bag.at", bag.clone(), vec![V::Num(0.0)]).unwrap().get("y").unwrap().num(), 2.0);
    assert_eq!(h.call(&mut env, "Bag.at", bag, vec![V::Num(5.0)]).unwrap_err(), r#"domain: {"kind": "notFound", "key": "5"}"#);
    // `half(x: number)` has no scalar leaf: its declared error needs the generic call.
    assert!(values::MODULE.scalars.iter().all(|d| values::MODULE.methods[d.method as usize].name != "half"));
    assert!(values::MODULE.scalars.iter().any(|d| values::MODULE.methods[d.method as usize].name == "checkedDivide"));
    assert_eq!(h.call(&mut env, "half", NONE, vec![V::Num(4.0)]).unwrap().num(), 2.0);
    assert_eq!(h.call(&mut env, "half", NONE, vec![V::Num(3.0)]).unwrap_err(), r#"domain: {"kind": "invalid", "reason": "odd", "at": 3.0}"#);
}

#[test]
fn an_unconvertible_declared_error_is_a_framework_error_with_one_prefix() {
    let h = h();
    let mut env = h.env();
    let sync = h.call(&mut env, "lookup", NONE, vec![s("nan")]).unwrap_err();
    assert!(sync.starts_with("TypeError: error conversion failed: "), "{sync}");
    assert!(!sync.contains("result conversion failed"), "{sync}");

    let id = start(&h, &mut env, "lookupLater", vec![s("nan"), V::Num(0.0)]);
    let settled = h.settle(&mut env, 1);
    assert_eq!(settled[0].0, id);
    match &settled[0].1 {
        Settled::Failed(message) => {
            assert!(message.starts_with("error conversion failed: "), "{message}");
            assert!(!message.contains("result conversion failed"), "{message}");
        }
        other => panic!("{other:?}"),
    }
    // A result that fails its conversion keeps the existing prefix.
    start(&h, &mut env, "jsonNumberLater", vec![V::Num(f64::NAN)]);
    match &h.settle(&mut env, 1)[0].1 {
        Settled::Failed(message) => assert!(message.starts_with("result conversion failed: "), "{message}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn async_declared_errors_settle_with_status_4_and_the_value() {
    let h = h();
    let mut env = h.env();
    let ok = start(&h, &mut env, "lookupLater", vec![s("one"), V::Num(0.0)]);
    let err = start(&h, &mut env, "lookupLater", vec![s("missing"), V::Num(0.0)]);
    let mut settled = h.settle(&mut env, 2);
    settled.sort_by_key(|(id, _, _)| *id);
    assert_eq!((settled[0].0, &settled[0].1, settled[0].2.num()), (ok, &Settled::Ok(String::new()), 1.0));
    assert_eq!((settled[1].0, &settled[1].1), (err, &Settled::Domain));
    assert_eq!(format!("{:?}", settled[1].2), r#"{"kind": "notFound", "key": "missing"}"#);
}

#[test]
fn cancellation_before_completion_wins_over_a_declared_error() {
    let h = h();
    let mut env = h.env();
    let id = start(&h, &mut env, "lookupLater", vec![s("missing"), V::Num(200.0)]);
    assert!(h.adapter.cancel(id));
    let settled = h.settle(&mut env, 1);
    assert_eq!((settled[0].0, &settled[0].1), (id, &Settled::Cancelled));
}

#[test]
fn a_queued_declared_error_settles_although_cancel_comes_later() {
    let h = h();
    let mut env = h.env();
    let id = start(&h, &mut env, "lookupLater", vec![s("missing"), V::Num(0.0)]);
    wait_queued(&h, 1);
    assert!(!h.adapter.cancel(id), "the outcome is already queued");
    let settled = h.settle(&mut env, 1);
    assert_eq!((settled[0].0, &settled[0].1), (id, &Settled::Domain));
}

#[test]
fn teardown_before_drain_settles_nothing() {
    let h = h();
    let mut env = h.env();
    start(&h, &mut env, "lookupLater", vec![s("missing"), V::Num(0.0)]);
    wait_queued(&h, 1);
    h.adapter.teardown();
    let mut count = 0;
    h.adapter.drain(&mut env, 64, |_, _, _, _, _| count += 1);
    assert_eq!(count, 0);
}

#[test]
fn getter_exceptions_during_argument_reads_propagate_unchanged() {
    let h = h();
    let mut env = h.env();
    // A hole reads through the array prototype, whose getter throws before the method runs.
    env.array_proto = Rc::new(Obj::default());
    env.array_proto.props.borrow_mut().push(("0".into(), Prop::Getter(Rc::new(|_| Err("boom from hole".into())))));
    let holey = V::Arr(Rc::new(std::cell::RefCell::new(vec![None])));
    assert_eq!(h.call(&mut env, "limitedSum", NONE, vec![holey, V::Num(1.0)]).unwrap_err(), "thrown: boom from hole");
}

// A success converter that hits a JS exception keeps today's drain text (the declared-error
// prefix applies only to declared errors).
static PROBE_METHODS: [MethodDef; 1] = [MethodDef { name: "thrownLater", kind: MethodKind::Async }];
struct ProbeInstance;
static PROBE: ModuleDef = ModuleDef {
    name: "DrainPrefixProbe",
    hash: "test",
    methods: &PROBE_METHODS,
    scalars: &[],
    native_types: &[],
    instantiate: || Ok(Box::new(ProbeInstance)),
    call: |cx: &mut Call<'_>, _, _: Val, _: &[Val]| cx.start(|_| async { Ok(pending(|_| Err(BindError::Thrown))) }),
};

#[test]
fn a_thrown_success_conversion_keeps_the_result_prefix() {
    let h = Harness::new(&PROBE, 4);
    let mut env = h.env();
    start(&h, &mut env, "thrownLater", vec![]);
    assert_eq!(h.settle(&mut env, 1)[0].1, Settled::Failed("result conversion failed: a JS exception was thrown during conversion".into()));
}
