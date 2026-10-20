//! Lab-only fixture for the Rust logging smoke (docs/logging.md). Ordinary library code: it
//! only emits `tracing` events and `log` records, like any crate an app depends on; where they
//! go is the app's choice. The smoke's filter is expected to keep the `info` events of target
//! `log_probe` and suppress the rest (lower levels, and target `log_probe::noisy`).
use rnr_core::CancelToken;

pub mod rnr_interface;
use rnr_interface as spec;

#[derive(Default)]
pub struct Module;

/// The probe's events, on the current thread; returns the thread's name.
pub fn emit_events(id: &str, place: &str) -> String {
    let thread = std::thread::current().name().unwrap_or("unnamed").to_owned();
    tracing::info!(target: "log_probe", id, place, thread = %thread, "probe tracing info");
    log::info!(target: "log_probe", "probe log info id={id} place={place} thread={thread}");
    // Suppressed by level (the filter keeps log_probe at info).
    tracing::debug!(target: "log_probe", id, place, "probe tracing debug SUPPRESSED");
    log::debug!(target: "log_probe", "probe log debug SUPPRESSED id={id}");
    // Suppressed by target (log_probe::noisy=off), although warn passes the default level.
    tracing::warn!(target: "log_probe::noisy", id, place, "probe noisy tracing warn SUPPRESSED");
    log::warn!(target: "log_probe::noisy", "probe noisy log warn SUPPRESSED id={id}");
    thread
}

impl spec::LogProbeModule for Module {
    fn emit(&self, id: String) -> Result<String, String> {
        Ok(emit_events(&id, "js"))
    }

    async fn emit_on_worker(&self, id: String, _cancel: CancelToken) -> Result<String, String> {
        Ok(emit_events(&id, "worker"))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn emits_without_a_subscriber_and_reports_the_thread() {
        let name = std::thread::Builder::new()
            .name("probe-test".into())
            .spawn(|| super::emit_events("t", "test"))
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(name, "probe-test");
    }
}
