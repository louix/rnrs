//! Managed install in a fresh process: both slots free. One test function, because the
//! globals are per process and test functions run concurrently.
mod common;

use std::sync::{Arc, Barrier};

use common::Capture;
use rnrs_log::{install, status, InstallError, ManagedConfig, Outcome, Privacy, Slot};
use tracing::Level;

#[test]
fn full_install_filters_tracing_and_log_by_original_target_and_defends_its_slots() {
    let capture = Capture::default();
    let config = ManagedConfig { filter: "info,sled=warn,noisy=off".into(), privacy: Privacy::Private, sink: Some(capture.sink()) };

    // Concurrent installers: exactly one installs; every caller gets the same status.
    let barrier = Arc::new(Barrier::new(4));
    let results: Vec<_> = (0..4)
        .map(|_| {
            let (config, barrier) = (config.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                install(config).unwrap()
            })
        })
        .collect::<Vec<_>>()
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect();
    let first = &results[0];
    assert!(results.iter().all(|s| s == first));
    assert_eq!((first.tracing, first.log, first.outcome), (Slot::Installed, Slot::Installed, Outcome::Full));
    assert_eq!(status().as_ref(), Some(first));
    assert_eq!(log::max_level(), log::LevelFilter::Info, "log max level follows the filter's maximum");
    let startup: Vec<_> = capture.take().into_iter().map(|c| (c.target, c.text)).collect();
    assert_eq!(startup, vec![
        ("rnrs_log".into(), "installed: tracing subscriber and log bridge filter=info,sled=warn,noisy=off".into()),
        ("rnrs_log".into(), "log bridge ready".into()),
    ]);

    // Same configuration again: the same status, nothing reinstalled. A different one: error.
    assert_eq!(&install(config.clone()).unwrap(), first);
    let other = ManagedConfig { filter: "debug".into(), ..config.clone() };
    assert!(matches!(install(other), Err(InstallError::ConflictingConfig { existing }) if &existing == first));

    // Target filters apply to tracing events and to bridged log records by their own target.
    tracing::info!(target: "app", n = 1, "tracing kept");
    tracing::info!(target: "sled::tree", "tracing sled info dropped");
    tracing::warn!(target: "sled::tree", "tracing sled warn kept");
    tracing::debug!(target: "app", "tracing debug dropped");
    log::info!(target: "app", "log kept {}", 2);
    log::info!(target: "sled::pagecache", "log sled info dropped");
    log::warn!(target: "sled::pagecache", "log sled warn kept");
    log::error!(target: "noisy", "log noisy off");
    log::debug!(target: "app", "log debug dropped");
    let got: Vec<_> = capture.take().into_iter().map(|c| (c.level, c.target, c.text)).collect();
    assert_eq!(got, vec![
        (Level::INFO, "app".into(), "tracing kept n=1".into()),
        (Level::WARN, "sled::tree".into(), "tracing sled warn kept".into()),
        (Level::INFO, "app".into(), "log kept 2".into()),
        (Level::WARN, "sled::pagecache".into(), "log sled warn kept".into()),
    ]);

    // Conflict order "rnr first": later global installers are refused, rnr's stay in place.
    assert!(tracing::subscriber::set_global_default(tracing_subscriber::registry()).is_err());
    struct Other;
    impl log::Log for Other {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool { true }
        fn log(&self, _: &log::Record<'_>) { panic!("the other logger must never receive records") }
        fn flush(&self) {}
    }
    assert!(log::set_logger(&Other).is_err());
    log::warn!(target: "app", "still bridged");
    assert_eq!(capture.texts(), vec!["still bridged"]);

    // Many native threads at once: every line arrives whole, nothing lost or interleaved.
    let threads = 8;
    let per_thread = 250;
    let handles: Vec<_> = (0..threads)
        .map(|t| {
            std::thread::spawn(move || {
                for i in 0..per_thread {
                    if i % 2 == 0 {
                        tracing::info!(target: "app", thread = t, i, "via tracing");
                    } else {
                        log::info!(target: "app", "via log thread={t} i={i}");
                    }
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    let lines = capture.texts();
    assert_eq!(lines.len(), threads * per_thread);
    for t in 0..threads {
        for i in 0..per_thread {
            let expected = if i % 2 == 0 { format!("via tracing thread={t} i={i}") } else { format!("via log thread={t} i={i}") };
            assert!(lines.contains(&expected), "missing {expected}");
        }
    }
}
