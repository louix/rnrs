# Platform support

rnrs modules run on Android, iOS and in the browser. Each module declares its targets;
its Rust dependencies must also support those targets.

| Platform | Integration |
| --- | --- |
| React Native | React Native 0.88.x with the New Architecture and Hermes. |
| Android | Gradle links prebuilt modules for the app's selected ABIs. |
| iOS | CocoaPods autolinking for device and simulator builds. See [iOS integration](ios.md). |
| Browser | WebAssembly, initialized with `initRnrs` on the main thread. See [setup](setup.md#web-vite). |
| Expo | SDK 58 with prebuild and a development or release build. Expo Go cannot load custom native modules. |

Apps consuming prebuilts need no Rust toolchain. See [setup](setup.md). Browser bindings target
browser apps, not Node.js, workers or WASI.

## Rendering and Worklets

[Rendering surfaces](surface.md) have Android, iOS and browser backends.
See each renderer’s README for its requirements.

On Android and iOS, modules can opt in to Worklets / Reanimated endpoints for allow-listed
synchronous scalar methods on boxed native objects
([runtime API](../packages/runtime/src/worklets.ts), [example](../fixtures/worklets-lab)).

- Methods execute on the calling runtime's thread: keep them short and non-blocking.
- Async methods, strings, records and arrays use the regular module API instead.
- Catch `ERR_RNRS_CLOSED` when calls can race teardown; `$open` is advisory, not a guarantee
  that the next call will succeed.
