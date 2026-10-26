# Developing rnrs

This repository contains the framework, example modules and their regression harnesses. App and
module authors don't need this page; start with the [quickstart](quickstart.md).

## Layout

| Path | What |
| --- | --- |
| `packages/runtime` | `@rnrs/runtime`: JS runtime, Android/iOS native library, shared JSI C++ (`cpp/`). |
| `packages/cli`, `tools/rnrs-gen` | `@rnrs/cli`: the `rnrs` command and the generator it ships. |
| `packages/surface` | `@rnrs/surface`: the `SurfaceView` component and the `rnrs-surface` crate. |
| `rust/rnrs-*` | Framework crates. `rnrs-android` is the native backend for **both** Android and iOS. |
| `packages/*` | Example and lab module packages ([examples](README.md)). The root `package.json` lists them in `rustNativeApp.packages` for `generate` and `check`. |
| `apps/lab` | Android conformance and lifecycle app (an npm workspace; `npm start` and `npm run android` forward to it). |
| `apps/lab/web` | Browser harness for the same suites, with its own app dependency graph (without `kv`). |
| `native/tests` | Host tests for the shared JSI C++ (`scripts/test-native.sh`). |
| `fixtures/`, `scripts/consumer/` | Clean consumer apps and the scripts that build and check them. |
| `results/` | Ignored output of local runs. Keep provenance (commit, device, tool versions) with each run. |

## Commands

Repository scripts `source scripts/rust-env.sh` from the repository root. It exports
`RUSTUP_HOME` and `CARGO_HOME` (both under `.generated/`) and `RUSTUP_TOOLCHAIN`; the build scripts
install the toolchain there. Shells are described in [setup](setup.md#nix-shells).

| Command | Shell | Needs |
| --- | --- | --- |
| `npm test` | any | Run `node scripts/prepare-test-cache.mjs` once for offline npm installs. Lock-file tests skip without cargo; run `source scripts/rust-env.sh && cargo fetch --locked` first for the full set. |
| `npm run typecheck`, `npm run rnrs:check` | any | Node |
| `node scripts/pack.mjs` | any | Node; writes `.generated/pack/` ([local packages](setup.md#local-framework-packages)) |
| `node scripts/release.mjs check` | any | Node; packs and checks the publishable packages ([releasing](releasing.md)) |
| `npm run test:rnrs-offline` | Rust environment | packaged framework resolution without a registry |
| `bash scripts/build-android.sh` | `nix develop` | network on first run. Also runs the Rust workspace tests. |
| `bash scripts/build-web.sh`, then `node scripts/web-test.mjs` | `nix develop .#web` | |
| `node scripts/rnrs-device-test.mjs` | `nix develop` | lab APK installed, authorized device |
| `scripts/check-generation.sh`, `scripts/test-native.sh` | `nix develop` or `nix develop .#host` | |
| `scripts/consumer/{author,web-app}.sh` | `nix develop .#web` | toolchain and wasm32 target (run `build-web.sh` once) |
| `scripts/consumer/fresh-author.sh web\|android` | as above | creates a new module outside the repository |
| `scripts/consumer/rn-app.sh` + `rn-smoke.mjs` | `nix develop` | toolchain and Android target (run `build-android.sh` once), device |
| `scripts/consumer/ios-app.sh` + `ios-device-test.mjs` | `nix develop .#ios` (Mac) | Xcode; signing for a device |
| `node scripts/check-page-size.mjs <apk> [abi]` | `nix develop` | Android SDK; checks 16 KB alignment of an APK's native libraries |

The Android lab app runs the ownership and lifecycle suites on launch. Install its release APK, then
run `node scripts/rnrs-device-test.mjs`. Native test hooks are compiled only with `RNRS_TEST_HOOKS`
([iOS](ios.md)); the lab enables them in `apps/lab/android/gradle.properties`.

On disposable CI runners without a working Chromium sandbox, set `RNRS_WEB_NO_SANDBOX=1`
for browser harnesses. Local runs keep the sandbox enabled by default.

## JavaScript maintenance

Use `npm run fmt` / `npm run fmt:check` for formatting and `npm run lint` / `npm run lint:fix` for
lint checks, then `npm run typecheck` and `npm test`. Generated, vendored and build output, archives,
results and lock files are excluded. Native code uses separate formatters.

Direct npm dependencies are pinned to exact versions (`.npmrc` saves exact versions). Routine
updates wait 14 days after publication; Renovate enforces this once enabled, but it does not block
a manual `npm install` and does not cover Cargo. Security fixes may skip the wait: record the
advisory and reason in the update, install the exact fixed version, and run the relevant checks.
Review release notes and test results, and commit lock-file changes. The React Native 0.88.0 and
Expo SDK 58 baseline was adopted under a one-time, approved exception to the wait.

Published packages pin their own dependencies exactly but declare peer ranges: React Native
`^0.88.0` (0.88.0 is the tested baseline; later patch releases are accepted, not individually
tested) and, for `@rnrs/surface`, React `^19.3.0`.

## CI

`.github/workflows/ci.yml` runs on pull requests, on manual runs and, through the release
workflow, on `v*` tags. Pushes, including to `main`, start no run: before pushing directly, run
the same checks locally. Each job sets up its environment (Nix shell, toolchain and Gradle caches,
Xcode) and runs one script; run it from the repository root after `npm ci --ignore-scripts`:

| Job | Local command | Covers |
| --- | --- | --- |
| `host` | `nix develop .#host --command bash scripts/ci/host.sh` | format, lint, types, `npm test` with cargo required, `rnrs:check`, the [release check](releasing.md), Rust workspace tests, generation reliability, sanitizer C++ tests |
| `web` | `nix develop .#web --command bash scripts/ci/web.sh` | browser harness; clean Vite, author and `rnrs init` consumers in headless Chromium; binary-first prebuilt and mixed consumers |
| `android` | `nix develop --command bash scripts/ci/android.sh` | clean consumer APK, relocated `--locked` build, 16 KB alignment; binary-first: modules prebuilt for all four ABIs, a consumer built without Rust (four ABIs) and a mixed one |
| `ios` | `nix develop .#ios --command bash scripts/ci/ios.sh` (Mac) | clean simulator consumer and its smoke run on a temporary simulator (CI: Xcode 26.6) |

`host`, `web` and `android` need x86_64 Linux and `ios` needs a Mac; no machine runs all four.
All jobs, including `ios`, run on every pull request and every release; manual runs can skip
`ios`. The binary-first consumers (`scripts/consumer/binary-first.sh android|web`) build module
binaries as an author would, then build apps with cargo, rustc, rustup, wasm-bindgen and nix
replaced by failing tripwires, and a mixed app with one module from source. No CI job covers
prebuilt iOS binaries; that check is manual on a Mac. CI caches the Nix store, rustup, cargo downloads and Gradle, not build outputs, and sets
`RNRS_WEB_NO_SANDBOX=1` for `web` only. Device suites (`rnrs-device-test.mjs`, `rn-smoke.mjs`,
`ios-device-test.mjs`, the GPU and touch runners) stay manual.
