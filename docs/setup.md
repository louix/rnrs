# Setup

Tools for authoring modules, and the per-platform steps for using a module in an app. The
[headless module](headless.md) and [triangle](triangle.md) tutorials start here.

## Tools

| Need | For |
| --- | --- |
| Node 24, npm | everything |
| rustup with Rust **1.90.0** | any Rust build (the only tested toolchain) |
| target `wasm32-unknown-unknown`, `wasm-bindgen` CLI **0.2.129** | web |
| target `aarch64-linux-android`, JDK 17, Android SDK 37 (build-tools 37.0.0), NDK 27.1.12297006, CMake 3.22.1 | Android |
| macOS, Xcode (26.6 tested), CocoaPods, targets `aarch64-apple-ios` and `aarch64-apple-ios-sim` | iOS |

Install the Rust toolchain and the targets you need (this needs the network):

```sh
rustup toolchain install 1.90.0 --profile minimal --target wasm32-unknown-unknown
#   Android: --target aarch64-linux-android      iOS: --target aarch64-apple-ios --target aarch64-apple-ios-sim
export RUSTUP_TOOLCHAIN=1.90.0      # Gradle/Xcode builds inherit it when started from this shell
```

rnrs installs nothing. If a Rust target is missing, `rnrs build` stops before compiling and prints
the `rustup target add` command; a missing web `wasm-bindgen` CLI is reported the same way.

### Nix shells

This repository's flake provides the system tools, but **not** Rust toolchains or targets:

| Shell | Host | Provides |
| --- | --- | --- |
| `nix develop "$REPO"` | x86_64 Linux | Node 24, rustup, JDK 17, Android SDK/NDK/CMake, adb |
| `nix develop "$REPO#web"` | x86_64 Linux | Node 24, rustup, wasm-bindgen, esbuild, Chromium |
| `nix develop "$REPO#host"` | x86_64 Linux | Node 24, rustup, clang, CMake: Rust and C++ tests without the Android SDK |
| `nix develop "$REPO#ios"` | macOS | Node 24, rustup, CocoaPods. Xcode comes from the system. |

- Set `REPO` to the absolute path of this checkout. Your module and apps live outside it, so `.` does not work.
- Run commands inside the shell, or pass them with `nix develop "$REPO#web" --command bash -c '…'`.
- Do not start a login shell (`bash -l`) inside it: your profile can reset `PATH` and hide the shell's `cargo`, `rustup` and `wasm-bindgen`.
- There is no Android or web shell on macOS, and no shell for aarch64 Linux. Without flakes enabled, run `nix --extra-experimental-features 'nix-command flakes' develop …`.

## Workspace and packages

Create modules and apps in their own directories, outside any other npm package, and write a
`package.json` before running `npm install`; otherwise npm installs into the nearest parent package.

| Package | Purpose |
| --- | --- |
| `@rnrs/cli` | The `rnrs` command. Scaffold with `npm exec --package=@rnrs/cli -- rnrs init`, then use `npx rnrs`. The unscoped npm package `rnrs` is unrelated. |
| `@rnrs/runtime` | Runtime, spec types, native integration and framework crates. Modules use it as a peer dependency; apps install it directly. |
| `@rnrs/surface` | Rendering surfaces; only renderer modules and their apps need it. |

`npx rnrs help` lists the commands.

### TypeScript

The tutorials type-check app code with `typescript@7.0.2`. TypeScript 7 ships no `tsserver`, so
editors need its native language-service extension. Write `react-native.config.js` rather than
`.ts`: the config loader calls `require('typescript').transpileModule`, which TypeScript 7 does not provide.

### Local framework packages

To try an unpublished framework checkout, build its package archives:

```sh
cd "$REPO"
npm ci --ignore-scripts
node scripts/pack.mjs
PACK="$REPO/.generated/pack"
```

Then, wherever a tutorial installs framework packages from the registry, install the matching
archives instead, all **in one `npm install` command** so npm does not look up a framework
dependency in the registry before its archive is installed:

```sh
npm install "$PACK/rnrs-runtime-0.2.0.tgz" "$PACK/rnrs-cli-0.2.0.tgz"   # add rnrs-surface-0.2.0.tgz for renderers
```

## Use a module in an app

Apps install `@rnrs/runtime` and the module package, for example a module archive from `npm pack`:

```sh
npm install @rnrs/runtime /absolute/path/to/demo-crc-0.1.0.tgz
```

The first build writes `rnrs-<target>.Cargo.lock` in the app root; commit it. Add `.rnrs/` to the
app's `.gitignore`. CI builds should use `rnrs build --locked`, `RNRS_LOCKED=1` or Gradle
`-Prnrs.locked=true` ([lock files](packaging.md#lock-files)).

### Web (Vite)

Build the Rust bundle into the app, then initialize it once before any module call:

```ts
import {initRnrs} from '@rnrs/runtime/web';
import * as bundle from './.rnrs/web/pkg/rnrs_bundle.js';

initRnrs(bundle).then(() => { /* call modules */ });
```

```sh
npx rnrs build --target web --app .    # needs cargo, the wasm32 target and the pinned wasm-bindgen CLI
npx vite build
```

Rebuild the bundle after installing or updating a module. `RNRS_WASM_BINDGEN` selects another
`wasm-bindgen` CLI. Modules run on the browser main thread; workers are not supported.

### Android

Use a React Native **0.88.0** app (`npx @react-native-community/cli@20.2.0 init App --version 0.88.0`).
Install the packages, then build as usual; the framework's Gradle task builds the Rust bundle:

```sh
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

- **Nix SDK:** it has only build-tools 37.0.0. Add `--init-script "$REPO/scripts/consumer/nix-sdk.init.gradle"`, which sets library modules' `buildToolsVersion` without editing the app.
- **Tools outside the shell:** the Gradle task runs `node` and `cargo`. If they are not on Gradle's `PATH` (Android Studio started from the desktop), set `NODE_BINARY` or `-Prnrs.node=/absolute/path/to/node`, and `RNRS_CARGO` with the matching `RUSTC`. Relative paths are rejected.
- **ABIs:** only arm64 is tested.
- Android Studio sync warns that the bundle is not built yet; the first Gradle build builds it.

### iOS

Use a React Native 0.88.0 app, on a Mac. The module needs `ios` in its targets.

```sh
cd ios && RCT_USE_RN_DEP=1 RCT_USE_PREBUILT_RNCORE=1 pod install
```

Build with Xcode, or `xcodebuild` from the same shell; a pod script phase builds the Rust bundle.
If Xcode cannot find node or cargo, set them in `ios/.xcode.env.local`. Cargo settings must be
exported:

```sh
export NODE_BINARY=/absolute/path/to/node
export RNRS_CARGO="$HOME/.cargo/bin/cargo"   # or: export PATH="$HOME/.cargo/bin:$PATH"
export RUSTUP_TOOLCHAIN=1.90.0
```

`use_frameworks!` is not supported. See [iOS integration](ios.md).

### Expo

Use Expo SDK 58 with prebuild and a development or release build. Expo Go cannot load custom
native code. Set `ios.bundleIdentifier` in `app.json` for a real app.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `rnrs: the generator needs the TypeScript 6 compiler API` | Reinstall `@rnrs/cli` (apps and modules) or run `npm ci` (this repository). |
| `cargo`, `rustup` or `wasm-bindgen` not found inside the Nix shell | Use a non-login shell, then install the toolchain ([tools](#tools)). |
| `npm install` changed a parent directory's `package.json` | Write the package's own `package.json` first. |
| `rnrs init: nothing was written` | It lists the conflicting files and fields. Fix them by hand, or use an empty directory. |
| `does not match its spec for this rnrs version` | Rebuild and reinstall the module archive (`npm pack` regenerates). |
| `generated from different specs` at runtime | Wrapper and glue are out of sync: reinstall matching module packages and rebuild. |
| `rnrs-<target>.Cargo.lock is missing` or stale | Run `npx rnrs lock --target T` and commit the lock. |
| Web: error mentioning `initRnrs` | Wait for `initRnrs(bundle)` before any module call. |
| `rnrs build --target web` refuses a module | The module lacks `web` in its targets. |
| `the Rust target … is not installed` | Run the printed `rustup target add …` in the shell that builds. |
| `cannot run cargo` | Install rustup and the toolchain, or set `RNRS_CARGO`. |
| `needs the wasm-bindgen CLI …` | Run the printed `cargo install wasm-bindgen-cli --version … --locked`, or use `nix develop "$REPO#web"`. |
