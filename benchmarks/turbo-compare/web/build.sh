#!/usr/bin/env bash
# Builds the comparison harness's browser page (informational; inside `nix develop .#web`):
# the rnrs Wasm bundle with the benchmark module (rnrs build --target web, release profile
# opt-level 3 / panic abort), the minimal direct wasm-bindgen crate (web/direct, same pin and
# profile) and the page (esbuild). RNRS_WASM_BINDGEN / ESBUILD may name the pinned tools.
# Writes web/dist/provenance.json (commit, cleanliness, artifact hashes, tool versions).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERE="$ROOT/benchmarks/turbo-compare"
WEB="$HERE/web"
STATUS="$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)"
cd "$ROOT"
source scripts/rust-env.sh
rustup toolchain install 1.90.0 --profile minimal --target wasm32-unknown-unknown >/dev/null
WASM_BINDGEN="${RNRS_WASM_BINDGEN:-wasm-bindgen}"
node "$HERE/gen-cases.mjs" --check
node packages/cli/bin/rnrs.mjs pack-js "$HERE/rnrs-module"
# The page's package.json lists the benchmark module; it is not in the root node_modules.
mkdir -p "$WEB/node_modules/@rnrs"
ln -sfn "$HERE/rnrs-module" "$WEB/node_modules/@rnrs/labs-turbo-compare"
ln -sfn "$ROOT/packages/runtime" "$WEB/node_modules/@rnrs/runtime"
RNRS_WASM_BINDGEN="$WASM_BINDGEN" node packages/cli/bin/rnrs.mjs build --target web --app "$WEB" --out "$WEB/rnrs"
(cd "$WEB/direct" && cargo build --release --locked --target wasm32-unknown-unknown)
rm -rf "$WEB/direct-pkg"
"$WASM_BINDGEN" --target web --out-dir "$WEB/direct-pkg" \
  "$WEB/direct/target/wasm32-unknown-unknown/release/cmp_wasm_direct.wasm"
"${ESBUILD:-esbuild}" "$WEB/main.ts" --bundle --format=esm --target=es2022 --platform=browser \
  --outfile="$WEB/dist/main.js"
sha() { sha256sum "$1" | cut -d' ' -f1; }
STATUS="$STATUS" COMMIT="$(git rev-parse HEAD)" RUSTC="$(rustc --version)" WB="$("$WASM_BINDGEN" --version)" \
  ESB="$("${ESBUILD:-esbuild}" --version)" BUNDLE_SHA="$(sha "$WEB/rnrs/pkg/rnrs_bundle_bg.wasm")" \
  DIRECT_SHA="$(sha "$WEB/direct-pkg/cmp_wasm_direct_bg.wasm")" MAIN_SHA="$(sha "$WEB/dist/main.js")" \
  node -e 'const e = process.env; require("fs").writeFileSync(process.argv[1], JSON.stringify({
    commit: e.COMMIT, sourceStatus: e.STATUS.split("\n").filter(Boolean), sourceClean: !e.STATUS,
    rnrsBundleWasmSha256: e.BUNDLE_SHA, directWasmSha256: e.DIRECT_SHA, mainJsSha256: e.MAIN_SHA,
    versions: { rustc: e.RUSTC, wasmBindgen: e.WB, esbuild: e.ESB, node: process.version },
    profile: "release, opt-level 3, panic abort (rnrs bundle and web/direct)" }, null, 1) + "\n");' "$WEB/dist/provenance.json"
cat "$WEB/dist/provenance.json"
