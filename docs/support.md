# Platform support

| Platform | Support |
| --- | --- |
| React Native | 0.88.0, New Architecture (bridgeless), Hermes. The packages accept later 0.88 patch releases, which are not individually tested. Older versions are not supported. |
| Android | arm64 release builds. Native libraries are linked 16 KB page-aligned, but have only run on 4 KB-page devices. |
| iOS | arm64 release builds, CocoaPods, React Native's prebuilt core. React Native 0.88.0 has run on the simulator and an iPhone 12 Pro. No `use_frameworks!` or Swift Package Manager. See [iOS](ios.md). |
| Browser | Wasm on the main thread, initialized with `initRnrs`. No workers, WASI or Node.js. |
| Expo | SDK 58 with prebuild and a custom build. Expo Go cannot load custom native code. The iOS build has been run; the Android build has not. |
| Rust | 1.90.0. The Bevy example needs 1.97.1 and Android API 26 ([Bevy](../packages/bevy3d/README.md)). |
| Rendering surfaces | Android, iOS and browser WebGPU; see [surface](surface.md). iOS touch input has run on the simulator only. The Bevy example does not render on the iOS simulator. |
| Worklets / Reanimated | Android only (Worklets 0.13.0, Reanimated 4.7.1); see [limits](#worklets). iOS and web are untested. |

## Features

| Feature | Notes |
| --- | --- |
| No platform code for authors or apps | Modules are a TypeScript spec and a Rust crate; apps need no native edits. |
| Generated interface and per-app glue | [Packaging](packaging.md). |
| Per-target lock files | `--locked` for CI. |
| Rust logging | To logcat, os_log or the browser console, opt-in per app ([logging](logging.md)). No forwarding to the JS console. |
| Async runtime | Tokio owned by the framework (Android, iOS); browser-local futures (web). No app-chosen runtime. |

## Worklets

Modules can opt in to Worklets endpoints that expose allow-listed synchronous methods with scalar
values and boxed native objects ([runtime API](../packages/runtime/src/worklets.ts),
[example](../fixtures/worklets-lab)).

- Methods run on the calling runtime's thread and must be bounded and non-blocking.
- Async methods and other value conversions are not supported.
- Calls after teardown throw `ERR_RNRS_CLOSED`. Worklets must catch it: an uncaught UI-worklet error can crash the app. `$open` is only advisory.

## Example modules

| Package | Shows | Targets |
| --- | --- | --- |
| [`counter`](../packages/counter) | native object, async, cancellation | android, ios, web |
| [`meter`](../packages/meter) | native objects as arguments and results | android, ios, web |
| [`values`](../packages/values) | strings, records, unions, buffers | android, ios, web |
| [`blake3`](../packages/blake3) ([doc](../packages/blake3/README.md)) | wrapping a crate, busy-gated async object | android, ios, web |
| [`http`](../packages/http) ([doc](../packages/http/README.md)) | reqwest; different native and web transports | android, ios, web |
| [`kv`](../packages/kv) ([doc](../packages/kv/README.md)) | sled, app data directory; refused on web | android, ios |
| [`vello2d`](../packages/vello2d) | CPU-rasterized renderer on a surface | android, ios, web |
| [`bevy3d`](../packages/bevy3d) ([doc](../packages/bevy3d/README.md)) | Bevy scene on a surface | android, ios, web |
| [`fixtures/fresh-crc`](../fixtures/fresh-crc) | `rnrs init` package wrapping a crates.io crate (crc32fast) | android, ios, web (iOS not built) |
