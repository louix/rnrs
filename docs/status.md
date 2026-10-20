# Platforms and limits (2026-10-20)

Experimental. Nothing is published to npm or crates.io, and every package is `private`. The API, IR and file layout may change.

## Platforms

| | Status | Tested on |
| --- | --- | --- |
| Android | Works | Pixel 2 XL (Android 11): full suites, and the only benchmark phone. Pixel 8a (GrapheneOS, Android 17): http/kv consumer regressions and a comparison smoke. arm64 release builds only. |
| iOS | Experimental | Core modules tested on iPhone 12 Pro (iOS 26.7.1), Xcode 26.6, arm64 release builds. Runtime lifecycle, surfaces and touch also have simulator runs; touch is not validated on a physical iPhone. |
| Web (browser Wasm) | Experimental | Headless Chromium 155 suites; Firefox 156 triangle and Bevy steady rendering observed. Bevy unmount crashes Firefox; headless software WebGPU can lose the device. No WASI, Node.js or worker threads. |
| React Native | **0.83.1 only validated** | Bridgeless, Hermes. Newer React Native or Expo baselines are not validated by these runs. |
| Expo | Not validated | Expo Go cannot work, because it needs custom native code. Prebuild and dev builds were never tried. |
| Rust | 1.90.0 default | The optional Bevy 0.20 example uses Rust 1.97.1 and requires Android API 26. See [Bevy](bevy3d.md). |
| 16 KB pages | Linked 16 KB-aligned | Only run on 4 KB-page devices; see [page-size](page-size.md). |
| Worklets / Reanimated | Experimental, Android-tested | Pixel 2 XL: Worklets 0.12.2, Reanimated 4.6.0, Gesture Handler 3.3.0. iOS shared-code builds and runtime regressions do not validate iOS Worklets; web Worklets are untested. See [endpoint limits](#worklets-limits). |
| Rendering surfaces | Experimental | Android device, iOS simulator and browser fixtures. iOS Bevy does not render on the simulator. Canvas 2D and WebGPU have distinct contracts; see [surface](surface.md) and [Bevy](bevy3d.md). |

## Worklets limits

Opt-in endpoints expose allow-listed synchronous methods with scalar values and boxed native objects. Methods run on the calling runtime thread and must be bounded and non-blocking. Async methods and general value conversions are unsupported. Worklets must catch `ERR_RNR_CLOSED` after teardown; an uncaught UI-worklet error can crash the app, and `$open` is only advisory. See [the runtime API](../packages/rnr-runtime/src/worklets.ts) and [fixture](../fixtures/worklets-lab).

## Spec types

| TypeScript | Rust | |
| --- | --- | --- |
| `number` / `boolean` / `void` | `f64` / `bool` / `()` | Always f64; there are no integer types. |
| `string` | `String` | Copied. Lone surrogates become U+FFFD. |
| `T[]` | `Vec<T>` | Copied element by element. |
| `interface R {…}` / `type R = {…}` | `struct R` | Own properties only. Unknown fields are ignored. |
| `x?: T`, `T \| null` | `Option<T>` | `x?: T \| null` is rejected. |
| Discriminated union of objects | `enum` with payloads | Discriminator is inferred, or set with `/** @discriminator f */`. |
| `ArrayBuffer` | `Vec<u8>` | Always copied in. Output is adopted on Android/iOS and copied on web. Typed-array views are rejected. |
| `interface X extends NativeObject` | trait + `Native<T>` | Persistent object, released with `dispose()`. |
| `Promise<T>` (results only) | `async fn` + `CancelToken` | Cancel with `{signal}`. |

**Rejected with a diagnostic:** `any`, `unknown`, `object`, `bigint`, callbacks, `Date`/`Map`/`Set`, `Record<string, T>`, tuples, plain string-literal unions, TS enums, generics, classes, and native objects inside records or unions. Full list: [generator](generator.md).

## Features

| | Status |
| --- | --- |
| Zero platform code for authors and apps | Yes. The clean-consumer scripts check that the app's `android/` and `ios/` trees are unchanged. |
| Committed Rust interface, per-app generated glue | Yes ([packaging](packaging.md)). |
| Per-target lock files, `--locked` for CI | Yes. |
| Rust logging to logcat / os_log / console | Yes, opt-in per app ([logging](logging.md)). No forwarding to the JS console. |
| Async runtime | Tokio, owned by the framework (native). Browser-local futures (web). There is no app-chosen or bring-your-own runtime. |
| Production use, security sandboxing, published packages | **No.** |

## Example modules

| Package | Shows | Targets |
| --- | --- | --- |
| [`counter`](../packages/counter) | native object, async, cancellation | android, ios, web |
| [`meter`](../packages/meter) | native objects as arguments and results | android, ios, web |
| [`values`](../packages/values) | strings, records, unions, buffers | android, ios, web |
| [`blake3`](../packages/blake3) | wrapping a crate, busy-gated async object | android, ios, web |
| [`http`](../packages/http) ([doc](http.md)) | reqwest; different native and web transports | android, ios, web |
| [`kv`](../packages/kv) ([doc](kv.md)) | sled, app data dir; refused on web | android, ios |
| [`fixtures/fresh-crc`](../fixtures/fresh-crc) | `rnrs init` package wrapping a crates.io crate (crc32fast), built outside the repo | android, ios, web (iOS not built for it) |
| [`fixtures/author`](../fixtures/author) | smallest out-of-repo author package | android, web |
| [`bench`](../packages/bench) | benchmark module (lab) | android, ios, web |

Consumer apps used by the scripts: [`fixtures/`](../fixtures) (`consumer`, `http-consumer`, `kv-consumer`, `ios-modules-consumer`, `log-probe-consumer`).
