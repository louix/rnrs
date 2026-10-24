# rnrs vs RN-codegen C++ TurboModule (benchmark harness)

Measurement-only harness. Methodology, comparability decisions and results live in the project's
shared notes (`benchmarks/turbo-compare-*`), not here; nothing in this directory is a product module
or a published result.

| path | what |
| --- | --- |
| `rnrs-module/` | `@rnrs/labs-turbo-compare`: rnrs spec + Rust implementation |
| `cxx-module/` | `@rnrs-bench/cmp-cxx`: RN 0.88 codegen spec + pure C++ TurboModule `RnrsCmpCxx` (autolinked: Android `cxxModule*`, iOS `codegenConfig.ios.modulesProvider`), plus the handwritten JSI scalar control installed by `installHarness()` |
| `app/` | harness JS copied into the RN 0.88.0 community template (`cases.generated.ts` from `workloads.mjs` via `gen-cases.mjs`) |
| `build-android.sh`, `build-ios.sh` | release builds with provenance |
| `run-android.mjs`, `run-ios.mjs` | fresh-process device runs, one CSPRNG seed per run |
| `fixed-n.mjs` | fixed iterations per sample per phone, derived from a pilot summary (`--fixed-n` of the runners) |
| `summarize.mjs` | strict validation, per-path and paired statistics, GC sensitivity and drift (descriptive) |

Both modules implement the same methods with the same algorithms; fixture strings are generated
identically in JS, C++ and Rust. Native objects and ArrayBuffer workloads are deliberately absent
(no equivalent codegen contract, or different copy semantics; see the notes).

```sh
nix develop -c benchmarks/turbo-compare/build-android.sh <label>     # clean tree
nix develop -c node benchmarks/turbo-compare/run-android.mjs --build .generated/turbo-compare/<label> \
  --out <dir> --serial <serial> --expect-model '<model>' --runs 8 --rounds 12 --fixed-n <phone>.json [--mode smoke]
node benchmarks/turbo-compare/summarize.mjs <dir>
# iOS (on the Mac, GUI session for signing; RNRSCMP_OUT, RUSTUP_HOME, CARGO_HOME outside the source):
RNRS_IOS_TEAM=… RNRS_IOS_BUNDLE_ID=… RNRS_IOS_DEVICE=<udid> nix develop .#ios -c benchmarks/turbo-compare/build-ios.sh <label>
nix develop .#ios -c node benchmarks/turbo-compare/run-ios.mjs --build "$RNRSCMP_OUT/<label>" --out <dir> \
  --device <devicectl id> --udid <udid> --expect-model 'iPhone 12 Pro'
```
