# Packaging: framework package, author packages, per-app Rust bundles

Experimental, 2026-10-19. Built from local tarballs only; nothing is published. Targets are Android and iOS on RN 0.88.0 bridgeless (being validated; earlier device results are from 0.83.1 on one Pixel 2 XL and one iPhone 12 Pro; see [status](status.md) and [iOS](ios.md)) and the browser (tested in headless Chromium). Targets are separated into known names and implemented ones; all three known names (`android`, `ios`, `web`) are now implemented, and the check remains so that a future name cannot be declared before its backend exists.

## Who owns what

| Package | Contents |
| --- | --- |
| `@rnrs/runtime` (framework; `packages/rnr-runtime`, staged by `scripts/pack.mjs`) | The Android library (Kotlin TurboModule `RnrRuntime` with lifecycle hooks, CMake, and a Gradle task that builds the app's Rust bundle) and the iOS pod (`RnrRuntime.podspec`: Objective-C++ TurboModule with lifecycle hooks and a script phase that builds the bundle), sharing the generic JSI adapter and runtime scope (C++, `cpp/`). Autolinking config for both. The JS runtime and both backends, `initRnr` for the web, the spec types (`@rnrs/runtime/spec`). The framework Rust crates `rnr-core`, `rnr-android`, `rnr-web` and `rnr-log`. Depends on `@rnrs/cli` at the exact same version: the Gradle task and the Xcode script phase run it through the internal launcher `cli/run.mjs` (not a bin), which resolves `@rnrs/cli` from the runtime package and refuses another version. |
| `@rnrs/cli` (framework tooling; `packages/rnr-cli` plus the generator `tools/rnr-gen`, staged by `scripts/pack.mjs` into `generator/`) | The `rnrs` bin: the generator, the author commands (`init`, `generate`, `check`, `test`, `pack-js`) and the app commands (`bundle`, `build`, `lock`). No framework code of its own: it peer-depends on `@rnrs/runtime` at the exact same version and takes the spec and the framework Rust crates from the `@rnrs/runtime` that Node resolves from the CLI's location (for an app, its own `node_modules/@rnrs/runtime`). A missing or different-version runtime is an error naming the install command. |
| Module package (author) | Peer dependency on `@rnrs/runtime`, dev dependencies on `@rnrs/cli` and `@rnrs/runtime` (written by `rnrs init`). `package.json` with `rustNative`, the TS spec, the Rust crate (`Cargo.toml`, `src/lib.rs`, the committed generated `src/rnr_interface.rs`), and the JS wrapper `rnr/{index,web}.ts` written by `rnrs pack-js` at pack time. No C++, Kotlin, JSI, wasm-bindgen or glue. |
| App | Depends on `@rnrs/runtime` (which brings `@rnrs/cli`) and module packages. Until the packages are published, the tarball installs also list the `@rnrs/cli` tarball, so that npm does not look up the runtime's dependency on the registry. No native edits: autolinking adds the framework library, and its Gradle task builds the bundle. Web apps call `await initRnr(bundle)` once. |

The Rust glue is never in a package. It is generated per app into the ignored `<app>/.rnr/<target>/bundle/`, a standalone crate with its own `[workspace]`. That crate's dependencies are generated from the selected modules: path dependencies on the installed module crates and the framework crates, plus `[patch.crates-io] rnr-core` pointing to the installed framework copy. Module crates declare `rnr-core = "0.1"` like a normal dependency.

## Names: npm packages and temporary internal names

Packages use the `@rnrs` scope: `@rnrs/runtime`, `@rnrs/surface`, and the separate `@rnrs/cli` package with the `rnrs` command. Examples use `@rnrs/example-*`; internal fixtures use `@rnrs/labs-*`. Tarball filenames follow package names. Nothing is published or reserved.

Everything else keeps its `rnrs` name for now. These are temporary internal names, left unchanged on purpose because renaming them would not change any public npm name and would risk breaking native or Cargo resolution:

| Kind | Names kept |
| --- | --- |
| Repository directories | `packages/rnr-runtime`, `packages/rnr-surface`, `packages/rnr-cli`, `tools/rnr-gen`, `rust/rnr-*` |
| Rust crates | `rnr-core`, `rnr-android`, `rnr-web`, `rnr-log`, `rnr-surface`, the generated `rnr-bundle`, module crates such as `rnr-blake3` |
| Native identifiers | Kotlin/Java packages `dev.rustjsilab.rnr` and `dev.rustjsilab.rnr.surface` (and their JNI symbols), the C ABI (`RnrAbi.h`, `rnr_surface_*`), pods `RnrRuntime` and `RnrSurface`, codegen names `RnrRuntimeSpec` and `RnrSurfaceSpec`, `librnr.so`, `librnr_bundle.a` |
| JS identifiers | `initRnr`, `RnrSurfaceView` and the other exports |
| Files and settings | the wrapper directory `rnr/`, `.rnr/`, `rust/src/rnr_interface.rs`, `rnr-<target>.Cargo.lock`, `RNR_*` environment variables, Gradle properties `rnr.node` and `rnr.locked`, the `package.json` fields `rustNative` and `rustNativeApp`, the `rnr-gen:` prefix of the repository-only generator commands |

Historical reports and provenance in the companion archive retain the package names and commands recorded at the time.

## Discovery and targets

`rnrs bundle|build --target android|web --app DIR` (the Android Gradle task runs it with the app's ABIs):

- It starts from the app's `dependencies` and `optionalDependencies`. `devDependencies` and `peerDependencies` are not followed, so workspace siblings and dev tools are never bundled.
- Each name resolves through `node_modules` the way Node does, walking up from the depending package. The walk recurses through each resolved package's `dependencies` and installed `optionalDependencies`, and dedupes by real path.
- A package is a module if its `package.json` has `rustNative`.
- Errors name the dependency chain (`app -> wrapper -> android-only`):
  - a selected module that does not declare the target;
  - a missing required dependency (a missing optional one is skipped);
  - two modules with the same crate or module name;
  - a committed interface that does not match its spec under this `rnrs` version.
- Nothing is silently omitted. A module without web support also gets an `rnr/web.ts` that throws at import, naming its targets.

## Lock files

Each app owns one lock per target: `<app>/rnr-android.Cargo.lock` and `<app>/rnr-web.Cargo.lock`. The app commits them. They live outside the generated, ignored `.rnr/` (which carries its own `.gitignore`), so deleting or regenerating the bundle keeps them.

- **Normal builds** (`rnrs build`, the Gradle task) copy the app's lock into the bundle crate and resolve with `--locked`. If the dependencies no longer match (a module added, removed or changed), the build fails before compiling and names the command to run. If there is no lock, the first build creates it and says to commit it.
- **CI:** `rnrs build --locked`, `RNR_LOCKED=1`, or Gradle `-Prnr.locked=true` also fail when the lock is missing. `rnrs lock --check --target T` verifies the lock without building.
- **Updating:** `rnrs lock --target T` rewrites the lock for the current dependencies, keeping locked versions; `--update` also upgrades within semver ranges. Both target-specific locks are independent.
- **Portability:** cargo records path dependencies (module crates, framework crates) by name and version only, so a lock holds no machine paths. Tests check that the lock contains no app, repository, temp or home path, and that a relocated copy of an app builds `--locked` with the lock unchanged: unit tests, the Vite consumer, and the RN consumer through Gradle.
- **What a lock does not give:** bit-reproducible artifacts. Output also depends on the Rust toolchain (1.90.0 tested), NDK, wasm-bindgen and build environment. The lock format follows the cargo version.
- **Provenance:** `rnr-core` is not published, and its crates.io name is not reserved; publishing or reserving it is out of scope. Two checks keep an unrelated crate out:
  - Bundles patch `rnr-core` to the framework copy, and after resolution `rnrs` checks that `rnr-core`, `rnr-android` and `rnr-web` resolved to this framework's own copies. Anything from a registry fails the build.
  - `rnrs generate|check <dir>` and `pack-js` require the module crate's `rnr-core` requirement to be one the framework satisfies (`"0.1"`).

## Android Studio sync

An IDE sync can configure CMake without running the Gradle task that builds the bundle (for example on a fresh checkout). The framework's CMake script then only warns. Every Gradle build orders `rnrBuildRustBundle` before preBuild and before the CMake configure and build tasks, and linking without the bundle names the missing file.

Tested: a fresh relocated consumer's `configureCMakeRelWithDebInfo[arm64-v8a]`, with the bundle task excluded, succeeds with the warning. Android Studio itself was not run.

## Author workflow (TS + Rust only)

The [quickstart](quickstart.md#2-create-the-module-) has the full steps. In short:

```sh
echo '{"name": "@demo/crc", "private": true}' > package.json
npm exec --package=@rnrs/cli -- rnrs init     # one-off (here: --package=<both tarballs>); package.json fields, spec, rust/ crate, .gitignore
npm install                                   # the devDependencies @rnrs/cli and @rnrs/runtime written by init (here: the tarballs)
npx rnrs test                                 # generate, then cargo test with rnr-core patched to the installed copy
npx rnrs check                                # interface current, package.json usable by apps (after generate/test on a fresh clone)
npm pack                                     # prepack: rnrs generate + rnrs pack-js
```

`rnr-core` is not on crates.io. `rnrs test` patches it to `node_modules/@rnrs/runtime/rust/rnr-core`, and bundles do the same automatically. Checked by:
- `scripts/consumer/fresh-author.sh web|android`: a new `@demo/crc` package wrapping `crc32fast`, then a fresh Vite or RN app.
- `scripts/consumer/author.sh`: the older hand-written `@demo/xor` package, web only.

## Clean consumers

- **React Native (`scripts/consumer/rn-app.sh`, then `rn-smoke.mjs`).**
  - The app is the pristine `@react-native-community/template@0.88.0` (tarball sha256 checked), plus `App.tsx`, `smoke.ts`, the vectors JSON and `npm install` of the tarballs: `@rnrs/cli` and `@rnrs/runtime`, plus the selected modules (by default `@rnrs/example-blake3` and `@rnrs/example-counter`).
  - After `assembleRelease`, the script requires `android/` and `ios/` to be byte-identical to the template, and no Rust or native sources elsewhere in the app.
  - The Nix SDK only has build-tools 37.0.0, so the build passes a Gradle `--init-script` (`nix-sdk.init.gradle`) that sets library modules' `buildToolsVersion`. This is a property of the build environment, not an app edit.
  - The smoke installs the APK, reads `RNR_SMOKE` from logcat, and uninstalls the fixture app (`com.helloworld`).
- **Vite (`scripts/consumer/web-app.sh`).** The app holds only `index.html`, `main.ts`, `smoke.ts` and the vectors. The build steps are `rnrs build --target web`, then `vite build` (6.4.4), then headless Chromium via `scripts/web-test.mjs` with `RNR_WEB_ROOT`. It checks that using a module before `initRnr` throws an actionable error.

`react-native` is an optional peer of `@rnrs/runtime`, so web apps and author packages do not install it.

`initRnr(bundle)` semantics:
- Concurrent and repeated calls with the same bundle share one initialization, so there is only one backend instance.
- A failed load (for example the .wasm fetch) rejects, and a later call retries.
- Once initialized, a call with a different bundle rejects. The Vite smoke checks all three.

## blake3

`@rnrs/example-blake3` wraps the `blake3` crate (1.8.7):

- module functions `hash`, `hashHex`, `keyedHash`, `deriveKey` and `hashLater` (async, cancellable between 64 KiB chunks);
- `Hasher` objects (`update`, `updateLater`, `finalize`, `finalizeXof`, `reset`) created by `hasher`, `keyedHasher` and `derivingHasher`.

**Hasher concurrency.** While an `updateLater` runs, every other operation on that hasher fails with "hasher is busy" (sync `update`/`finalize`/`finalizeXof`/`reset` and a second `updateLater`).
- The busy state begins when the operation starts on the executor. A sync call made right after `updateLater` therefore either fails busy or is ordered before the update.
- The update is hashed into a copy of the state and committed in one step when all input is hashed, so the digest never reflects part of an update.
- Errors, cancellation observed before the commit, or a dropped future leave the state unchanged and release the gate.
- An abort that arrives after the commit still rejects with AbortError, but the update stays committed. A rejection does not mean rollback: the core accepts a cancellation until the outcome is delivered.
- Covered by deterministic, hand-polled crate tests (every interleaving step), glue tests on Tokio and the shared suite on both platforms.

Tests use the official vectors from BLAKE3 1.8.2 (`fixtures/blake3`; 35 cases covering empty input, chunk and block boundaries, keyed and derive-key cases, and 131-byte XOF), plus key and XOF-length validation, receiver retention by `updateLater` after `dispose()`, and abort. Payloads stay at most 8 MiB. The single 1 MiB timing in the lab suites is a sanity note, not a benchmark.

## Example modules

- [`@rnrs/example-http`](http.md): reqwest, Android, iOS and web.
- [`@rnrs/example-kv`](kv.md): sled, Android and iOS (no web).

Both are consumed as tarballs by clean consumers. `scripts/consumer/rn-app.sh` and `web-app.sh` take `FIXTURE`, `MODULES` and `NAME`.

**Separate graphs per target set.** Because kv has no web target, the lab's browser harness is its own app for rnr (`web/package.json`, lock `web/rnr-web.Cargo.lock`), and lists only web modules. Bundling the repository root for the web is refused (`rust-jsi-lab -> @rnrs/example-kv …`). There are no per-target exclusion lists.

**Framework addition for kv:** `rnr_core::platform::app_data_dir()`, set from Kotlin (`Context.getFilesDir()/rnr`); see kv.md.

## Limits

- iOS is tested on one device (arm64); see [iOS limits](ios.md#limits). Android is tested on one device with arm64 only; the other ABIs map to triples but are unbuilt.
- Consumer builds need the Rust toolchain (1.90.0 tested, with the Android or wasm32 target) and, for the web, `wasm-bindgen` 0.2.129 on `PATH`. The scripts take them from the repository's Nix shells and the local `.generated/` caches.
- `rnrs generate` without an argument still reads the repository's `rustNativeApp.packages` (lab and tests); authors pass their package directory.
