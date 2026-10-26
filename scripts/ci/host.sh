#!/usr/bin/env bash
# CI `host` job (inside `nix develop .#host`, after `npm ci --ignore-scripts`): lint, format,
# types, the Node test suite with cargo required, generated-file and release checks, the Rust
# workspace, generation reliability and the framework C++ under sanitizers.
set -euo pipefail
cd "$(dirname "$0")/../.."
npm run fmt:check
npm run lint
npm run typecheck
source scripts/rust-env.sh
rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal
cargo fetch --locked
node scripts/prepare-test-cache.mjs
# Strict: cargo-backed tests (lock files, packaged offline resolution) fail instead of skipping.
RNRS_REQUIRE_CARGO=1 npm test
npm run rnrs:check
node scripts/release.mjs check --dir .generated/release
cargo test --workspace --locked --features rnrs-core/tokio,rnrs-core/smol
bash scripts/check-generation.sh
bash scripts/test-native.sh
