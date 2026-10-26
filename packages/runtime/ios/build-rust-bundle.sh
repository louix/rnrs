#!/bin/bash
# Xcode script phase of the RnrsRuntime pod, present only when the app lists modules in
# rustNativeApp.sourceBuild: rewrites the module registry (<app>/.rnrs/ios/rnrs_registry.inc)
# and builds those modules from source for the SDK and architectures being built, into
# <app>/.rnrs/ios/lib/$PLATFORM_NAME/librnrs_bundle.a (linked by the app target). Prebuilt
# modules are linked from their XCFrameworks without this script.
#
# Needs node and cargo (with the Rust iOS targets: rustup target add aarch64-apple-ios
# aarch64-apple-ios-sim, plus x86_64-apple-ios for simulator builds that include Intel). Like
# React Native's own script phases, it reads NODE_BINARY and any environment from
# <app>/ios/.xcode.env and .xcode.env.local; set RNRS_CARGO there (or PATH)
# when Xcode does not inherit a shell with cargo. Uses the app's rnrs-ios.Cargo.lock (created
# by the first build if absent); RNRS_LOCKED=1 fails if it is missing or stale (CI).
set -euo pipefail

: "${PODS_ROOT:?must run as an Xcode build phase}"
IOS_DIR="$(cd "$PODS_ROOT/.." && pwd)"
APP_ROOT="$(cd "$IOS_DIR/.." && pwd)"

# The env files are user shell code written for React Native's own loader, which sources them
# without -e/-u (scripts/xcode/with-environment.sh): they may read unset variables ($NVM_BIN)
# or run optional commands that fail (a missing nvm.sh). Source them the same way, then
# restore strict mode.
NODE_BINARY="$(command -v node || true)"
source_env() {
  set +eu
  # shellcheck disable=SC1090
  source "$1"
  set -eu
}
if [ -f "$IOS_DIR/.xcode.env" ]; then source_env "$IOS_DIR/.xcode.env"; fi
if [ -f "$IOS_DIR/.xcode.env.local" ]; then source_env "$IOS_DIR/.xcode.env.local"; fi
NODE="$(command -v "${NODE_BINARY:-node}" || true)"
if [ -z "$NODE" ]; then
  echo "error: rnrs: node not found (NODE_BINARY='${NODE_BINARY:-}'); set NODE_BINARY in ios/.xcode.env.local" >&2
  exit 1
fi

exec "$NODE" "$PODS_TARGET_SRCROOT/cli/run.mjs" build --target ios --app "$APP_ROOT" \
  --sdk "$PLATFORM_NAME" --arch "${ARCHS// /,}"
