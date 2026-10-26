#!/usr/bin/env bash
# CI `android` job (inside `nix develop`, after `npm ci --ignore-scripts`): the clean React Native
# template consumer APK from the packed tarballs (modules built from source), its relocated
# --locked build and the 16 KB page alignment of its native libraries; then the binary-first
# consumers: modules prebuilt for all four ABIs, an app built without Rust and a mixed one. No
# device needed.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/rust-env.sh
rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal --target aarch64-linux-android \
  --target armv7-linux-androideabi --target i686-linux-android --target x86_64-linux-android
bash scripts/consumer/rn-app.sh
node scripts/check-page-size.mjs .generated/consumer/rn-app/android/app/build/outputs/apk/release/app-release.apk
bash scripts/consumer/binary-first.sh android
node scripts/check-page-size.mjs .generated/binary-first/android/prebuilt/android/app/build/outputs/apk/release/app-release.apk
