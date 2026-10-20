#!/usr/bin/env bash
# The author workflow outside this repository (inside `nix develop .#web`): a new package
# with only package.json, a TS spec and a Rust crate, plus @rnrs/runtime as a dev tool.
#   rnrs generate .   -> rust/src/rnr_interface.rs (committed by the author)
#   cargo test       -> the author's Rust tests, rnr-core taken from the installed runtime
#   rnrs pack-js .    -> rnr/{index,web}.ts, then npm pack
# The tarball is then installed into a fresh Vite app, bundled and run in headless Chromium.
set -euo pipefail
OUT_JSON="${1:+$(realpath -m "$1")}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
C="$ROOT/.generated/consumer"
PKG="$C/author-xor"
APP="$C/author-app"
PACK="$ROOT/.generated/pack"
[ -f "$PACK/rnrs-runtime-0.1.0.tgz" ] || node "$ROOT/scripts/pack.mjs"
export RUSTUP_HOME="${RUSTUP_HOME:-$ROOT/.generated/rustup}"
export CARGO_HOME="${CARGO_HOME:-$ROOT/.generated/cargo}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.90.0}"

rm -rf "$PKG" "$APP"
mkdir -p "$PKG/rust/src" "$APP"
cat > "$PKG/package.json" <<'JSON'
{
  "name": "@demo/xor",
  "version": "0.1.0",
  "private": true,
  "rustNative": {
    "targets": ["android", "web"],
    "spec": "xor.spec.ts",
    "rust": {"crate": "demo-xor", "path": "rust", "module": "Module"}
  },
  "files": ["xor.spec.ts", "rust/Cargo.toml", "rust/src", "rnr"],
  "main": "rnr/index.ts",
  "types": "rnr/index.ts",
  "browser": "rnr/web.ts",
  "exports": {".": {"types": "./rnr/index.ts", "browser": "./rnr/web.ts", "default": "./rnr/index.ts"}},
  "peerDependencies": {"@rnrs/runtime": "0.1.0"},
  "license": "UNLICENSED"
}
JSON
cat > "$PKG/rust/Cargo.toml" <<'TOML'
[package]
name = "demo-xor"
version = "0.1.0"
edition = "2021"

[dependencies]
rnr-core = "0.1"
TOML
cp "$ROOT/fixtures/author/xor.spec.ts" "$PKG/"
cp "$ROOT/fixtures/author/lib.rs" "$PKG/rust/src/lib.rs"
cd "$PKG"
npm install --no-audit --no-fund --save-dev "$PACK/rnrs-cli-0.1.0.tgz" "$PACK/rnrs-runtime-0.1.0.tgz"
npx rnrs generate .
npx rnrs check .
# rnr-core is not on crates.io; resolve it to the installed framework copy for local builds.
(cd rust && cargo test --config "patch.crates-io.rnr-core.path=\"$PKG/node_modules/@rnrs/runtime/rust/rnr-core\"" \
  --target-dir "$PKG/.rnr/target" 2>&1 | grep -E '^test |test result')
npx rnrs pack-js .
tarball="$PKG/$(npm pack --ignore-scripts --silent)"
echo "author tarball: $(tar -tzf "$tarball" | tr '\n' ' ')"

cd "$APP"
printf '{"name": "author-app", "version": "0.0.0", "private": true, "type": "module", "devDependencies": {"vite": "6.4.4"}}\n' > package.json
printf '<!doctype html>\n<meta charset="utf-8">\n<script type="module" src="./main.ts"></script>\n' > index.html
cp "$ROOT/fixtures/author/smoke.ts" main.ts
npm install --no-audit --no-fund "$PACK/rnrs-cli-0.1.0.tgz" "$PACK/rnrs-runtime-0.1.0.tgz" "$tarball"
npx rnrs build --target web --app .
npx vite build --logLevel warn
RNR_WEB_ROOT="$APP/dist" node "$ROOT/scripts/web-test.mjs" $OUT_JSON
