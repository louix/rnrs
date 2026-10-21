# Rust logging

Libraries emit standard [`tracing`](https://docs.rs/tracing) events or [`log`](https://docs.rs/log) records. The app decides, once, where they go: the platform log through `rnrs-log` (`rust/rnrs-log`, packaged in `@rnrs/runtime`). Nothing is logged unless the app opts in.

## Who does what

| Party | Does |
| --- | --- |
| Library and module crates | `tracing::info!(...)`, `log::warn!(...)` and so on. Never install a global subscriber or logger: that is the app's choice (managed mode, or the app's own setup code in external mode), and with `panic = "abort"` a library calling `tracing_subscriber::fmt::init()` after the app's install aborts the process. |
| App (`package.json`) | `rustNativeApp.logging`: absent (default, off), managed, or external. No native code. |
| Framework | Managed mode: installs the subscriber and the `log` bridge at bundle startup. `rnrs-log` also offers its pieces to app-owned subscribers. |

```json
{
  "rustNativeApp": {
    "logging": {"filter": "info,sled=warn", "iosPrivacy": "private"}
  }
}
```

| `rustNativeApp.logging` | Result |
| --- | --- |
| absent | Off. `rnrs-log` is not linked; generated bundles are unchanged. |
| `{}`, `{"filter": ...}`, `{"mode": "managed", ...}` | Managed. `filter` defaults to `info`; `iosPrivacy` is `"private"` (default) or `"public"`. |
| `{"mode": "external"}` | `rnrs-log` is linked, nothing is installed: an app-owned Rust setup crate owns the global subscriber and can use `rnrs_log::layer`. No other keys. |

The configuration is fixed when the bundle is built. Changing it changes the bundle's dependencies, so the app's committed `rnrs-<target>.Cargo.lock` must be updated (`npx rnrs lock --target T`; the build says so).

## Filter

`tracing_subscriber::filter::Targets` directives, parsed by that crate: comma-separated `level`, `target=level` or `target`, with levels `trace`, `debug`, `info`, `warn`, `error`, `off`. A target matches itself and its `::` children. This is not `RUST_LOG`/`EnvFilter` syntax: there are no span or field filters and no regular expressions.

The filter is checked twice:

- by `rnrs`, for what can be embedded in generated source (printable ASCII, no quotes or backslashes);
- by the `Targets` parser itself, in a build script generated into the bundle crate. An invalid filter fails `rnrs build`, the Gradle task and the Xcode script phase, with the parser's error.

The same filter applies to `tracing` events and to bridged `log` records, by the record's own target (`sled=warn` filters `log` records from `sled::...`). Its maximum level also becomes `log::max_level`. Release and debug builds behave the same (bundles are always built in release); no `max_level_*` features are set.

## Managed install

Generated bundles call `rnrs_log::install_for_bundle(filter, privacy)` first in their startup function, before registering modules: `rnrs_bundle_init` on Android and iOS (called once per process, on the first module use, so it also spans React Native reloads), the Wasm `start` function on the web.

`rnrs_log::install` is serialized: the first call decides, concurrent callers wait and receive the same status. In order, each slot only if free:

1. The `tracing` global default: a `Registry` with `rnrs_log::layer` filtered by the `Targets` filter.
2. Only if step 1 succeeded: the `log` facade logger, `tracing_log::LogTracer` (one-way, `log` into `tracing`), with `log::max_level` set to the filter's maximum. `LogTracer` sets the level only after its logger was accepted.

| Result | `tracing` | `log` | Meaning |
| --- | --- | --- | --- |
| `Full` | `Installed` | `Installed` | Filter and sink apply to both `tracing` events and `log` records. |
| `Partial` | `Installed` | `Occupied` | `tracing` events are filtered and written; `log` records go to whoever owns the `log` logger; `log::max_level` is unchanged. |
| `NotInstalled` | `Occupied` | `Skipped` | Nothing installed; rnrs's filter and sink do not apply; the `log` slot and `log::max_level` are untouched. |

- A `Full` install reports itself through the installed pipeline: one `tracing` event (`rnrs_log: installed: tracing subscriber and log bridge filter=...`) and one `log` record (`rnrs_log: log bridge ready`), both subject to the filter (`rnrs_log=off` silences them).
- `Partial` and `NotInstalled` write one line straight to the platform log at warn level, bypassing all filters, naming what was occupied.
- `rnrs_log::status()` returns the `InstallStatus` (filter, privacy, both slots, outcome) to Rust code. It is not visible from JS.
- A repeated call with the same configuration returns the same status and installs nothing. A different configuration is `InstallError::ConflictingConfig`, and nothing changes.

**Scope of "global".** The slots are the globals of the `tracing` and `log` copies linked into the app's generated bundle: one native static library per app, or one Wasm instance. Another Rust library linked separately into the app (its own dynamic library or static copy) has its own globals and is not affected. Each Wasm instance has its own; see Platforms.

**Early logs.** The guarantee is: installed before registered modules are initialized. Events emitted earlier (static constructors of crates such as `ctor`, or anything before the first module use) have no subscriber and are dropped, not buffered.

**`log-always`.** With `tracing`'s `log-always` feature, every `tracing` event is also emitted as a `log` record, which the bridge would turn into a second event. For managed bundles `rnrs build` checks the resolved features per build target (`cargo metadata --filter-platform <triple>`, after resolution and before compiling) and fails, naming the package that enables it (directly, or through one of its enabled features), with external mode as the alternative. `tracing`'s plain `log` feature emits records only while no subscriber is set, which never overlaps with an installed one.

## External mode and `rnrs_log::layer`

`rnrs_log::layer(Sink)` is a `tracing_subscriber::Layer` usable in any subscriber an app owns:

```rust
use tracing_subscriber::prelude::*;
let platform = rnrs_log::layer(rnrs_log::Sink::Platform(rnrs_log::Privacy::Private))
    .with_filter("info,my_app=debug".parse::<tracing_subscriber::filter::Targets>()?);
tracing_subscriber::registry().with(platform).with(my_other_layer).init();
```

The layer does no filtering of its own: it formats and writes every event it receives, so compose it with a filter. In external mode the app's own setup decides whether to bridge `log` too. `Sink::Custom` takes any `Fn(Line)`.

## Formatting

`outer{a=1}:inner: message key=value key2="two words"`

- Scope comes from the registry, outermost first. It honours explicit parents (`parent: &span`, `parent: None`) and the current context. Span fields are those given at creation plus every `Span::record` update.
- The message comes first, then fields. String values are quoted and escaped when they are empty or contain a space, `=`, a quote, a backslash or a control character. Other values use `Debug`. `log.*` fields of bridged records are not repeated: their target and level are used directly.
- **Bounded while writing.** A line is at most 4000 bytes and a span's stored fields at most 512, cut at a character boundary and marked `…[truncated]`. Formatting stops when a buffer is full (a large `Debug` value is not fully formatted first). Disabled events are filtered before any formatting.
- NUL is written as `\0`, newline and carriage return as `\n` and `\r`, other control characters (except tab) as `\u{..}`. A line never contains NUL or a line break.
- **Re-entrancy.** User code (`Debug` implementations of fields) runs only while no span-extension lock is held: creation fields and `Span::record` updates are formatted into a bounded temporary first, then copied in. An event, span creation or `record` call made by the same thread while it formats or writes (from a sink, or from a `Debug` that logs or records) is dropped. This prevents deadlock and unbounded recursion; such nested updates are lost.
- **Thread exit.** Logging from a thread-local destructor works. If the layer's per-thread buffer has already been destroyed, a bounded buffer of its own is used, rather than panicking (which would abort).

## Platforms

| Platform | Destination | Levels |
| --- | --- | --- |
| Android | `__android_log_write`. Tag: the target's crate (`sled` for `sled::tree`), with control characters replaced, at most 23 bytes, cut at a character boundary. The full target (escaped) is prefixed to the message when longer. | trace→VERBOSE, debug→DEBUG, info→INFO, warn→WARN, error→ERROR |
| iOS (and macOS) | Unified logging through a C shim in `rnrs-log`: one `os_log_t` for the process (subsystem `rnrs`, category `rust`), so no per-target log objects are cached; `target: message`. | error→ERROR, warn→DEFAULT, info→INFO, debug/trace→DEBUG |
| Browser | `console.error/warn/info/debug` (trace→debug), `target: message`. | |
| Other (host tests) | standard error. | |

**Threads.** Android and Apple writes happen synchronously on the emitting Rust thread: any thread, including Tokio workers, with no queue and no JSI. On the web, only the main-thread Wasm instance created by `initRnrs` is supported. Every Wasm instance has its own `tracing`/`log` globals and installs from its own copy of the configuration. Workers, iframes and threaded Wasm are unsupported until separately validated.

**Message size.** Targets come from log records and can be any string. They are escaped like message text and cut to 128 bytes. The whole message handed to the platform (target prefix, text and truncation marker) is at most 4000 bytes (`rnrs_log::MAX_MESSAGE`). That bounds what rnrs produces, not what a platform keeps:
- logcat's payload limit is slightly above it;
- Apple unified logging and browser consoles may keep less;
- end-to-end retention of 4000 bytes is not promised.

**iOS privacy.** The whole line (scope, message and every field) is one argument written as `%{private}s` by default. In logs collected without developer tooling (sysdiagnose, Console without a debugging profile) it is redacted; attached debugging and developer logging profiles show it. `"iosPrivacy": "public"` writes `%{public}s`, readable by anyone who can read the device's logs. Private is redaction, not protection: a message that reaches any log should be assumed readable by a developer of the device, and Android logcat and the browser console have no redaction at all. Libraries must not log secrets. Under developer console mirroring (`OS_ACTIVITY_DT_MODE`) private lines appear in full; redaction in collected logs has not been verified.

## Not supported

- **No forwarding to the JS console.** A future option is a bounded native queue drained on the JS thread with an explicit overflow count. No JS configuration API exists either: configuration is `package.json` only.
- No stdout or stderr capture and no panic hook. Release builds abort on panic.
- The install status is not exposed to JS.
- No runtime reconfiguration.
- `log` structured key-values (the `kv` feature) are not forwarded: `tracing-log` bridges a record's message, target, level, module, file and line only.
- Logs emitted before installation (static constructors, anything before the first module use) are lost, not buffered.
- **Scoped dispatchers win.** A thread-local default dispatcher (`tracing::subscriber::with_default`, `set_default`) takes precedence over the global default for its thread and scope. Events inside it do not reach rnrs's subscriber.
- **`log-always` detection limits.** It covers the resolved features of the configured build targets only. Attribution names direct dependency declarations and the enabling features of resolved packages. Other paths are reported as not attributable, and the build still fails.
