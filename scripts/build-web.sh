#!/usr/bin/env bash
# Run inside `nix develop .#web`. Generates bindings, builds the app's Wasm bundle with the
# framework CLI (the modules in web/package.json, the harness's own dependency graph) and the
# harness.
set -euo pipefail
cd "$(dirname "$0")/.."
node tools/rnrs-gen/cli.mjs generate
source scripts/rust-env.sh
rustup toolchain install 1.90.0 --profile minimal --target wasm32-unknown-unknown
node packages/cli/bin/rnrs.mjs build --target web --app web --out web/rnrs
esbuild web/main.ts --bundle --format=esm --target=es2022 --outfile=web/dist/main.js
