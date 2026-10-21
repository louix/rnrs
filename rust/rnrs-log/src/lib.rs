//! Framework logging for rnrs apps. Libraries (module crates and their dependencies) only emit
//! standard `tracing` events or `log` records; the app chooses where they go, once.
//!
//! - [`layer`]: a `tracing_subscriber::Layer` that formats events (with their span scope and
//!   fields) and writes them to the platform log ([`Sink`]). It does no filtering of its own:
//!   compose it with a filter (`layer(sink).with_filter(targets)`). Usable inside any
//!   subscriber an app owns.
//! - [`install`]: the managed setup that generated bundles call when the app opts in
//!   (`rustNativeApp.logging` in its package.json): a global `Registry` with the filtered
//!   layer, then a `log` -> `tracing` bridge (`tracing_log::LogTracer`). Each global slot is
//!   taken only if free; the result is an explicit [`InstallStatus`].
//!
//! Scope of "global": the `tracing` and `log` globals of the copies of those crates linked into
//! this binary (the app's generated Rust bundle, or one Wasm instance). Another Rust library
//! linked separately into the app (its own dylib or static copy) has its own globals.
use std::cell::{Cell, RefCell};
use std::sync::Mutex;

use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Subscriber};
use tracing_log::NormalizeEvent;
use tracing_subscriber::filter::Targets;
use tracing_subscriber::layer::{Context, Filter};
use tracing_subscriber::prelude::*;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Registry;

mod format;
mod sink;

pub use format::{MAX_LINE, MAX_SPAN_FIELDS, TRUNCATED};
pub use sink::{apple_format, compose, CustomSink, Line, Privacy, Sink, MAX_MESSAGE};

use format::{Bounded, FieldsVisitor, MessageVisitor};

/// The layer that writes formatted events to a [`Sink`].
pub struct RnrsLayer {
    sink: Sink,
}

/// Creates the layer. It formats every event it receives; filtering is the job of the filter
/// it is composed with (`with_filter`) or of the subscriber that owns it.
pub fn layer(sink: Sink) -> RnrsLayer {
    RnrsLayer { sink }
}

/// A span's fields: those given at creation, then each `Span::record` update, bounded to
/// [`MAX_SPAN_FIELDS`] bytes.
struct SpanFields(Bounded);

thread_local! {
    /// Set while this thread formats user values or writes an event. Events, span creations
    /// and `record` calls made from inside (a sink, or a `Debug` implementation that logs or
    /// records) are dropped instead of recursing or re-locking a span's extensions.
    static IN_EVENT: Cell<bool> = const { Cell::new(false) };
    static LINE: RefCell<Bounded> = RefCell::new(Bounded::new(MAX_LINE));
}

/// The per-thread guard. `None` when this thread is already inside (re-entrant call) or its
/// thread-locals are being destroyed (a destructor running at thread exit).
struct EventGuard;

impl EventGuard {
    fn enter() -> Option<EventGuard> {
        IN_EVENT.try_with(|flag| if flag.replace(true) { None } else { Some(EventGuard) }).ok().flatten()
    }
}

impl Drop for EventGuard {
    fn drop(&mut self) {
        let _ = IN_EVENT.try_with(|flag| flag.set(false));
    }
}

/// Formats fields into a new bounded buffer. Runs user `Debug` code, so callers hold no span
/// extension lock while calling it.
fn format_fields(record: impl FnOnce(&mut FieldsVisitor<'_>), skip_log_fields: bool) -> Bounded {
    let mut fields = Bounded::new(MAX_SPAN_FIELDS);
    record(&mut FieldsVisitor { out: &mut fields, leading_space: false, skip_log_fields });
    fields
}

impl<S> tracing_subscriber::Layer<S> for RnrsLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else { return };
        // Formatted before taking the extensions lock; a span created from inside formatting
        // keeps no fields.
        let fields = match EventGuard::enter() {
            Some(_guard) => format_fields(|v| attrs.record(v), false),
            None => Bounded::new(MAX_SPAN_FIELDS),
        };
        span.extensions_mut().insert(SpanFields(fields));
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        // A `record` call made while this thread formats (for example from a field's `Debug`)
        // is dropped: formatting it could recurse without end.
        let Some(_guard) = EventGuard::enter() else { return };
        let update = format_fields(|v| values.record(v), false);
        if update.is_empty() && !update.is_full() {
            return;
        }
        let Some(span) = ctx.span(id) else { return };
        // Only copying already-formatted bytes while the lock is held.
        let mut extensions = span.extensions_mut();
        if let Some(SpanFields(fields)) = extensions.get_mut::<SpanFields>() {
            fields.append_fields(&update);
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let Some(_guard) = EventGuard::enter() else { return };
        // A bridged `log` record arrives on a fixed `log` callsite; its own target and level
        // are in its `log.*` fields, which are therefore not repeated. A native tracing event
        // keeps any field of its own named `log.*`.
        let normalized = event.normalized_metadata();
        let bridged = normalized.is_some();
        let metadata = normalized.as_ref().unwrap_or_else(|| event.metadata());
        let write = |line: &mut Bounded| {
            line.clear();
            // Scope, outermost first; explicit parents (`parent: ...`) are honoured. Stored
            // span fields are copied under each span's read lock; no user code runs there.
            if let Some(scope) = ctx.event_scope(event) {
                for span in scope.from_root() {
                    line.push_escaped(span.name());
                    if let Some(SpanFields(fields)) = span.extensions().get::<SpanFields>() {
                        if !fields.is_empty() || fields.is_full() {
                            line.push_escaped("{");
                            line.push_bounded(fields);
                            line.push_escaped("}");
                        }
                    }
                    line.push_escaped(":");
                }
                if !line.is_empty() {
                    line.push_escaped(" ");
                }
            }
            event.record(&mut MessageVisitor(line));
            let leading_space = !line.is_empty() && !line.as_str().ends_with(' ');
            event.record(&mut FieldsVisitor { out: line, leading_space, skip_log_fields: bridged });
            self.sink.write(Line { level: *metadata.level(), target: metadata.target(), text: line.finish() });
        };
        // The reusable per-thread buffer, or (while thread-locals are being destroyed at thread
        // exit) a bounded buffer of its own.
        let reused = LINE.try_with(|line| match line.try_borrow_mut() {
            Ok(mut line) => {
                write(&mut line);
                true
            }
            Err(_) => false,
        });
        if reused != Ok(true) {
            write(&mut Bounded::new(MAX_LINE));
        }
    }
}

/// The state of one global slot after [`install`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slot {
    /// rnrs installed it.
    Installed,
    /// Something else had already set it; rnrs left it unchanged.
    Occupied,
    /// Not attempted (the `log` bridge is only installed after rnrs's tracing subscriber).
    Skipped,
}

/// The overall result of [`install`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Tracing subscriber and `log` bridge installed: the configured filter and sink apply to
    /// both `tracing` events and `log` records.
    Full,
    /// Tracing subscriber installed, the `log` slot was occupied: `tracing` events are filtered
    /// and written; `log` records go to whatever owns the `log` slot.
    Partial,
    /// The tracing global default was occupied: rnrs installed nothing (the `log` bridge is
    /// skipped), and its filter and sink are not applied.
    NotInstalled,
}

/// Structured result of [`install`], also available later from [`status`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallStatus {
    pub filter: String,
    pub privacy: Privacy,
    pub tracing: Slot,
    pub log: Slot,
    pub outcome: Outcome,
}

/// Managed configuration, fixed for the lifetime of the process (or Wasm instance).
#[derive(Clone, Debug)]
pub struct ManagedConfig {
    /// `tracing_subscriber::filter::Targets` directives: `level`, `target=level`, `target`,
    /// comma-separated; levels `trace`, `debug`, `info`, `warn`, `error`, `off`.
    pub filter: String,
    /// Apple unified-logging privacy of messages (ignored elsewhere).
    pub privacy: Privacy,
    /// Destination; `None` is the platform log.
    pub sink: Option<Sink>,
}

#[derive(Debug)]
pub enum InstallError {
    /// Nothing was installed.
    InvalidFilter { filter: String, error: String },
    /// An earlier install used a different configuration; nothing was changed.
    ConflictingConfig { existing: InstallStatus },
    /// `sink` is `Sink::Platform(p)` with `p` different from `privacy`; nothing was installed.
    PrivacyMismatch { privacy: Privacy, sink: Privacy },
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::InvalidFilter { filter, error } => write!(f, "invalid rnrs-log filter {filter:?}: {error}"),
            InstallError::PrivacyMismatch { privacy, sink } => {
                write!(f, "rnrs-log configuration names privacy {privacy:?} but a platform sink with privacy {sink:?}")
            }
            InstallError::ConflictingConfig { existing } => {
                write!(f, "rnrs-log was already installed with another configuration (filter {:?}, {:?})", existing.filter, existing.privacy)
            }
        }
    }
}

impl std::error::Error for InstallError {}

struct Installed {
    filter: String,
    privacy: Privacy,
    sink: Sink,
    status: InstallStatus,
}

/// Serializes installation: the first call decides; concurrent callers wait for its status.
static STATE: Mutex<Option<Installed>> = Mutex::new(None);

/// The status of the earlier [`install`], if any.
pub fn status() -> Option<InstallStatus> {
    STATE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|s| s.status.clone())
}

/// Installs, in this order and each only if free: the tracing global default (a `Registry`
/// with [`layer`] filtered by `config.filter`), then, only if that succeeded, the `log` ->
/// `tracing` bridge with `log::max_level` set to the filter's maximum. A slot that is already
/// taken is left unchanged (including `log::max_level`). The first call decides; a repeated
/// call with the same configuration returns the same status, a different one is an error.
pub fn install(config: ManagedConfig) -> Result<InstallStatus, InstallError> {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(Sink::Platform(sink)) = &config.sink {
        if *sink != config.privacy {
            return Err(InstallError::PrivacyMismatch { privacy: config.privacy, sink: *sink });
        }
    }
    let sink = config.sink.clone().unwrap_or(Sink::Platform(config.privacy));
    if let Some(existing) = state.as_ref() {
        if existing.filter == config.filter && existing.privacy == config.privacy && existing.sink == sink {
            return Ok(existing.status.clone());
        }
        return Err(InstallError::ConflictingConfig { existing: existing.status.clone() });
    }
    let targets: Targets = config
        .filter
        .parse()
        .map_err(|e: tracing_subscriber::filter::ParseError| InstallError::InvalidFilter { filter: config.filter.clone(), error: e.to_string() })?;
    let max_level = Filter::<Registry>::max_level_hint(&targets).unwrap_or(tracing::level_filters::LevelFilter::TRACE);
    let subscriber = Registry::default().with(layer(sink.clone()).with_filter(targets));
    let (tracing_slot, log_slot) = match tracing::subscriber::set_global_default(subscriber) {
        Err(_) => (Slot::Occupied, Slot::Skipped),
        Ok(()) => {
            // LogTracer's init sets log::max_level only after its logger was accepted.
            let log_slot = match tracing_log::LogTracer::builder().with_max_level(tracing_log::AsLog::as_log(&max_level)).init() {
                Ok(()) => Slot::Installed,
                Err(_) => Slot::Occupied,
            };
            (Slot::Installed, log_slot)
        }
    };
    let outcome = match (tracing_slot, log_slot) {
        (Slot::Installed, Slot::Installed) => Outcome::Full,
        (Slot::Installed, _) => Outcome::Partial,
        _ => Outcome::NotInstalled,
    };
    let status = InstallStatus { filter: config.filter.clone(), privacy: config.privacy, tracing: tracing_slot, log: log_slot, outcome };
    *state = Some(Installed { filter: config.filter, privacy: config.privacy, sink: sink.clone(), status: status.clone() });
    drop(state);
    report(&sink, &status);
    Ok(status)
}

/// One startup line. A full install goes through the installed pipeline (so the filter
/// applies, and it shows both paths work); anything else is written straight to the sink at
/// warn level, bypassing every filter.
fn report(sink: &Sink, status: &InstallStatus) {
    match status.outcome {
        Outcome::Full => {
            tracing::info!(target: "rnrs_log", filter = %status.filter, "installed: tracing subscriber and log bridge");
            log::info!(target: "rnrs_log", "log bridge ready");
        }
        Outcome::Partial | Outcome::NotInstalled => {
            let text = match status.outcome {
                Outcome::Partial => format!(
                    "partially installed: tracing events use filter {:?}, but the log facade already had a logger, so log records are not filtered or written by rnrs",
                    status.filter
                ),
                _ => "not installed: the tracing global default subscriber was already set, so rnrs's filter and platform sink do not apply (the log bridge was skipped)".to_owned(),
            };
            sink.write(Line { level: tracing::Level::WARN, target: "rnrs_log", text: &text });
        }
    }
}

/// What generated bundles call at startup: [`install`] on the platform log, reporting any
/// error to the platform log. The filter was validated when the bundle was built.
pub fn install_for_bundle(filter: &str, privacy: Privacy) {
    let sink = Sink::Platform(privacy);
    if let Err(error) = install(ManagedConfig { filter: filter.to_owned(), privacy, sink: None }) {
        sink.write(Line { level: tracing::Level::ERROR, target: "rnrs_log", text: &error.to_string() });
    }
}
