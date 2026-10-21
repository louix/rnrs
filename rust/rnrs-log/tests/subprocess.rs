//! Regressions that could hang or abort a process, each run as a child process of this test
//! binary under a timeout: a deadlock fails the test instead of hanging it, and an abort is
//! reported instead of taking the test runner down.
mod common;

use std::fmt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::Capture;
use tracing_subscriber::prelude::*;

const CHILD: &str = "RNRS_LOG_CHILD";

/// Runs the test function `name` of this binary in a child process; returns its stdout.
fn run_child(name: &str) -> String {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([name, "--exact", "--nocapture", "--test-threads", "1"])
        .env(CHILD, name)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            let output = child.wait_with_output().unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            assert!(status.success(), "child {name} failed: {status}\nstdout:\n{stdout}\nstderr:\n{}", String::from_utf8_lossy(&output.stderr));
            return stdout;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("child {name} did not finish within 30 s (deadlock?)");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn is_child(name: &str) -> bool {
    std::env::var(CHILD).as_deref() == Ok(name)
}

/// Prints every captured line so the parent can check them.
fn install_printing_capture() -> Capture {
    let capture = Capture::default();
    tracing::subscriber::set_global_default(tracing_subscriber::registry().with(rnrs_log::layer(capture.sink()))).unwrap();
    capture
}

/// A field value whose `Debug` logs and records into the span it is attached to.
struct Reentrant<'a>(&'a tracing::Span);

impl fmt::Debug for Reentrant<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        tracing::warn!("emitted from Debug");
        self.0.record("again", "recorded from Debug");
        f.write_str("reentrant")
    }
}

#[test]
fn child_debug_that_logs_and_records_the_same_span() {
    if !is_child("child_debug_that_logs_and_records_the_same_span") {
        return;
    }
    let capture = install_printing_capture();
    let span = tracing::info_span!("work", field = tracing::field::Empty, again = tracing::field::Empty);
    let _entered = span.enter();
    span.record("field", tracing::field::debug(Reentrant(&span)));
    tracing::info!(value = ?Reentrant(&span), "event");
    for line in capture.texts() {
        println!("LINE {line}");
    }
    println!("DONE");
}

#[test]
fn debug_that_logs_and_records_the_same_span_neither_deadlocks_nor_recurses() {
    let out = run_child("child_debug_that_logs_and_records_the_same_span");
    assert!(out.contains("DONE"), "{out}");
    // The record and the event were formatted outside the span's extension lock; what their
    // Debug emitted or recorded while formatting was dropped (no recursion).
    assert!(out.contains("LINE work{field=reentrant}: event value=reentrant"), "{out}");
    assert!(!out.contains("emitted from Debug") && !out.contains("recorded from Debug"), "{out}");
}

struct LogsOnDrop;

impl Drop for LogsOnDrop {
    fn drop(&mut self) {
        tracing::info!("logged from a thread-local destructor");
    }
}

thread_local! {
    static LOGS_ON_DROP: LogsOnDrop = const { LogsOnDrop };
}

#[test]
fn child_logging_from_a_thread_local_destructor() {
    if !is_child("child_logging_from_a_thread_local_destructor") {
        return;
    }
    let capture = install_printing_capture();
    std::thread::spawn(|| {
        // Registered first, so destroyed after the layer's own thread-locals (destructors run
        // in reverse order of registration): it logs when the line buffer is already gone.
        LOGS_ON_DROP.with(|_| {});
        tracing::info!("warm up the per-thread buffer");
    })
    .join()
    .unwrap();
    for line in capture.texts() {
        println!("LINE {line}");
    }
    println!("DONE");
}

#[test]
fn logging_from_a_thread_local_destructor_does_not_abort() {
    let out = run_child("child_logging_from_a_thread_local_destructor");
    assert!(out.contains("LINE warm up the per-thread buffer"), "{out}");
    assert!(out.contains("LINE logged from a thread-local destructor"), "{out}");
    assert!(out.contains("DONE"), "{out}");
}
