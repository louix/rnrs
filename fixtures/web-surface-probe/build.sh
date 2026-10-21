#!/usr/bin/env bash
# Run from repository root inside the existing nix develop .#web environment.
set -euo pipefail
source scripts/rust-env.sh
fixture="$PWD/fixtures/web-surface-probe"
cargo build --locked --offline --manifest-path "$fixture/Cargo.toml" --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir "$fixture/pkg" "$fixture/target/wasm32-unknown-unknown/release/rnrs_web_surface_probe.wasm"
esbuild "$fixture/main.ts" --bundle --format=esm --target=es2022 --external:../pkg/* --outfile="$fixture/dist/main.js"
