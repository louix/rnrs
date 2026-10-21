#!/usr/bin/env bash
# Generation reliability checks (inside `nix develop`). Hidden glue lives in build outputs:
# bind-tests' OUT_DIR (cargo-managed) and the app's .rnr/ bundle crates (written atomically
# by `rnrs bundle`). Deleting either must not break the next build.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/rust-env.sh
cargo build -p bind-tests -q
echo "1/4 deleting .generated/rnr, then rebuilding without cargo clean"
rm -rf .generated/rnr
cargo build -p bind-tests -q
echo "2/4 a spec change reruns generation (incremental)"
touch packages/meter/meter.spec.ts
cargo build -p bind-tests -q
echo "3/4 deleting the app bundle crate, then regenerating it from the dependency graph"
rm -rf .rnr/android/bundle
node packages/cli/bin/rnrs.mjs bundle --target android --app . >/dev/null
test -f .rnr/android/bundle/src/lib.rs
echo "4/4 concurrent bundle generators"
for i in 1 2 3 4; do node packages/cli/bin/rnrs.mjs bundle --target android --app . >/dev/null & done
wait
! find .rnr/android/bundle -name '*.tmp-*' | grep -q .
cargo test -p bind-tests -q 2>&1 | grep -E "test result" | head -3
node tools/rnrs-gen/cli.mjs generate >/dev/null  # restore the TS wrappers for tsc/Metro
echo "generation checks passed"
