# Ownership and lifecycle

The [generator](generator.md) defines conversion semantics; [surface](surface.md) covers platform render resources.

## Values and buffers

Strings, records and arrays become owned Rust values. Conversion validates runtime inputs before invoking the implementation. `ArrayBuffer` inputs always copy into `Vec<u8>`, including synchronous calls. Typed-array views are rejected. Native results transfer their allocation to JS; browser results copy into JS storage. No borrowed or mutable JS buffer API is exposed.

## Native objects

A JS wrapper owns a reference-counted native handle. Calls validate its type and runtime identity. `dispose()` releases the wrapper's ownership; in-flight operations retain the receiver until they finish. GC finalization is a nondeterministic fallback. Resource-specific `close()` methods must define their own shutdown rules; releasing a wrapper does not forcibly cancel all native work.

Implementations choose synchronization. Concurrent async calls are not automatically serialized, and Rust ownership cycles require weak references or explicit cleanup.

## Async completion and cancellation

Native execution uses the framework's Tokio runtime; browser execution uses local futures. Workers own arguments and retain receivers, with no JS runtime pointers or JS values. Results settle on the JS runtime thread.

**Dropped drain tasks (React Native 0.88).** RN 0.88's `RuntimeScheduler` clears all queued tasks when any task throws, then reports a fatal error to the JS global handler. The hang affects apps whose handler swallows that fatal error and keeps the runtime running. A drain task queued at that moment is destroyed unrun. The adapter detects this: the task's closure owns a guard that marks its post *dropped* when destroyed unrun ([RnrDelivery.h](../packages/rnr-runtime/cpp/RnrDelivery.h)), and the Rust host's monitor (`Host::monitor_delivery`) posts the wake again with backoff (250 ms to 4 s). A drain that is merely queued (JS busy) or running is never posted again, so at most one drain task per adapter is queued; nothing is scheduled while nothing is posted, and checks stop at teardown. Android and iOS share this code; the browser backend is unaffected. Regression: [fixtures/scheduler-probe](../fixtures/scheduler-probe/smoke.ts) (`FIXTURE=scheduler-probe MODULES=example-counter NAME=sched-app scripts/consumer/rn-app.sh`, then `NAME=sched-app scripts/consumer/rn-smoke.mjs`): after a throwing task the pending and later results settle, and a 10 s JS block leaves one queued drain and no drop. `lifecycle().drainsDropped` counts detected drops. Open: one unexplained lab failure: at commit 50edb96 one Pixel 2 XL lifecycle-suite run timed out after 120 s waiting for the background step's result (`bg-result`), with no app logs kept; its `adb reverse` ports (8766/8787, which the app reports through) were already gone at cleanup, unlike every passing run. Three reruns of the same APK and the run at 91e04b7 passed (4/5). Cause unknown, not attributed; the app and runner now log the background outcome and failed reports. Bounded batch at 46ae1e2 (lab suite, capture on): 6 complete passes, 1 incomplete run, 3 not run. Run 7 lost its reporting transport: the adb reverse mappings were gone while `adb get-state` was `device`, the device logcat stream ended 32 s in, and 3 s later the app logged that its `drained` report failed (`Network request failed`); a USB reconnect is inferred, not confirmed (no host or device adb restart). Its steps up to and including background passed; its later steps did not complete and are not counted. The 50edb96 failure's cause remains unknown; its symptom (reverse ports gone) is compatible with the same transport loss. That step settles an async result across backgrounding, so it stays open until explained.

Use `{signal}` to cancel. Cancellation is cooperative: rejection does not prove that execution stopped or side effects rolled back. Late results are discarded after cancellation or teardown. Arguments and receiver remain alive until work exits. Dropping a Promise does not cancel it. Admission is bounded by the executor budget, including work surviving a runtime reload.

## Runtime teardown and reload

Modules are scoped to a JS runtime and created on first use. Wrappers and completions cannot cross runtime identities. Teardown stops admission, signals cancellation and invalidates completion dispatch; remaining native work drains independently without touching the old runtime.

Android and iOS use the framework runtime module's invalidation hook. Backgrounding alone is not runtime teardown. The shared scope serializes installation and invalidation, refuses adapters after closure and uses GC only as a fallback. See [iOS lifecycle](ios.md#runtime-lifecycle-on-ios-react-native-0831-bridgeless).

Browser backend replacement retires the old adapters and module cache. Retained wrappers stay closed. Unmount the application before replacing its backend and recreate application-owned renderer state afterwards.

## Validation

Run `cargo test -p rnrs-core`, `scripts/test-native.sh`, and the consumer suites in [lab](lab.md). Tests cover disposal, cancellation, late completion and runtime identity; foreign platform lifecycle assumptions still require device validation.
