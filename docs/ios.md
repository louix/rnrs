# iOS backend

Experimental, 2026-10-19. iOS uses the same runtime as Android: the generic JSI adapter, the runtime scope, the Rust C ABI (`rnr-android`, which despite its name has no Android code), the binding-owned Tokio runtime and the executor budget. Only the lifecycle module and the build integration are iOS-specific. Module authors still write only a TypeScript spec and Rust.

## Layout

| Path | Role |
| --- | --- |
| `packages/rnr-runtime/cpp/` | Shared framework C++ for Android and iOS: `RnrJsi.cpp` (JSI adapter), `RnrScope.cpp` (runtime scope), `RnrBindings.cpp` (`globalThis.__rnrRuntime`), `RnrPlatform.cpp` (thread ids and names, logging: logcat, os_log or stderr). Moved from `android/src/main/jni/` unchanged apart from the platform calls. |
| `packages/rnr-runtime/ios/RnrRuntimeModule.mm` | The `RnrRuntime` TurboModule: `RCTTurboModuleWithJSIBindings` installs the bindings, `RCTInvalidating` invalidates the scope. Framework code; no module-specific code. |
| `packages/rnr-runtime/RnrRuntime.podspec` | Autolinked pod: the sources above, `install_modules_dependencies`, the bundle script phase, and the app-target link flag for the bundle. |
| `packages/rnr-runtime/ios/build-rust-bundle.sh` | Script phase: `rnrs build --target ios --sdk $PLATFORM_NAME --arch $ARCHS`. |
| `packages/rnr-runtime/src/jsi-backend.ts` | The JS backend, shared by Android and iOS (was `android-backend.ts`). |
| `scripts/consumer/ios-app.sh`, `scripts/consumer/ios-device-test.mjs`, `fixtures/consumer/ios/` | Clean consumer build and the device test. |

## Build integration

- **Autolinking.** `react-native.config.js` no longer disables iOS. `use_native_modules!` adds the `RnrRuntime` pod from the package root. The codegen config maps `RnrRuntime` to `RnrRuntimeModule` (`ios.modulesProvider`), and the class also uses `RCT_EXPORT_MODULE(RnrRuntime)`.
- **Bundle.** The pod's script phase runs before the pod compiles. `rnrs build --target ios` generates the same per-app crate as Android (a `staticlib` over `rnr-android` and `rnr-core` with Tokio). It builds one triple per architecture and combines them with `lipo` into `<app>/.rnr/ios/lib/<sdk>/librnr_bundle.a`:

  | SDK | Architecture | Triple |
  | --- | --- | --- |
  | `iphoneos` | `arm64` | `aarch64-apple-ios` |
  | `iphonesimulator` | `arm64` | `aarch64-apple-ios-sim` |
  | `iphonesimulator` | `x86_64` | `x86_64-apple-ios` |

  The app target links that file through the pod's `user_target_xcconfig` (`OTHER_LDFLAGS`). The app's project files are not edited.
- **Cargo environment.** Build scripts are compiled for the macOS host, so cargo must not inherit the Xcode script phase environment (see [findings](#build-integration)). `rnrs` passes an allowlisted environment and drops Xcode toolchain directories from `PATH`. Cargo and the `cc` crate then pick each target's SDK through `xcrun`. `IPHONEOS_DEPLOYMENT_TARGET` comes from Xcode (15.1, React Native's minimum, if unset).
- **Tools.** The script phase needs node and cargo with the iOS targets. Like React Native's own phases, it sources `ios/.xcode.env` and `.xcode.env.local`, which set `NODE_BINARY` and can set `PATH` or `RNR_CARGO`. It sources them as React Native's `with-environment.sh` does, without `-e`/`-u`, so lines that read unset variables (`$NVM_BIN`) or run a missing optional `nvm.sh` do not abort the build; strict mode is restored afterwards, and no usable node is an actionable error (`scripts/ios-env.test.mjs`). A build started from a shell (`xcodebuild`) inherits that shell's `PATH`.
- **Test hooks.** The native test hooks (`invalidateForTesting`, `forceBytesCopyOutForTesting`, `collectGarbageForTesting`, and iOS `reloadForTesting`) are compiled only with `RNR_TEST_HOOKS`: `RNR_TEST_HOOKS=1` in the environment of `pod install` on iOS, Gradle property `rnr.testHooks=true` (or `RNR_TEST_HOOKS=1`) on Android. The default package omits them, and `__rnrRuntime.testHooks` says which build is running. The iOS device test enables them (`ios-app.sh`), and so does the lab (`android/gradle.properties`). The Android clean consumer builds the default and checks that its `librnr.so` contains none of them.
- **Not supported: `use_frameworks!`.** Builds with `USE_FRAMEWORKS=static` or `dynamic` were not tested, and the bundle's link flag and static-library linking are only known to work for the template's default static-library pods. Treat frameworks linkage as unsupported until it is tested.
- **App data directory.** As on Android (`<filesDir>/rnr`), the lifecycle module sets `rnr_core::platform::app_data_dir()` before any module exists: `<Application Support>/rnr` from `NSSearchPathForDirectoriesInDomains`. It sets the path only and creates nothing; a module that needs the directory creates it on first use and gets any error then, and the runtime starts regardless. `@rnrs/example-kv` uses it on the device: its databases live in `<Application Support>/rnr/kv/<name>` ([below](#reproduce)).
- **Lock.** `<app>/rnr-ios.Cargo.lock` is independent of the Android and web locks and follows the same rules ([packaging](packaging.md#lock-files)). `RNR_LOCKED=1` in the Xcode environment is the CI switch.
- **Tooling on a Mac.** `nix develop .#ios` (flake `devShells.<darwin>.ios`) provides Node 24, rustup and CocoaPods from the flake's pinned nixpkgs. Xcode is the system's selected Xcode, because nixpkgs does not package it. The scripts keep `RUSTUP_HOME` and `CARGO_HOME` under `.generated/`.

## Runtime lifecycle on iOS (React Native 0.83.1, bridgeless)

Paths are under `node_modules/react-native/` (tarball sha256 `c3b8a175…355ade`).

### Hooks used

- **Install.** The first `TurboModuleRegistry.get('RnrRuntime')` makes `RCTTurboModuleManager` create the module. On the JS thread it calls `installJSIBindingsWithRuntime:callInvoker:` with that runtime and its `RuntimeSchedulerCallInvoker` (`ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm:424-429`; the invoker is created in `ReactCommon/react/runtime/platform/ios/ReactCommon/RCTInstance.mm:331`). The module passes its runtime scope to the shared installer, as on Android.
- **Invalidate.** `RnrRuntimeModule -invalidate` calls `RuntimeScope::invalidate`, which refuses later registrations and tears down every live adapter. It touches no JSI.

The module holds its scope in a `shared_ptr` under a mutex. `-invalidate` takes it out. The installer copies it first, so an installer that runs after invalidation installs nothing, and adapters created through an earlier installer are refused by the invalidated scope. Correctness does not depend on React Native's order.

### Destruction ordering from source

1. A reload (`RCTTriggerReloadCommandListeners`, so `RCTHost -didReceiveReloadCommand`) or `-[RCTHost reload]` calls `_reloadWithShouldRestartSurfaces:` (`RCTHost.mm:457-459`). It invalidates the old `RCTInstance` and creates the new one at once. `RCTHost -dealloc` also invalidates (`RCTHost.mm:320-322`). The old and new runtimes briefly coexist on different JS threads, each with its own scope.
2. `RCTInstance -invalidate` (`RCTInstance.mm:218-247`) sets `_valid = NO`, suspends the surface presenter, and **enqueues** a block on the JS thread (`dispatchToJSThread:`). That block:
   - runs `RCTTurboModuleManager -invalidate`;
   - then destroys the `ReactInstance`: members in reverse order (`ReactCommon/react/runtime/ReactInstance.h:69-75`), so the `RuntimeScheduler` with its queued tasks before the runtime;
   - then releases the JS thread manager, whose `dealloc` quits the JS run loop (`RCTJSThreadManager.mm:52-57`).
3. `RCTTurboModuleManager -invalidate` (`RCTTurboModuleManager.mm:1053-1129`) blocks new module creation (`_invalidating`). It dispatches each module's `-invalidate` to that module's method queue (directly if the queue is the JS thread), and waits on a dispatch group with a **10 s timeout**, blocking the JS thread. `RnrRuntimeModule` declares no `methodQueue`, so it gets the manager's shared serial queue `com.meta.react.turbomodulemanager.queue` (`RCTTurboModuleManager.mm:238`, `742-755`).
4. Work posted to the JS thread through the runtime executor holds a `weak_ptr` to the runtime and skips itself once the runtime is gone (`ReactInstance.cpp:64-97`).

So on iOS the hook runs:

- **on the TurboModule manager's queue, while the JS thread is blocked** waiting for it inside the invalidation block. JS is not running, but the JS thread is alive, unlike Android, where it has been joined.
- before the runtime scheduler and the runtime are destroyed;
- after every task that was already queued on the JS thread before the invalidation block. Those tasks run in the old, still-valid runtime. Drains posted after the block are discarded with the scheduler or skipped by the executor's `weak_ptr` check, and the adapter's own run-time check also refuses them.
- **after the next runtime has started.** The new `RCTInstance` is created right after the old one's invalidation is enqueued, so if the old JS thread is busy, the new runtime runs JS (and admits work against the same process-wide executor budget) before the old scope is invalidated. Each runtime has its own scope; process-wide state (budget, Tokio runtime, lifecycle counters) sees both.

Runtime destruction, and therefore Hermes finalization of host functions, `NativeState` and Rust-owned `ArrayBuffer` storage, happens on the old JS thread on iOS (on Android, on a background thread). Both are allowed: every release is a thread-safe Rust drop. On the device, 1 of 223 `NativeState` finalizers and 1 Rust-owned `ArrayBuffer` release ran off the thread that created them.

The 10 s timeout does not affect correctness: invalidation only takes the host lock and never waits for work. If the hook were skipped, the adapter destructor would still tear down during runtime destruction, but without the ordering above.

### Not exercised

Backgrounding, `UIScene` disconnection, `RCTHost` deallocation (it invalidates through the same `RCTInstance -invalidate`, but the template app never releases its host), process death, and debug builds with Metro. iOS has no app-level equivalent of the Android lab's `ReactHost.destroy()` check.

## Limits

- One device, one iOS version, one Xcode, one React Native version. Arm64 device only. Simulator slices (`aarch64-apple-ios-sim`, `x86_64-apple-ios`) are built but not run.
- Release builds only. Reload is driven by the `reloadForTesting` test hook, because release builds have no JS-reachable reload. It calls React Native's `RCTTriggerReloadCommandListeners`, which is process-wide: it reloads every registered `RCTHost` in the process, not only the caller's. The test app has one.
- `rnr-android`, the shared native backend crate, keeps its historical name so that existing Android lock files stay valid.
- App setup the framework does not do: signing identity and bundle id (passed to `xcodebuild` here), and Info.plist permission strings if a module's Rust code uses platform APIs that require them (none of the tested modules do).
- Test hooks, not production API: the native hooks above (compiled only with `RNR_TEST_HOOKS`), `@rnrs/runtime/testing`, and the `bindingsInstalled` diagnostic.

## Forward compatibility (not tested)

- The installer is the bridgeless TurboModule API, `RCTTurboModuleWithJSIBindings` (`installJSIBindingsWithRuntime:callInvoker:`) called by `RCTTurboModuleManager`. No `RCTCxxBridge` or other legacy-bridge API is used.
- The glue is Objective-C++, not Swift. Swift's opt-in main-actor-by-default isolation therefore does not apply. If Swift glue is ever added, invalidation must stay explicitly nonisolated and thread-safe: React Native calls it on the TurboModule manager's queue, not the main thread.
- Newer React Native versions document `UIScene`/`SceneDelegate` app integration and experimental Swift Package Manager support. The 0.88 template uses a `SceneDelegate`; surface attach/detach under it is not yet re-tested. Swift Package Manager is unsupported: the pod is CocoaPods-only, for React Native 0.88.0.

## Reproduce

```sh
# on the Mac, in this repository
nix develop .#ios
RNR_IOS_DEVICE=<UDID> RNR_IOS_TEAM=<team id> RNR_IOS_BUNDLE_ID=<unique id> bash scripts/consumer/ios-app.sh
node scripts/consumer/ios-device-test.mjs --device <devicectl id> --bundle-id <unique id> results/rnr-ios/device.json
# http and kv (allow Local Network access on the phone on first launch; then rerun)
RNR_IOS_FIXTURE=modules RNR_IOS_LOCAL_NETWORK_USAGE="Reaches the test servers on the developer Mac." RNR_IOS_OUT=$PWD/.generated/consumer-ios-modules \
  RNR_IOS_DEVICE=<UDID> RNR_IOS_TEAM=<team id> RNR_IOS_BUNDLE_ID=<unique id> bash scripts/consumer/ios-app.sh
node scripts/consumer/ios-modules-test.mjs --device <devicectl id> --bundle-id <unique id> --keep results/rnr-ios-modules/run.json
```

The runner installs the app, launches it with `OS_ACTIVITY_DT_MODE` so os_log (where release builds forward `console.error`) reaches the captured console, checks the reports, and uninstalls the app unless `--keep` is given. The phone must stay unlocked during the run.
