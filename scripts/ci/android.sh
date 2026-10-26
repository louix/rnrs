#!/usr/bin/env bash
# CI `android` job (inside `nix develop`, after `npm ci --ignore-scripts`): the clean React Native
# template consumer APK from the packed tarballs, its relocated --locked build and the 16 KB
# page alignment of its native libraries. No device needed.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/rust-env.sh
rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal --target aarch64-linux-android
bash scripts/consumer/rn-app.sh
node scripts/check-page-size.mjs .generated/consumer/rn-app/android/app/build/outputs/apk/release/app-release.apk
