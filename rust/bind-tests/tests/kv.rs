//! @rnrs/example-kv through its generated glue and a real adapter (Tokio executor, admission,
//! settlement): concurrent closes join one outcome after the in-flight write, including a
//! terminal failure.
use std::time::Duration;

use bind_tests::harness::{Harness, Settled};
use bind_tests::modules::rnrs_kv as kv_glue;
use bind_tests::V;

fn harness() -> Harness {
    let dir = std::env::temp_dir().join(format!("rnrs-kv-glue-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    rnrs_core::platform::set_app_data_dir(dir).unwrap();
    Harness::new(&kv_glue::MODULE, 32)
}

/// Opens `name` through the glue and returns the Store wrapper.
fn open(h: &Harness, env: &mut bind_tests::MockEnv, name: &str) -> V {
    h.call(env, "open", V::Undefined, vec![V::str(name)]).unwrap();
    let mut out = h.settle(env, 1);
    assert_eq!(out[0].1, Settled::Ok(String::new()));
    out.remove(0).2
}

#[test]
fn concurrent_closes_through_the_adapter_resolve_only_after_the_in_flight_write() {
    let h = harness();
    let mut env = h.env();
    let store = open(&h, &mut env, "glue-close");
    let gate = rnrs_kv::testing::hold_gate();
    let put = h.call(&mut env, "Store.put", store.clone(), vec![V::str("__gate/1"), V::buf(b"held")]).unwrap().num() as u64;
    std::thread::sleep(Duration::from_millis(50));
    let closes: Vec<u64> = (0..2).map(|_| h.call(&mut env, "Store.close", store.clone(), vec![]).unwrap().num() as u64).collect();
    // Nothing settles while the write is held.
    std::thread::sleep(Duration::from_millis(200));
    let mut early = Vec::new();
    h.adapter.drain(&mut env, 64, |_, id, status, _, _| early.push((id, status)));
    assert!(early.is_empty(), "settled before the in-flight write finished: {early:?}");
    drop(gate);
    let settled = h.settle(&mut env, 3);
    for id in std::iter::once(put).chain(closes) {
        let s = settled.iter().find(|s| s.0 == id).unwrap();
        assert_eq!(s.1, Settled::Ok(String::new()), "operation {id}");
    }
    // Later operations on the handle are refused.
    h.call(&mut env, "Store.get", store, vec![V::str("x")]).unwrap();
    assert_eq!(h.settle(&mut env, 1)[0].1, Settled::Failed("closed: this Store handle was closed".into()));
}

#[test]
fn a_failed_close_through_the_adapter_is_the_outcome_of_every_close() {
    let h = harness();
    let mut env = h.env();
    let store = open(&h, &mut env, "glue-close-fail");
    rnrs_kv::testing::fail_next_close_flush("glue-close-fail");
    for _ in 0..2 {
        h.call(&mut env, "Store.close", store.clone(), vec![]).unwrap();
    }
    let failure = Settled::Failed("storage: injected flush failure (test hook)".into());
    assert!(h.settle(&mut env, 2).iter().all(|s| s.1 == failure));
    h.call(&mut env, "Store.close", store, vec![]).unwrap();
    assert_eq!(h.settle(&mut env, 1)[0].1, failure);
}
