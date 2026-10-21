//! Managed install when another component already set the log facade's logger.
mod common;

use std::sync::atomic::{AtomicUsize, Ordering};

use common::Capture;
use rnrs_log::{install, ManagedConfig, Outcome, Privacy, Slot};

static THEIRS: AtomicUsize = AtomicUsize::new(0);

struct Theirs;
impl log::Log for Theirs {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool { true }
    fn log(&self, _: &log::Record<'_>) { THEIRS.fetch_add(1, Ordering::SeqCst); }
    fn flush(&self) {}
}

#[test]
fn log_slot_occupied_is_a_partial_install_that_keeps_their_logger_and_level() {
    log::set_logger(&Theirs).unwrap();
    log::set_max_level(log::LevelFilter::Error);

    let ours = Capture::default();
    let status = install(ManagedConfig { filter: "info".into(), privacy: Privacy::Private, sink: Some(ours.sink()) }).unwrap();
    assert_eq!((status.tracing, status.log, status.outcome), (Slot::Installed, Slot::Occupied, Outcome::Partial));
    assert_eq!(log::max_level(), log::LevelFilter::Error, "their log max level is unchanged");
    let warning = ours.take();
    assert_eq!(warning.len(), 1);
    assert_eq!(warning[0].level, tracing::Level::WARN);
    assert!(warning[0].text.starts_with("partially installed:"), "{}", warning[0].text);

    // tracing events use rnrs's filter and sink; log records go to their logger.
    tracing::info!("ours");
    tracing::debug!("filtered");
    log::error!("theirs");
    assert_eq!(ours.texts(), vec!["ours"]);
    assert_eq!(THEIRS.load(Ordering::SeqCst), 1);
}
