//! Native tests over a temporary application data directory (one per test process).
use std::sync::Mutex as StdMutex;

use super::*;
use spec::{KvModule as _, Store as _};

static RELEASE_THREADS: StdMutex<Vec<(String, String)>> = StdMutex::new(Vec::new());

/// Called by `Shared::drop`: which thread performed a database's final release.
pub(super) fn record_release_thread(database: &str) {
    let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
    RELEASE_THREADS.lock().unwrap().push((database.to_string(), thread));
}

fn release_threads(database: &str) -> Vec<String> {
    RELEASE_THREADS.lock().unwrap().iter().filter(|(d, _)| d == database).map(|(_, t)| t.clone()).collect()
}

fn setup() -> Kv {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    let dir = DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("rnr-kv-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        rnr_core::platform::set_app_data_dir(dir.clone()).unwrap();
        dir
    });
    assert!(dir.is_dir());
    Kv
}

fn token() -> CancelToken {
    CancelToken::new()
}

async fn wait_until(mut f: impl FnMut() -> bool) -> bool {
    for _ in 0..500 {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

fn not_open(name: &str) -> bool {
    !lock(registry()).contains_key(name)
}

#[tokio::test(flavor = "multi_thread")]
async fn values_keys_and_removal() {
    let kv = setup();
    let store = kv.open("basic".into(), token()).await.unwrap();
    store.put("a/1".into(), vec![], token()).await.unwrap();
    store.put("a/2".into(), (0..=255).collect(), token()).await.unwrap();
    store.put("b".into(), b"x".to_vec(), token()).await.unwrap();
    assert_eq!(store.get("a/1".into(), token()).await.unwrap(), Some(vec![]));
    assert_eq!(store.get("a/2".into(), token()).await.unwrap(), Some((0..=255).collect()));
    assert_eq!(store.get("missing".into(), token()).await.unwrap(), None);
    assert_eq!(store.keys("a/".into(), 10.0, token()).await.unwrap(), vec!["a/1", "a/2"]);
    assert_eq!(store.keys("".into(), 2.0, token()).await.unwrap(), vec!["a/1", "a/2"]);
    assert!(store.remove("b".into(), token()).await.unwrap());
    assert!(!store.remove("b".into(), token()).await.unwrap());
    assert!(store.flush(token()).await.unwrap() >= 0.0);
    for bad in [0.0, 1.5, 10_001.0, f64::NAN] {
        assert!(store.validate_keys(&String::new(), &bad).unwrap_err().starts_with("invalid: limit"));
    }
    store.close(token()).await.unwrap();
}

#[test]
fn names_cannot_escape_the_data_directory() {
    let kv = setup();
    for bad in ["", "../x", "a/b", "a\\b", ".hidden", "-x", "_x", "A", "é", "a b", "/abs", &"a".repeat(65)] {
        assert!(kv.validate_open(&bad.to_string()).unwrap_err().starts_with("invalid: database name"), "{bad:?}");
    }
    for ok in ["a", "0", "test-db_1", &"z".repeat(64)] {
        assert!(kv.validate_open(&ok.to_string()).is_ok(), "{ok:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn close_waits_for_in_flight_operations_and_refuses_later_ones() {
    let kv = setup();
    let store = kv.open("close-race".into(), token()).await.unwrap();
    let writes: Vec<_> = (0..64)
        .map(|i| {
            let store = store.clone();
            tokio::spawn(async move { store.put(format!("k{i:03}"), vec![i as u8; 4096], token()).await })
        })
        .collect();
    tokio::task::yield_now().await;
    store.close(token()).await.unwrap();
    // Every write either completed before close finished, or was refused as closed; none
    // is lost or half-applied.
    let mut applied = Vec::new();
    for (i, w) in writes.into_iter().enumerate() {
        match w.await.unwrap() {
            Ok(()) => applied.push(i),
            Err(e) => assert_eq!(e, CLOSED),
        }
    }
    assert_eq!(store.get("k000".into(), token()).await.unwrap_err(), CLOSED);
    store.close(token()).await.unwrap(); // idempotent
    drop(store);
    assert!(wait_until(|| not_open("close-race")).await);
    let again = kv.open("close-race".into(), token()).await.unwrap();
    assert_eq!(again.keys("k".into(), 100.0, token()).await.unwrap().len(), applied.len());
    for i in &applied {
        assert_eq!(again.get(format!("k{i:03}"), token()).await.unwrap(), Some(vec![*i as u8; 4096]));
    }
    again.close(token()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn handles_share_one_database_and_the_last_release_is_off_the_caller_thread() {
    let kv = setup();
    let a = kv.open("shared".into(), token()).await.unwrap();
    let b = kv.open("shared".into(), token()).await.unwrap();
    assert!(Arc::ptr_eq(lock(&(*a).shared).as_ref().unwrap(), lock(&(*b).shared).as_ref().unwrap()));
    a.put("k".into(), b"from a".to_vec(), token()).await.unwrap();
    assert_eq!(b.get("k".into(), token()).await.unwrap(), Some(b"from a".to_vec()));
    // Closing one handle leaves the other usable (a reload's old and new runtimes).
    a.close(token()).await.unwrap();
    assert_eq!(b.get("k".into(), token()).await.unwrap(), Some(b"from a".to_vec()));
    // Dropping the last handle without close (a finalized or torn-down wrapper) hands the
    // final flush to the closer thread.
    assert!(release_threads("shared").is_empty());
    drop(a);
    drop(b);
    assert!(wait_until(|| not_open("shared")).await);
    assert_eq!(release_threads("shared"), vec!["rnr-kv-closer"]);
    let c = kv.open("shared".into(), token()).await.unwrap();
    assert_eq!(c.get("k".into(), token()).await.unwrap(), Some(b"from a".to_vec()), "persisted across the reopen");
    c.close(token()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn reopening_right_after_the_last_release_waits_instead_of_failing_on_the_lock() {
    let kv = setup();
    for round in 0..20u8 {
        let store = kv.open("reopen".into(), token()).await.unwrap();
        store.put("round".into(), vec![round], token()).await.unwrap();
        drop(store); // released on the closer thread, possibly still in progress
        let store = kv.open("reopen".into(), token()).await.unwrap();
        assert_eq!(store.get("round".into(), token()).await.unwrap(), Some(vec![round]));
        drop(store);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn delete_database_only_when_not_open() {
    let kv = setup();
    let store = kv.open("deletable".into(), token()).await.unwrap();
    store.put("k".into(), b"v".to_vec(), token()).await.unwrap();
    assert!(kv.delete_database("deletable".into(), token()).await.unwrap_err().starts_with("busy:"));
    store.close(token()).await.unwrap();
    drop(store);
    assert!(wait_until(|| not_open("deletable")).await);
    assert!(kv.delete_database("deletable".into(), token()).await.unwrap());
    assert!(!database_path("deletable").unwrap().exists());
    assert!(!kv.delete_database("deletable".into(), token()).await.unwrap());
    let fresh = kv.open("deletable".into(), token()).await.unwrap();
    assert_eq!(fresh.get("k".into(), token()).await.unwrap(), None);
    fresh.close(token()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_started_write_is_applied_even_if_cancelled() {
    let kv = setup();
    let store = kv.open("cancel".into(), token()).await.unwrap();
    let cancel = token();
    cancel.cancel();
    store.put("k".into(), b"v".to_vec(), cancel).await.unwrap();
    assert_eq!(store.get("k".into(), token()).await.unwrap(), Some(b"v".to_vec()));
    store.close(token()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn every_close_waits_for_in_flight_operations_and_the_flush() {
    let kv = setup();
    let store = kv.open("close-join".into(), token()).await.unwrap();
    let gate = testing::hold_gate();
    let held = {
        let store = store.clone();
        tokio::spawn(async move { store.put("__gate/1".into(), b"held".to_vec(), token()).await })
    };
    assert!(wait_until(|| *lock(&store.in_flight) == 1).await, "the gated write is in flight");
    let closes: Vec<_> = (0..3)
        .map(|_| {
            let store = store.clone();
            tokio::spawn(async move { store.close(token()).await })
        })
        .collect();
    // No close resolves while the write is held, and new operations are already refused.
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(closes.iter().all(|c| !c.is_finished()), "a close resolved before its in-flight write finished");
    assert_eq!(store.get("x".into(), token()).await.unwrap_err(), CLOSED);
    drop(gate);
    assert_eq!(held.await.unwrap(), Ok(()));
    for c in closes {
        assert_eq!(c.await.unwrap(), Ok(()));
    }
    assert_eq!(store.close(token()).await, Ok(()), "a later close gets the same outcome");
    drop(store);
    assert!(wait_until(|| not_open("close-join")).await);
    let again = kv.open("close-join".into(), token()).await.unwrap();
    assert_eq!(again.get("__gate/1".into(), token()).await.unwrap(), Some(b"held".to_vec()));
    again.close(token()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_close_is_terminal_and_shared_by_every_caller() {
    let kv = setup();
    let store = kv.open("close-fail".into(), token()).await.unwrap();
    store.put("k".into(), b"v".to_vec(), token()).await.unwrap();
    testing::fail_next_close_flush("close-fail");
    let (a, b) = tokio::join!(store.close(token()), store.close(token()));
    let expected = Err("storage: injected flush failure (test hook)".to_string());
    assert_eq!((a, b), (expected.clone(), expected.clone()));
    assert_eq!(store.close(token()).await, expected, "the failure is the handle's terminal close outcome");
    assert_eq!(store.put("k2".into(), vec![], token()).await.unwrap_err(), CLOSED);
    // The database itself was still released (and flushed on release).
    drop(store);
    assert!(wait_until(|| not_open("close-fail")).await);
    let again = kv.open("close-fail".into(), token()).await.unwrap();
    assert_eq!(again.get("k".into(), token()).await.unwrap(), Some(b"v".to_vec()));
    again.close(token()).await.unwrap();
}
