# Maintainers: the lab

This repository contains the framework and its regression harnesses. App authors don't need this page; start with the [quickstart](quickstart.md).

## Layout

| Path | What |
| --- | --- |
| `packages/rnr-runtime` | Framework package `@rnrs/runtime`: JS runtime, Android/iOS native library, shared JSI C++ (`cpp/`). |
| `packages/rnr-cli`, `tools/rnr-gen` | `@rnrs/cli`: the `rnrs` command and shipped `generator/`. |
| `rust/rnr-*` | Framework crates. `rnr-android` is the native backend for **both** Android and iOS. |
| `packages/*` | Example module packages ([status](status.md#example-modules)). |
| `android/`, `src/`, `specs/`, `native/` | Android conformance and lifecycle runner; test-only GC hook. |
| `web/` | Browser harness (its own app graph, without `kv`). |
| `fixtures/`, `scripts/consumer/` | Clean consumer apps and the scripts that build and check them. |
| `results/` | Ignored output from local runs; retain provenance alongside measurements. |

## Commands

| Command | Shell | Needs |
| --- | --- | --- |
| `npm test` | any | Node. Lock-file tests skip without cargo; run `source scripts/rust-env.sh && cargo fetch --locked` first for the full set. |
| `npm run typecheck`, `npm run rnr:check` | any | Node |
| `node scripts/pack.mjs` | any | Node (writes `.generated/pack/`) |
| `bash scripts/build-android.sh` | `nix develop` | network on first run. Also runs the Rust workspace tests. |
| `bash scripts/build-web.sh`, then `node scripts/web-test.mjs` | `nix develop .#web` | |
| `node scripts/rnr-device-test.mjs` | `nix develop` | lab APK installed, device |
| `scripts/check-generation.sh`, `scripts/test-native.sh` | `nix develop` | |
| `scripts/consumer/{author,web-app}.sh` | `nix develop .#web` | toolchain + wasm32 target installed (run `build-web.sh` once) |
| `scripts/consumer/rn-app.sh` + `rn-smoke.mjs` | `nix develop` | toolchain + Android target (run `build-android.sh` once), device |
| `scripts/consumer/ios-app.sh` + `ios-device-test.mjs` | `nix develop .#ios` (Mac) | Xcode, signing; see [ios](ios.md#reproduce) |

The Android app launches the ownership and lifecycle suites by default. Install its release APK, then run `node scripts/rnr-device-test.mjs` with an authorized device. Clean iOS consumers are built by `scripts/consumer/ios-app.sh`; no comparison pod is required.

## Recorded measurements

Historical comparison capture apps and controls are archived outside the tracked source. Pure analysis utilities and their tests remain available for existing recordings; they do not require Nitro. The live rendering/input contention fixtures and their runners remain part of regression coverage.
