//! Live-object counts are process-wide, so this check runs in its own test binary.
use bind_tests::harness::Harness;
use bind_tests::modules::counter;
use bind_tests::{dispose, V};
use rnr_core::live_counts_by_name;

const NONE: V = V::Undefined;

fn counter() -> Harness {
    Harness::new(&counter::MODULE, 8)
}

#[test]
fn native_objects_are_released_with_their_last_owner() {
    let h = counter();
    let mut env = h.env();
    let name = counter::MODULE.native_types[0].rust_type;
    let before = live_counts_by_name(name());
    let c = h.call(&mut env, "create", NONE, vec![V::Num(0.0)]).unwrap();
    h.call(&mut env, "Counter.addLater", c.clone(), vec![V::Num(1.0), V::Num(30.0), V::Bool(false)]).unwrap();
    dispose(&c);
    drop(c);
    drop(env);
    let mut env = h.env();
    let mid = live_counts_by_name(name());
    assert_eq!(mid.created - before.created, 1);
    assert_eq!(mid.dropped - before.dropped, 0, "the operation still owns it");
    h.settle(&mut env, 1);
    let after = live_counts_by_name(name());
    assert_eq!(after.dropped - before.dropped, 1);
}
