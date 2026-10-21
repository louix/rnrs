# Maintainers: the lab

This repository contains the framework and its regression harnesses. App authors don't need this page; start with the [quickstart](quickstart.md).

## Layout

| Path | What |
| --- | --- |
| `packages/rnr-runtime` | Framework package `@rnrs/runtime`: JS runtime, Android/iOS native library, shared JSI C++ (`cpp/`). |
| `packages/rnr-cli`, `tools/rnr-gen` | `@rnrs/cli`: the `rnrs` command and shipped `generator/`. |
| `rust/rnrs-*` | Framework crates. `rnrs-android` is the native backend for **both** Android and iOS. |
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

## JavaScript maintenance

Use `npm run fmt` / `npm run fmt:check` for maintained JS/TS formatting, `npm run lint` / `npm run lint:fix` for correctness checks and safe fixes, then `npm run typecheck` and `npm test`. Generated/vendor/build output, archives, results and lockfiles are excluded; native formatting uses separate tools. Oxfmt 0.72.0 and Oxlint 1.87.0 were published on 2026-10-05 and selected on 2026-10-20 as the newest non-prereleases at least 14 days old. Narrow documented exceptions preserve lifecycle timing, measured allocations and mutable Worklets values.

`.npmrc` saves exact npm versions. Once Renovate is enabled, routine updates wait 14 days with required publication timestamps and strict age filtering; direct npm dependencies are pinned, peer ranges remain separate. This bot policy does not block manual `npm install`, does not enforce Cargo exact pins, and release age does not guarantee safety. Review release notes and test results, and commit lockfile changes.

Security fixes may bypass the delay: Renovate vulnerability-alert PRs explicitly use zero delay and require review (no automerge). GitHub dependency graph/Dependabot alerts and Renovate access are required. For a manual security exception, record the advisory and reason in the update PR, install the exact fixed version, and run relevant checks.

## Local package testing

Build framework packages from this checkout when testing changes before publishing:

```sh
REPO=/absolute/path/to/this/checkout
cd "$REPO"
npm ci --ignore-scripts
node scripts/pack.mjs
PACK="$REPO/.generated/pack"
```

Install the matching runtime and CLI archives together in the test project, so npm does not resolve one from the registry. Rendering projects also need the surface archive. Substitute these paths for registry package names in the quickstart.

```sh
npm install "$PACK/rnrs-runtime-0.1.0.tgz" "$PACK/rnrs-cli-0.1.0.tgz"
```

The clean-consumer scripts in `scripts/consumer/` build independent apps from these packages. `fresh-author.sh web|android` also creates a new module outside the repository. Run `npm run test:rnrs-offline` in the configured Rust environment to verify packaged framework resolution without a registry fallback.
