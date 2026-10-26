#!/usr/bin/env bash
# CI `ios` job (macOS with Xcode, Node, rustup and CocoaPods, e.g. `nix develop .#ios`, after
# `npm ci --ignore-scripts`): the clean React Native template consumer for the arm64 simulator,
# then its smoke run on a temporary simulator, deleted on exit.
set -euo pipefail
cd "$(dirname "$0")/../.."
RNRS_IOS_SDKS=iphonesimulator RNRS_IOS_SIM_ARCHS=arm64 RNRS_IOS_FIXTURE=smoke \
  RNRS_IOS_SMOKE_DIR=fixtures/scheduler-probe RNRS_TEST_HOOKS=0 \
  bash scripts/consumer/ios-app.sh

# A simulator of the runtime matching the SDK the app was built with.
sdk="$(xcrun --sdk iphonesimulator --show-sdk-version)"
runtime="$(xcrun simctl list runtimes -j | SDK="$sdk" node -e '
  const rs = JSON.parse(require("fs").readFileSync(0, "utf8")).runtimes;
  const r = rs.find((r) => r.platform === "iOS" && r.isAvailable && r.version.startsWith(process.env.SDK));
  if (!r) throw new Error("no available iOS " + process.env.SDK + " simulator runtime");
  process.stdout.write(r.identifier);')"
udid="$(xcrun simctl create rnrs-ci 'iPhone 17' "$runtime")"
trap 'xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true; xcrun simctl delete "$udid"' EXIT
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid"
node scripts/consumer/ios-smoke-sim-test.mjs --device "$udid" --consumer .generated/consumer-ios \
  --commit "$(git rev-parse HEAD)"
