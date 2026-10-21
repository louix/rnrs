//! Managed install when another component already set the tracing global default.
mod common;

use common::Capture;
use rnrs_log::{install, ManagedConfig, Outcome, Privacy, Slot};

#[test]
fn tracing_slot_occupied_installs_nothing_and_says_so() {
    let theirs = Capture::default();
    tracing::subscriber::set_global_default(tracing_subscriber::registry().with(rnrs_log::layer(theirs.sink()))).unwrap();
    let before = log::max_level();

    let ours = Capture::default();
    let status = install(ManagedConfig { filter: "debug".into(), privacy: Privacy::Private, sink: Some(ours.sink()) }).unwrap();
    assert_eq!((status.tracing, status.log, status.outcome), (Slot::Occupied, Slot::Skipped, Outcome::NotInstalled));
    assert_eq!(log::max_level(), before, "log::max_level must not change when nothing was installed");
    let warning = ours.take();
    assert_eq!(warning.len(), 1);
    assert_eq!(warning[0].level, tracing::Level::WARN);
    assert!(warning[0].text.starts_with("not installed: the tracing global default subscriber was already set"), "{}", warning[0].text);

    // Their subscriber still receives events; rnrs's filter does not apply to it.
    tracing::trace!("theirs");
    assert_eq!(theirs.texts(), vec!["theirs"]);
    assert!(ours.take().is_empty());
    // The log slot was skipped, so it is still free for its owner.
    assert!(log::set_logger(&NoLog).is_ok());
}

use tracing_subscriber::prelude::*;

struct NoLog;
impl log::Log for NoLog {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool { false }
    fn log(&self, _: &log::Record<'_>) {}
    fn flush(&self) {}
}
