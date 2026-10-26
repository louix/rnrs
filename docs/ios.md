# iOS integration

Install the module package, run `pod install`, and build your app. CocoaPods autolinking links
the modules' prebuilt XCFrameworks. Modules listed in `rustNativeApp.sourceBuild` are built from
source by a pod script phase ([app builds](packaging.md#app-builds)). See [setup](setup.md#ios) for prerequisites.

## Build configuration

Source builds and `rnrs build-native --target ios` use:

| SDK | Architecture | Rust target |
| --- | --- | --- |
| Device | arm64 | `aarch64-apple-ios` |
| Simulator | arm64 | `aarch64-apple-ios-sim` |
| Simulator | x86_64 | `x86_64-apple-ios` |

- Set `NODE_BINARY`, `PATH` or `RNRS_CARGO` in `ios/.xcode.env.local` if Xcode cannot find your tools.
- For source builds, commit `rnrs-ios.Cargo.lock`; set `RNRS_LOCKED=1` for CI ([lock files](packaging.md#lock-files)).
- Use CocoaPods without `use_frameworks!`. Swift Package Manager integration is not provided.
- Configure signing and permissions in your app, including permissions needed by Rust dependencies
  ([HTTP example](../packages/http/README.md#ios)).

## Runtime behavior

`rnrs::core::platform::app_data_dir()` returns `<Application Support>/rnrs`;
create the directory before writing files.

Reload closes the old runtime's bindings and cancels pending delivery.
See [ownership](ownership.md) for native-object lifetimes.
