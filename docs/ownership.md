# Ownership and lifecycle

The [generator](generator.md) defines conversion semantics; [surface](surface.md) covers platform render resources.

## Values and buffers

Strings, records and arrays become owned Rust values. Conversion validates runtime inputs before invoking the implementation. `ArrayBuffer` inputs always copy into `Vec<u8>`, including synchronous calls. Typed-array views are rejected. Native results transfer their allocation to JS; browser results copy into JS storage. No borrowed or mutable JS buffer API is exposed.

## Native objects

A JS wrapper owns a reference-counted native handle. Calls validate its type and runtime identity. `dispose()` releases the wrapper's ownership; in-flight operations retain the receiver until they finish. GC finalization is a nondeterministic fallback. Resource-specific `close()` methods must define their own shutdown rules; releasing a wrapper does not forcibly cancel all native work.

Implementations choose synchronization. Concurrent async calls are not automatically serialized, and Rust ownership cycles require weak references or explicit cleanup.

## Async completion and cancellation

Native execution uses the framework's Tokio runtime; browser execution uses local futures. Workers own arguments and retain receivers, with no JS runtime pointers or JS values. Results settle on the JS runtime thread.

Use `{signal}` to cancel. Cancellation is cooperative: rejection does not prove that execution stopped or side effects rolled back. Late results are discarded after cancellation or teardown. Arguments and receiver remain alive until work exits. Dropping a Promise does not cancel it. Admission is bounded by the executor budget, including work surviving a runtime reload.

## Runtime teardown and reload

Modules are scoped to a JS runtime and created on first use. Wrappers and completions cannot cross runtime identities. Teardown stops admission, signals cancellation and invalidates completion dispatch; remaining native work drains independently without touching the old runtime.

Android and iOS use the framework runtime module's invalidation hook. Backgrounding alone is not runtime teardown. The shared scope serializes installation and invalidation, refuses adapters after closure and uses GC only as a fallback. See [iOS lifecycle](ios.md#runtime-lifecycle-on-ios-react-native-0831-bridgeless).

Browser backend replacement retires the old adapters and module cache. Retained wrappers stay closed. Unmount the application before replacing its backend and recreate application-owned renderer state afterwards.

## Validation

Run `cargo test -p rnr-core`, `scripts/test-native.sh`, and the consumer suites in [lab](lab.md). Tests cover disposal, cancellation, late completion and runtime identity; foreign platform lifecycle assumptions still require device validation.
