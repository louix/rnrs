# Ownership and lifecycle

The [type map](types.md) defines conversion semantics; [surface](surface.md) covers platform render resources.

## Rules

| Topic | Rule |
| --- | --- |
| Module | `counterModule()` returns the runtime's single instance. The framework tears it down with the JS runtime (reload, destroy); never tear it down yourself. |
| Native objects | Call `obj.dispose()`. GC finalization is only a fallback, and in-flight async calls hold their own reference. |
| Async | A `Promise<T>` result maps to Rust `async fn` + `CancelToken`. Cancel with `method(args…, {signal})`, which rejects with `AbortError`. Cancellation is cooperative. |
| Back-pressure | `maxInFlight` per module (default 8, set in `rustNative`), plus an executor budget of 32 on Android and iOS, shared by the modules of one binary: the app's source bundle, or each prebuilt module ([packaging](packaging.md#prebuilt-binaries)). Overflow rejects with `RnrsError` code `overloaded`. |
| Errors | `Err(String)` throws (sync) or rejects (async). Codes: `cancelled`, `overloaded`, `closed`, `failed`, `lost`. Panics abort. |
| Threads | Sync methods run on the JS thread. Async work runs on the framework's Tokio runtime (native) or as browser-local futures (web). |
| Logging | Module and library crates only emit `tracing`/`log` events and must not install a global subscriber; the app chooses ([logging](logging.md)). |

## Values and buffers

Strings, records and arrays become owned Rust values. Conversion validates runtime inputs before invoking the implementation. `ArrayBuffer` inputs always copy into `Vec<u8>`, including synchronous calls. Typed-array views are rejected. Native results transfer their allocation to JS; browser results copy into JS storage. No borrowed or mutable JS buffer API is exposed.

## Native objects

A JS wrapper owns a reference-counted native handle. Calls validate its type and runtime identity. `dispose()` releases the wrapper's ownership; in-flight operations retain the receiver until they finish. GC finalization is a nondeterministic fallback. Resource-specific `close()` methods must define their own shutdown rules; releasing a wrapper does not forcibly cancel all native work.

Implementations choose synchronization. Concurrent async calls are not automatically serialized, and Rust ownership cycles require weak references or explicit cleanup.

## Async completion and cancellation

Native execution uses the framework's Tokio runtime; browser execution uses local futures. Workers own arguments and retain receivers, with no JS runtime pointers or JS values. Results settle on the JS runtime thread.

Use `{signal}` to cancel. Cancellation is cooperative: rejection does not prove that execution stopped or side effects rolled back. Late results are discarded after cancellation or teardown. Arguments and receiver remain alive until work exits. Dropping a Promise does not cancel it. Admission is bounded by the executor budget, including work surviving a runtime reload.

**Dropped drain tasks (React Native 0.88).** When any `RuntimeScheduler` task throws, RN 0.88 clears all queued tasks and reports a fatal error to the JS global handler. If the app's handler swallows that error and keeps running, a result-delivery task queued at that moment is lost. The framework detects this ([RnrsDelivery.h](../packages/runtime/cpp/RnrsDelivery.h)) and posts the delivery again with backoff (250 ms to 4 s), so pending results still settle. A delivery that is merely waiting for a busy JS thread is never posted twice. `lifecycle().drainsDropped` counts detected drops. The browser is unaffected.

## Runtime teardown and reload

Modules are scoped to a JS runtime and created on first use. Wrappers and completions cannot cross runtime identities. Teardown stops admission, signals cancellation and invalidates completion dispatch; remaining native work drains independently without touching the old runtime.

Android and iOS use the framework runtime module's invalidation hook. Backgrounding alone is not runtime teardown. The shared scope serializes installation and invalidation, refuses adapters after closure and uses GC only as a fallback. See [iOS lifecycle](ios.md#runtime-lifecycle).

Browser backend replacement retires the old adapters and module cache. Retained wrappers stay closed. Unmount the application before replacing its backend and recreate application-owned renderer state afterwards.
