#!/usr/bin/env bash
# CI `web` job (inside `nix develop .#web`, after `npm ci --ignore-scripts`): the browser harness
# and the clean Vite, author and `rnrs init` consumers, each run in headless Chromium; then the
# binary-first consumers (prebuilt Wasm modules without Rust, and a mixed app).
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/pack.mjs  # tarballs of this checkout, as on a clean runner
bash scripts/build-web.sh
node scripts/web-test.mjs
bash scripts/consumer/web-app.sh
bash scripts/consumer/author.sh
bash scripts/consumer/fresh-author.sh web
bash scripts/consumer/binary-first.sh web
