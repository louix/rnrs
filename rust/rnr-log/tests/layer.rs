//! The layer under scoped (thread-local default) subscribers: no global state is touched.
mod common;

use std::cell::Cell;
use std::fmt;
use std::sync::Arc;

use common::Capture;
use rnr_log::{layer, Line, Sink, MAX_LINE, MAX_SPAN_FIELDS, TRUNCATED};
use tracing::Level;
use tracing_subscriber::filter::Targets;
use tracing_subscriber::prelude::*;
use tracing_subscriber::Registry;

fn scoped(capture: &Capture, filter: &str) -> impl tracing::Subscriber + Send + Sync {
    Registry::default().with(layer(capture.sink()).with_filter(filter.parse::<Targets>().unwrap()))
}

#[test]
fn events_carry_message_fields_and_their_span_scope_with_record_updates() {
    let capture = Capture::default();
    tracing::subscriber::with_default(scoped(&capture, "trace"), || {
        let outer = tracing::info_span!("request", id = 7, path = "/a b", user = tracing::field::Empty);
        let _o = outer.enter();
        outer.record("user", "ann");
        let inner = tracing::debug_span!("db");
        let _i = inner.enter();
        tracing::info!(rows = 3, cached = false, "query done");
        tracing::warn!("no fields");
        tracing::error!(only = "field");
    });
    let lines = capture.take();
    assert_eq!(lines[0].text, r#"request{id=7 path="/a b" user=ann}:db: query done rows=3 cached=false"#);
    assert_eq!(lines[0].level, Level::INFO);
    assert_eq!(lines[0].target, "layer");
    assert_eq!(lines[1].text, r#"request{id=7 path="/a b" user=ann}:db: no fields"#);
    assert_eq!(lines[2].text, r#"request{id=7 path="/a b" user=ann}:db: only=field"#);
}

#[test]
fn explicit_parents_and_no_scope() {
    let capture = Capture::default();
    tracing::subscriber::with_default(scoped(&capture, "trace"), || {
        let job = tracing::info_span!("job", n = 1);
        let other = tracing::info_span!("other");
        let _o = other.enter();
        tracing::info!(parent: &job, "explicit parent");
        tracing::info!(parent: None, "root");
        tracing::info!("contextual");
    });
    assert_eq!(capture.texts(), vec!["job{n=1}: explicit parent", "root", "other: contextual"]);
}

#[test]
fn nul_and_control_characters_are_escaped_everywhere() {
    let capture = Capture::default();
    tracing::subscriber::with_default(scoped(&capture, "trace"), || {
        let span = tracing::info_span!("s\0pan", v = "a\0b");
        let _s = span.enter();
        tracing::info!(x = "line\nbreak", "nul\0inside");
    });
    let text = &capture.take()[0].text;
    assert!(!text.contains('\0') && !text.contains('\n'), "{text:?}");
    assert_eq!(text, r#"s\0pan{v="a\0b"}: nul\0inside x="line\nbreak""#);
}

#[test]
fn lines_and_span_fields_are_bounded_while_formatting() {
    let capture = Capture::default();
    tracing::subscriber::with_default(scoped(&capture, "trace"), || {
        let big = "é".repeat(MAX_SPAN_FIELDS); // 2 bytes each: twice the span bound
        let span = tracing::info_span!("big", v = %big);
        let _s = span.enter();
        span.record("v", "ignored once full");
        tracing::info!("{}", "€".repeat(MAX_LINE)); // 3 bytes each
    });
    let text = capture.take().remove(0).text;
    assert!(text.ends_with(TRUNCATED), "{}", &text[text.len() - 40..]);
    assert!(text.len() <= MAX_LINE + TRUNCATED.len(), "{}", text.len());
    let span_part = text.split("}:").next().unwrap();
    assert!(span_part.ends_with(TRUNCATED), "span fields not marked truncated");
    assert!(span_part.len() <= "big{v=".len() + MAX_SPAN_FIELDS + TRUNCATED.len());
    assert!(std::str::from_utf8(text.as_bytes()).is_ok());
}

struct Counting<'a>(&'a Cell<u32>);
impl fmt::Debug for Counting<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.set(self.0.get() + 1);
        f.write_str("counted")
    }
}

#[test]
fn filtered_out_events_are_never_formatted() {
    let capture = Capture::default();
    let formatted = Cell::new(0);
    tracing::subscriber::with_default(scoped(&capture, "info,noisy=off"), || {
        tracing::debug!(v = ?Counting(&formatted), "below the level");
        tracing::info!(target: "noisy", v = ?Counting(&formatted), "target off");
        tracing::info!(v = ?Counting(&formatted), "kept");
    });
    assert_eq!(formatted.get(), 1);
    assert_eq!(capture.texts(), vec!["kept v=counted"]);
}

#[test]
fn events_emitted_while_writing_are_dropped_not_recursed() {
    let capture = Capture::default();
    let inner = capture.sink();
    let reentrant = Sink::Custom(Arc::new(move |line: Line<'_>| {
        tracing::error!("emitted from inside the sink"); // dropped by the re-entrancy guard
        if let Sink::Custom(f) = &inner {
            f(line);
        }
    }));
    tracing::subscriber::with_default(Registry::default().with(layer(reentrant)), || {
        tracing::info!("outer");
        tracing::info!("second");
    });
    assert_eq!(capture.texts(), vec!["outer", "second"]);
}

#[test]
fn reentrancy_is_guarded_per_thread_under_concurrency() {
    let capture = Capture::default();
    let handles: Vec<_> = (0..8)
        .map(|t| {
            let inner = capture.sink();
            std::thread::spawn(move || {
                let reentrant = Sink::Custom(Arc::new(move |line: Line<'_>| {
                    tracing::error!(nested = t, "from inside the sink"); // dropped on this thread
                    if let Sink::Custom(f) = &inner {
                        f(line);
                    }
                }));
                tracing::subscriber::with_default(Registry::default().with(layer(reentrant)), || {
                    for i in 0..100 {
                        tracing::info!(t, i, "outer");
                    }
                });
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    let lines = capture.texts();
    assert_eq!(lines.len(), 800);
    assert!(lines.iter().all(|l| l.starts_with("outer t=") && !l.contains("nested")));
}

/// A future that is pending once, so its span is entered and exited across two polls.
struct YieldOnce(bool);
impl std::future::Future for YieldOnce {
    type Output = ();
    fn poll(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<()> {
        if self.0 {
            return std::task::Poll::Ready(());
        }
        self.0 = true;
        cx.waker().wake_by_ref();
        std::task::Poll::Pending
    }
}

#[test]
fn instrumented_futures_carry_their_span_across_polls_and_only_while_polled() {
    use std::future::Future;
    use tracing::Instrument;
    let capture = Capture::default();
    tracing::subscriber::with_default(scoped(&capture, "trace"), || {
        let task = async {
            tracing::info!("before yield");
            YieldOnce(false).await;
            tracing::info!("after yield");
        }
        .instrument(tracing::info_span!("task", id = 9));
        let mut task = std::pin::pin!(task);
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(task.as_mut().poll(&mut cx).is_pending());
        tracing::info!("between polls");
        assert!(task.as_mut().poll(&mut cx).is_ready());
    });
    assert_eq!(capture.texts(), vec!["task{id=9}: before yield", "between polls", "task{id=9}: after yield"]);
}

#[test]
fn native_events_keep_their_own_log_fields() {
    let capture = Capture::default();
    tracing::subscriber::with_default(scoped(&capture, "trace"), || {
        tracing::info!(log.kind = "audit", "native");
    });
    assert_eq!(capture.texts(), vec!["native log.kind=audit"]);
}

#[test]
fn a_platform_sink_must_match_the_configured_privacy() {
    use rnr_log::{install, InstallError, ManagedConfig, Privacy};
    let result = install(ManagedConfig { filter: "info".into(), privacy: Privacy::Private, sink: Some(Sink::Platform(Privacy::Public)) });
    assert!(matches!(result, Err(InstallError::PrivacyMismatch { privacy: Privacy::Private, sink: Privacy::Public })));
    assert!(rnr_log::status().is_none(), "nothing was installed");
}

#[test]
fn whole_platform_messages_are_bounded_including_the_target_prefix() {
    use rnr_log::{compose, MAX_MESSAGE};
    let text = format!("{}{}", "é".repeat(MAX_MESSAGE), TRUNCATED);
    let message = compose("some::long::target: ", &text);
    assert!(message.len() <= MAX_MESSAGE, "{}", message.len());
    assert!(message.starts_with("some::long::target: é") && message.ends_with(TRUNCATED));
    assert_eq!(message.matches(TRUNCATED).count(), 1);
    assert_eq!(compose("t: ", "short"), "t: short");
}
