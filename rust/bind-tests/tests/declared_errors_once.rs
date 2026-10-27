//! A method with a declared error runs exactly once per call, sync and async (its own test
//! binary: the fixture's call counter is process-wide).
use bind_tests::harness::{Harness, Settled};
use bind_tests::modules::values;
use bind_tests::V;

#[test]
fn each_call_runs_the_rust_method_once() {
    let h = Harness::new(&values::MODULE, 8);
    let mut env = h.env();
    let calls = |env: &mut bind_tests::MockEnv| h.call(env, "lookupCalls", V::Undefined, vec![]).unwrap().num();
    let before = calls(&mut env);
    assert!(h.call(&mut env, "lookup", V::Undefined, vec![V::str("missing")]).is_err());
    assert!(h.call(&mut env, "half", V::Undefined, vec![V::Num(3.0)]).is_err());
    assert_eq!(calls(&mut env), before + 2.0);
    h.call(&mut env, "lookupLater", V::Undefined, vec![V::str("busy"), V::Num(0.0)]).unwrap();
    assert_eq!(h.settle(&mut env, 1)[0].1, Settled::Domain);
    assert_eq!(calls(&mut env), before + 3.0);
}
