//! The probe under the same managed install and filter as the Android logging smoke, on the
//! host: which of its events arrive, from the calling thread and from a worker thread.
use std::sync::{Arc, Mutex};

use rnrs_log::{install, Line, ManagedConfig, Outcome, Privacy, Sink};

#[test]
fn the_smoke_filter_keeps_probe_info_and_suppresses_lower_levels_and_the_noisy_target() {
    let lines: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let capture = lines.clone();
    let sink = Sink::Custom(Arc::new(move |line: Line<'_>| capture.lock().unwrap().push((line.target.to_owned(), line.text.to_owned()))));
    let filter = "warn,rnrs_log=info,log_probe=info,log_probe::noisy=off";
    let status = install(ManagedConfig { filter: filter.into(), privacy: Privacy::Private, sink: Some(sink) }).unwrap();
    assert_eq!(status.outcome, Outcome::Full);

    log_probe::emit_events("p-js", "js");
    let worker = std::thread::Builder::new().name("worker".into()).spawn(|| log_probe::emit_events("p-worker", "worker")).unwrap();
    assert_eq!(worker.join().unwrap(), "worker");

    let lines = lines.lock().unwrap().clone();
    let texts: Vec<&str> = lines.iter().map(|(_, t)| t.as_str()).collect();
    assert!(texts.iter().all(|t| !t.contains("SUPPRESSED")), "{texts:#?}");
    for place in ["js", "worker"] {
        let id = format!("p-{place}");
        assert!(texts.iter().any(|t| t.starts_with("probe tracing info") && t.contains(&format!("id={id} place={place}"))), "{texts:#?}");
        assert!(texts.iter().any(|t| t.starts_with(&format!("probe log info id={id} place={place}"))), "{texts:#?}");
    }
    assert!(lines.iter().all(|(target, _)| target == "rnrs_log" || target == "log_probe"), "{lines:#?}");
    assert_eq!(lines.len(), 2 + 4, "two startup lines and four probe lines: {texts:#?}");
}
