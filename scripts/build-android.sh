#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node tools/rnr-gen/cli.mjs generate
export RUSTUP_HOME="$PWD/.generated/rustup"
export CARGO_HOME="$PWD/.generated/cargo"
export GRADLE_USER_HOME="$PWD/.generated/gradle"
export RUSTUP_TOOLCHAIN=1.90.0
rustup toolchain install 1.90.0 --profile minimal --target aarch64-linux-android
rustup run 1.90.0 cargo test --workspace --features rnr-core/tokio,rnr-core/smol
cd android
# RNR_GRADLE_ARGS: extra Gradle arguments, e.g. -Prnr.diagnostics=true (attribution builds).
./gradlew --no-daemon :app:assembleRelease -PreactNativeArchitectures=arm64-v8a ${RNR_GRADLE_ARGS:-}
