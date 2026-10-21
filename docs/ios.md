# iOS integration

iOS uses the same runtime as Android: the shared JSI adapter and runtime scope, the Rust C ABI in
`rnrs-android` (which, despite its name, has no Android code), the framework's Tokio runtime and
the executor budget. Module authors write only a TypeScript spec and Rust. App setup is in
[setup](setup.md#ios).

## Build integration

- **Autolinking.** `use_native_modules!` adds the `RnrsRuntime` pod from `@rnrs/runtime`. The app's project files are not edited.
- **Bundle.** The pod's script phase runs `rnrs build --target ios` before the pod compiles. It builds one Rust static library per architecture and combines them into `<app>/.rnrs/ios/lib/<sdk>/librnrs_bundle.a`, which the app target links through the pod's `user_target_xcconfig`.

  | SDK | Architecture | Rust target |
  | --- | --- | --- |
  | `iphoneos` | `arm64` | `aarch64-apple-ios` |
  | `iphonesimulator` | `arm64` | `aarch64-apple-ios-sim` |
  | `iphonesimulator` | `x86_64` | `x86_64-apple-ios` (built, never run) |

- **Cargo environment.** Cargo does not inherit the Xcode script phase environment: `rnrs` passes an allowlisted environment and removes Xcode toolchain directories from `PATH`, so build scripts compile for the macOS host and the `cc` crate picks each target's SDK through `xcrun`. `IPHONEOS_DEPLOYMENT_TARGET` comes from Xcode (15.1 if unset).
- **Tools.** Like React Native's own phases, the script phase sources `ios/.xcode.env` and `ios/.xcode.env.local`, which can set `NODE_BINARY`, `PATH` or `RNRS_CARGO`. Lines that read unset variables do not abort the build. A build started from a shell inherits that shell's `PATH`.
- **Lock file.** `<app>/rnrs-ios.Cargo.lock` is independent of the Android and web locks ([lock files](packaging.md#lock-files)). Set `RNRS_LOCKED=1` in the Xcode environment for CI.
- **App data directory.** `rnrs::core::platform::app_data_dir()` is `<Application Support>/rnrs`. The framework sets the path before any module exists and creates nothing; a module creates the directory on first use.
- **Test hooks.** `invalidateForTesting`, `forceBytesCopyOutForTesting`, `collectGarbageForTesting` and `reloadForTesting` are compiled only when `pod install` runs with `RNRS_TEST_HOOKS=1` (Android: Gradle property `rnrs.testHooks=true`). They, `@rnrs/runtime/testing` and the `bindingsInstalled` diagnostic are not production API.

## Runtime lifecycle

The `RnrsRuntime` TurboModule installs the bindings through `RCTTurboModuleWithJSIBindings`, and
its `-invalidate` tears down every adapter of that runtime. On reload, React Native creates the next
runtime immediately and only enqueues the old one's invalidation on the old JS thread. The hook then
runs on the TurboModule manager's queue while the old JS thread waits for it, before the old runtime
is destroyed. Consequences:

- The old and new runtimes briefly coexist. Process-wide state (executor budget, Tokio runtime) sees both.
- Work queued on the old JS thread before invalidation still runs in the old runtime; later deliveries are discarded.
- Hermes finalizers and Rust-owned `ArrayBuffer` releases run on the old JS thread. Every release is a thread-safe Rust drop.

## Limits

- Release builds, arm64 only. Physical-device testing used one iPhone; React Native 0.88.0 has run on the simulator only.
- `use_frameworks!` (static or dynamic) and Swift Package Manager are not supported.
- Only the template's single-scene `SceneDelegate` setup is tested; multiple scenes (iPad multi-window) are not.
- `reloadForTesting` reloads every `RCTHost` in the process, not only the caller's.
- The framework does not set signing, the bundle identifier, or Info.plist permission strings that a module's Rust code may need (for example `NSLocalNetworkUsageDescription`, see [http](../packages/http/README.md#ios)).
- The native backend crate keeps the name `rnrs-android` so existing lock files stay valid.
