# Quickstart: a Rust module from a TypeScript spec

You write a TypeScript spec and Rust, and nothing else: no Swift, Kotlin, C++ or JSI. Everything here is experimental and unpublished. Packages exist only as local tarballs, and React Native 0.88.0 is the only targeted version (validation in progress; see [status](status.md)). Read [status](status.md) first.

How each step was checked:

| Mark | Meaning |
| --- | --- |
| ✅ | Run on Linux. Step 1: verbatim on 2026-10-19. Steps 2–4 (web, Android): on 2026-10-20 by `scripts/consumer/fresh-author.sh`, which runs these commands with the app files of [`fixtures/fresh-crc`](../fixtures/fresh-crc) and runs the result in headless Chromium and on a Pixel 2 XL. |
| 🔁 | Same commands as a repo script whose recorded run passed (`scripts/consumer/*`, see [packaging](packaging.md#clean-consumers)). Not rerun for this guide. |
| ⚠ | Written from the code. Never executed as shown. |

## 0. Tools

| Need | For |
| --- | --- |
| Node 24, npm | everything |
| rustup with Rust **1.90.0** | any Rust build (the only tested toolchain) |
| target `wasm32-unknown-unknown`, `wasm-bindgen` CLI **0.2.129** | web |
| target `aarch64-linux-android`, JDK 17, Android SDK 37 (build-tools 37.0.0), NDK 27.1.12297006, CMake 3.22.1 | Android |
| macOS, Xcode (26.6 tested), CocoaPods, targets `aarch64-apple-ios` and `aarch64-apple-ios-sim` | iOS |

The repo's flake shells provide the system tools, but **not** Rust toolchains or targets:

| Shell | Host | Provides |
| --- | --- | --- |
| `nix develop "$REPO"` | x86_64 Linux | Node 24, rustup, JDK 17, Android SDK/NDK/CMake, adb |
| `nix develop "$REPO#web"` | x86_64 Linux | Node 24, rustup, wasm-bindgen, esbuild, Chromium |
| `nix develop "$REPO#ios"` | macOS | Node 24, rustup, CocoaPods. Xcode comes from the system. |

`$REPO` is the absolute path of this checkout (`REPO=/absolute/path/to/this/checkout`, as in step 1). Use the absolute path: `.` only works from the repo root, and the module and apps live outside it. Run every command inside that shell, or pass it as `nix develop "$REPO#web" --command bash -c '…'`. Do not start a login shell (`bash -l`) inside it: your profile can reset `PATH` and hide the shell's `cargo`, `rustup` and `wasm-bindgen`. Check with `command -v cargo wasm-bindgen` and `rustup toolchain list`.

There is no Android or web shell on macOS, and no shell for aarch64 Linux. If Nix doesn't have flakes enabled, run `nix --extra-experimental-features 'nix-command flakes' develop …` ⚠. Without Nix, install the table's versions yourself ⚠.

Then install the toolchain with rustup. This needs the network:

```sh
rustup toolchain install 1.90.0 --profile minimal --target wasm32-unknown-unknown
#   Android: --target aarch64-linux-android      iOS: --target aarch64-apple-ios --target aarch64-apple-ios-sim
export RUSTUP_TOOLCHAIN=1.90.0      # Gradle/Xcode builds inherit it when started from this shell
```

rnrs installs nothing. If a Rust target is missing, `rnrs build` stops before compiling and prints the `rustup target add` command. rustup itself reports a missing toolchain.

The repo scripts instead `source scripts/rust-env.sh` from the repo root. It only exports `RUSTUP_HOME`, `CARGO_HOME` (both under `.generated/`) and `RUSTUP_TOOLCHAIN`. It installs nothing; `build-android.sh` and `build-web.sh` do the installing.

## 1. Pack the framework

```sh
REPO=/absolute/path/to/this/checkout
PACK="$REPO/.generated/pack"
WORK=/absolute/path/to/a/scratch/dir           # outside the repo
cd "$REPO" && npm ci --ignore-scripts && node scripts/pack.mjs   # ✅ writes $PACK/*.tgz
```

The framework is two packages, released together at the same version:

| Package | Who depends on it | Contents |
| --- | --- | --- |
| `@rnrs/runtime` | apps (dependency), module packages (peer and dev dependency) | JS runtime, Android/iOS native library, browser backend, the spec types (`@rnrs/runtime/spec`), the framework Rust crates |
| `@rnrs/cli` | module packages (dev dependency); `@rnrs/runtime` (dependency, for its native build hooks) | the `rnrs` command: `init`, `generate`, `check`, `test`, `pack-js`, `build`, `bundle`, `lock` |

Nothing is published. Once the packages are on npm, a one-off `npm exec --package=@rnrs/cli -- rnrs init` scaffolds a module without installing anything (npm also fetches the CLI's peer `@rnrs/runtime`). `npx rnrs …` is meant for a project where `@rnrs/cli` is installed: without one, npx would look up an unscoped `rnrs` package on the registry, which is not this CLI. Below, the local tarballs stand in for the registry.

## 2. Create the module ✅

Start in an empty directory outside any other npm package. Write a minimal `package.json` first; without one, npm installs into the nearest parent package.

```sh
mkdir -p "$WORK/crc" && cd "$WORK/crc"
echo '{"name": "@demo/crc", "private": true}' > package.json
npm exec --package="$PACK/rnrs-cli-0.1.0.tgz" --package="$PACK/rnrs-runtime-0.1.0.tgz" -- rnrs init
#   or: … -- rnrs init --targets android,web
#   published: npm exec --package=@rnrs/cli -- rnrs init
npm install --save-dev "$PACK/rnrs-cli-0.1.0.tgz" "$PACK/rnrs-runtime-0.1.0.tgz"
#   published: npm install    (installs the devDependencies init wrote)
```

`rnrs init` writes these files and never installs anything (npm exec itself fetches the CLI):

| File | Contents |
| --- | --- |
| `package.json` | Adds `rustNative`, `files`, `main`/`types`/`react-native`/`browser`/`exports`, a `prepack` and a `test` script (both run `rnrs`), a peer dependency on `@rnrs/runtime`, and dev dependencies on `@rnrs/cli` and `@rnrs/runtime` (same version). Fields that are already there must match, except `version`, `private`, an existing `test` script and existing `@rnrs/*` ranges, which are kept. |
| `crc.spec.ts` | A spec with one example method. The name comes from the package name: interface `CrcModule`, JS `crcModule()`. |
| `rust/Cargo.toml`, `rust/src/lib.rs` | Crate `demo-crc` (`--crate` to change it), whose `Module` implements the trait generated from the spec. |
| `.gitignore` | `node_modules/`, `*.tgz`, and generated output: `rnr/`, `.rnr/`, `rust/src/rnr_interface.rs`, `rust/target/`, `rust/Cargo.lock`. Missing lines are appended to an existing file. |

- **No overwrites:** `rnrs init` refuses before writing anything if a file already exists with other content, or if `package.json` already has a different value for a field it needs (for example a `main` from `npm init`). Fix the listed fields by hand, or start again in an empty directory.
- **Targets:** `rustNative.targets` defaults to `android`, `ios` and `web`. It records which platforms you support. rnrs does not detect targets, and it does not check that your Rust dependencies build for them. If a dependency can't run in the browser, use `--targets android,ios`. Apps then can't bundle the module for web, and its web entry throws a clear error.

Then write the module. This example wraps the [`crc32fast`](https://crates.io/crates/crc32fast) crate ([`fixtures/fresh-crc`](../fixtures/fresh-crc)).

`crc.spec.ts`:

```ts
import type {NativeModule} from '@rnrs/runtime/spec';

export interface CrcModule extends NativeModule {
  crc32(data: ArrayBuffer): number;
  crc32Hex(text: string): string;
}
```

`rust/Cargo.toml`: add the dependency under `[dependencies]`, next to `rnr-core`:

```toml
crc32fast = "1"
```

`rust/src/lib.rs`, implementing the generated trait (names are snake_case in Rust):

```rust
pub mod rnr_interface;

#[derive(Default)]
pub struct Module;

impl rnr_interface::CrcModule for Module {
    fn crc32(&self, data: Vec<u8>) -> Result<f64, String> {
        Ok(crc32fast::hash(&data) as f64)
    }
    fn crc32_hex(&self, text: String) -> Result<String, String> {
        Ok(format!("{:08x}", crc32fast::hash(text.as_bytes())))
    }
}
```

- **Generated trait:** run `npx rnrs generate` after you edit the spec, and read `rust/src/rnr_interface.rs` for the exact signatures. Supported types are listed in [status](status.md#spec-types); the full rules are in [generator](generator.md).
- **`rnr-core`:** not on crates.io. `rnrs test` and app builds resolve it to the copy inside `@rnrs/runtime`.
- **The spec import:** `@rnrs/runtime/spec` also resolves in editors and `tsc` with `moduleResolution` `bundler` or `nodenext`.

## 3. Test and pack ✅

```sh
npx rnrs test          # generates the interface, then cargo test
npx rnrs check         # interface current, package.json usable by apps (writes nothing)
npm pack              # prepack runs rnrs generate + rnrs pack-js → demo-crc-0.1.0.tgz
```

- **Generated files:** `rust/src/rnr_interface.rs` and `rnr/{index,web}.ts` are ignored by git, regenerated by `rnrs test` and `npm pack`, and included in the tarball. If you prefer to commit the interface, remove its `.gitignore` line and run `rnrs check` in CI.
- **`rnrs test`:** builds into `.rnr/target` unless `CARGO_TARGET_DIR` is set, and exits with cargo's status. Arguments after the directory go to `cargo test`, so a test-name filter needs the directory first: `npx rnrs test . greets`, or `npx rnrs test . -- --nocapture`.
- **CI:** on a fresh clone the ignored interface does not exist yet. Run `npx rnrs test` (or `npx rnrs generate`) before `npx rnrs check`; otherwise `check` reports `interface not generated`.
- **`rnrs check` and `pack-js`:** they also check `package.json` against what apps need.
  - React Native must resolve the package directly to `rnr/index.ts` (through `exports`, else `react-native`, `browser`, `main`, as Metro does). With a web target, web bundlers must resolve it to `rnr/web.ts` or `rnr/index.ts`. Your own entry module that re-exports the wrapper is not supported.
  - `npm pack` must include the spec, the crate and the wrapper. This is checked with `npm pack --dry-run --ignore-scripts` in a scratch copy, so npm's own `files` and ignore rules apply. If npm cannot run, the check is skipped with a warning.

## 4. Use it in an app

Apps depend on `@rnrs/runtime` and the module; `@rnrs/runtime` brings `@rnrs/cli` along for its Gradle task and Xcode script phase. The commands below also install the `@rnrs/cli` tarball only because nothing is published: npm would otherwise look up `@rnrs/runtime`'s dependency on the registry.

In JS, with no other setup on Android or iOS:

```ts
import {crcModule} from '@demo/crc';
const sum = crcModule().crc32(new Uint8Array([1, 2]).buffer);   // pass an ArrayBuffer, not a view
```

The first build writes `rnr-<target>.Cargo.lock` in the app root; commit it. The generated `.rnr/` directory should be git-ignored.

### Web (Vite) ✅ `nix develop "$REPO#web"`

```sh
mkdir -p "$WORK/web-app" && cd "$WORK/web-app"
echo '{"name": "web-app", "private": true, "type": "module", "devDependencies": {"vite": "6.4.4"}}' > package.json
echo '<!doctype html><script type="module" src="./main.ts"></script>' > index.html
cat > main.ts <<'TS'
import {initRnr} from '@rnrs/runtime/web';
import * as bundle from './.rnr/web/pkg/rnr_bundle.js';
import {crcModule} from '@demo/crc';
initRnr(bundle)          // once, before any module call (no top-level await: Vite's default target)
  .then(() => console.log(crcModule().crc32Hex('123456789')));   // cbf43926
TS
npm install "$PACK/rnrs-cli-0.1.0.tgz" "$PACK/rnrs-runtime-0.1.0.tgz" "$WORK/crc/demo-crc-0.1.0.tgz"
npx rnrs build --target web --app .    # needs cargo, the wasm32 target, the pinned wasm-bindgen CLI
npx vite build
```

The build stops before compiling if the `wasm32-unknown-unknown` target is missing or the `wasm-bindgen` CLI is not the version the framework pins. The error names the fix command. `RNR_WASM_BINDGEN` selects another CLI.

### Android ✅ `nix develop "$REPO"`

1. Create an RN **0.88.0** app. The scripts unpack `@react-native-community/template@0.88.0`; `npx @react-native-community/cli@20.2.0 init App --version 0.88.0` should work too ⚠.
2. Install the tarballs and build:

```sh
cd "$WORK/App"
npm install "$PACK/rnrs-cli-0.1.0.tgz" "$PACK/rnrs-runtime-0.1.0.tgz" "$WORK/crc/demo-crc-0.1.0.tgz"
cd android && ./gradlew --no-daemon --init-script "$REPO/scripts/consumer/nix-sdk.init.gradle" \
  assembleRelease -PreactNativeArchitectures=arm64-v8a
```

- **The init script** is needed only with the Nix SDK, which has only build-tools 37.0.0. It sets library modules' `buildToolsVersion` and does not edit the app. With a normal SDK that has the template's default build-tools, leave it out ⚠.
- **Tools:** the framework's Gradle task runs `node` and `cargo`. If they are not on the Gradle process's `PATH` (Android Studio started outside your shell), set `NODE_BINARY` or `-Prnr.node=/absolute/path/to/node`, and `RNR_CARGO`. A relative path is rejected. With `RNR_CARGO`, also set `RUSTC` to the matching `rustc`, or the missing-target check is skipped and cargo reports it instead. A missing `aarch64-linux-android` target is reported before compiling, with the `rustup target add` command.
- **ABIs:** only arm64 is tested.

### iOS 🔁 `nix develop "$REPO#ios"` (Mac)

Not rerun for this flow. These are the commands of `scripts/consumer/ios-app.sh`, which builds the repo's own modules.

```sh
cd "$WORK/App"
npm install "$PACK/rnrs-cli-0.1.0.tgz" "$PACK/rnrs-runtime-0.1.0.tgz" "$WORK/crc/demo-crc-0.1.0.tgz"   # needs "ios" in the module's targets
cd ios && RCT_USE_RN_DEP=1 RCT_USE_PREBUILT_RNCORE=1 pod install           # RN's prebuilt core and dependencies (as Expo uses)
```

- **Building:** use Xcode, or `xcodebuild` from the same shell. A pod script phase builds the Rust bundle.
- **If Xcode can't find node or cargo:** the phase sources `ios/.xcode.env` and `ios/.xcode.env.local`. `NODE_BINARY=…` is read by the script itself. Cargo settings must be **exported**, because they reach `rnrs` as environment variables:

  ```sh
  export RNR_CARGO="$HOME/.cargo/bin/cargo"   # or: export PATH="$HOME/.cargo/bin:$PATH"
  export RUSTUP_TOOLCHAIN=1.90.0
  ```

- **Not supported:** `use_frameworks!`.
- **Full flow:** `scripts/consumer/ios-app.sh` and [ios](ios.md).

### Expo

Not validated. Expo Go cannot load custom native code. Prebuild and dev builds were never tried.

## 5. Runtime rules

| Topic | Rule |
| --- | --- |
| Module | `xorModule()` returns the runtime's single instance. The framework tears it down with the JS runtime (reload, destroy); never tear it down yourself. |
| Native objects | Call `obj.dispose()`. GC finalization is only a fallback, and in-flight async calls hold their own reference. |
| Async | A `Promise<T>` result maps to Rust `async fn` + `CancelToken`. Cancel with `method(args…, {signal})`, which rejects with `AbortError`. Cancellation is cooperative. |
| Back-pressure | `maxInFlight` per module (default 8, set in `rustNative`), plus a process-wide budget of 32 on Android/iOS. Overflow rejects with `RnrError` code `overloaded`. |
| Errors | `Err(String)` throws (sync) or rejects (async). Codes: `cancelled`, `overloaded`, `closed`, `failed`, `lost`. Panics abort. |
| Threads | Sync methods run on the JS thread. Async work runs on the framework's Tokio runtime (native) or as browser-local futures (web). |
| Logging | Module and library crates only emit `tracing`/`log` events and must not install a global subscriber. The app chooses in `package.json` `rustNativeApp.logging`: the framework installs one (managed), or the app's own setup code does (`"mode": "external"`). See [logging](logging.md). |

Lifecycle details: [ownership](ownership.md).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Cannot find package 'typescript'` | Run `npm ci` (repo) or install `@rnrs/runtime`. |
| Which commands exist? | `npx rnrs help`. |
| `cargo`, `rustup` or `wasm-bindgen` not found inside the Nix shell | Use a non-login shell (not `bash -l`), then run the `rustup toolchain install` line (step 0). |
| `npm install` changed a parent directory's `package.json` | Write the package's own `package.json` first (step 2). |
| `rnrs init: nothing was written` | It lists the conflicting files and fields. Fix them by hand, or use an empty directory. |
| `does not match its spec for this rnr version` | Rebuild and reinstall the module tarball (`npm pack` regenerates). |
| `rnr-<target>.Cargo.lock is missing` or stale | Run `npx rnrs lock --target T` and commit the lock. |
| Web: error mentioning `initRnr` | Await `initRnr(bundle)` before any module call. |
| `rnrs build --target web` refuses a module | The module lacks `web` in its targets (e.g. `@rnrs/example-kv`). |
| `the Rust target … is not installed` | Run the `rustup target add …` command it prints, in the shell that builds. |
| `cannot run cargo` | Install rustup and the toolchain (step 0), or set `RNR_CARGO`. |
| `needs the wasm-bindgen CLI …` | Run the `cargo install wasm-bindgen-cli --version … --locked` it prints, or use `nix develop "$REPO#web"`. |
| `generated from different specs` at runtime | Wrapper and glue are out of sync: reinstall matching tarballs and rebuild. |
| Android Studio sync warns that the bundle is not built | Expected; the first Gradle build builds it. |
