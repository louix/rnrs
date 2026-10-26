#!/usr/bin/env bash
# Clean React Native iOS consumer (on a Mac, inside `nix develop .#ios`; Xcode from the
# system): the pristine RN 0.88.0 community template, plus only JS changes (App.tsx, the
# device test, the lab's shared suites with imports pointed at the installed packages, the
# vectors JSON) and `npm install` of the packed tarballs. No native file of the app is edited:
# autolinking adds the RnrsRuntime pod, whose script phase builds the app's Rust bundle, and
# signing identity is passed to xcodebuild as build settings. The script verifies that ios/
# and android/ equal the template's afterwards (ignoring CocoaPods' generated outputs).
#
#   RNRS_IOS_SDKS="iphoneos iphonesimulator"  SDKs to build (default: both)
#   RNRS_IOS_TEAM=<team id>                    sign the device build (automatic signing,
#   RNRS_IOS_BUNDLE_ID=<bundle id>             -allowProvisioningUpdates); unsigned otherwise
#   RNRS_IOS_DEVICE=<UDID>                     build for that device (registers it with the team)
#   RNRS_IOS_OUT=<dir>                         output directory (default .generated/consumer-ios)
#   RNRS_APP_LOGGING=<json>                    rustNativeApp.logging for the app (Rust logging)
#   RNRS_IOS_FIXTURE=modules                   the http/kv consumer (fixtures/ios-modules-consumer,
#                                             @rnrs/example-http and @rnrs/example-kv; run by
#                                             ios-modules-test.mjs) instead of counter/blake3/meter/values
#   RNRS_IOS_FIXTURE=paddle-game               the paddle game (fixtures/paddle-game: App.tsx, smoke.ts,
#                                             game.ts, contention.ts) with @rnrs/surface and
#                                             @rnrs/example-vello2d
#   RNRS_IOS_FIXTURE=surface-s3                the C1 S3 harness (fixtures/surface-s3/App.tsx with the paddle
#                                             game.ts; driven by scripts/consumer/ios-s3-sim-test.mjs)
#   RNRS_IOS_FIXTURE=touch-probe               the touch-input harness (fixtures/touch-probe-ios/App.tsx) with
#                                             @rnrs/surface and @rnrs/labs-touch-probe (no renderer, no GPU);
#                                             driven by scripts/consumer/ios-touch-sim-test.mjs
#   RNRS_IOS_FIXTURE=bevy                      the Bevy example (fixtures/bevy-consumer: App.tsx, smoke.ts) with
#                                             @rnrs/surface and @rnrs/example-bevy3d; needs RUSTUP_TOOLCHAIN=1.97.1
#                                             (Bevy 0.20 MSRV); run by scripts/consumer/ios-bevy-sim-test.mjs
#   RNRS_IOS_FIXTURE=triangle                  the rnrs::gpu triangle (fixtures/triangle-consumer: App.tsx, smoke.ts)
#                                             with @rnrs/surface and @rnrs/labs-webgpu-triangle; run by
#                                             scripts/consumer/ios-triangle-sim-test.mjs
#   RNRS_IOS_FIXTURE=worklets-lab              the Worklets lab (fixtures/worklets-lab: App.tsx, GestureLab.tsx, smoke.ts,
#                                             babel.config.js) with @rnrs/labs-worklets-probe and the pins of
#                                             scripts/consumer/worklets-app.sh
#   RNRS_IOS_FIXTURE=smoke                    a JS smoke fixture: RNRS_IOS_SMOKE_DIR's smoke.ts (repo-relative
#                                             directory exporting runSmoke(); e.g. fixtures/scheduler-probe) under
#                                             fixtures/consumer/ios/SmokeApp.tsx, with @rnrs/<m> for each m in
#                                             RNRS_IOS_SMOKE_MODULES (default example-counter); run by
#                                             scripts/consumer/ios-smoke-sim-test.mjs
#   RNRS_IOS_SKIP_RELOCATED=1                  lab repeat runs only (e.g. a C1 S3 rerun on a disk budget): skip
#                                             the relocated --locked copy below and say so; the
#                                             default runs every packaging check
#   RNRS_IOS_SIM_ARCHS=arm64                   simulator architectures (default: Xcode's, arm64 and x86_64)
#   RNRS_IOS_LOCAL_NETWORK_USAGE=<text>        NSLocalNetworkUsageDescription, as build settings
#                                             (GENERATE_INFOPLIST_FILE merges it into the app's
#                                             Info.plist; no file is edited). iOS gates LAN
#                                             connections behind this permission. Like every
#                                             xcodebuild command-line setting, both apply to all
#                                             targets of the build (the pods too), not only the
#                                             app; only the app bundle's Info.plist is checked.
#   RNRS_TEST_HOOKS=0                          build the default package, without the native test
#                                             hooks (the device test then runs only the smoke)
# Output: .generated/consumer-ios/build/Build/Products/Release-<sdk>/HelloWorld.app
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
C="${RNRS_IOS_OUT:-$ROOT/.generated/consumer-ios}"
APP="$C/rn-app"
REF="$C/rn-template"
TEMPLATE="$C/react-native-community-template-0.88.0.tgz"
TEMPLATE_SHA256=896707c75d6b0b47aa97041aa605ed45c3329f9204ad6f67064db352c58de19a
SDKS="${RNRS_IOS_SDKS:-iphoneos iphonesimulator}"
mkdir -p "$C"
[ -f "$TEMPLATE" ] || (cd "$C" && npm pack @react-native-community/template@0.88.0 >/dev/null)
echo "$TEMPLATE_SHA256  $TEMPLATE" | shasum -a 256 -c -
node "$ROOT/scripts/pack.mjs"

rm -rf "$APP" "$REF" "$C/unpack"
mkdir -p "$C/unpack"
tar -xzf "$TEMPLATE" -C "$C/unpack"
for dir in "$APP" "$REF"; do
  cp -R "$C/unpack/package/template" "$dir"
  # What `react-native init` does with the template's dotfiles.
  for f in _gitignore _watchmanconfig _eslintrc.js _prettierrc.js _bundle ios/_xcode.env; do
    [ -e "$dir/$f" ] && mv "$dir/$f" "$(dirname "$dir/$f")/.$(basename "$f" | sed "s/^_//")"
  done
done

# The app's own (JS) changes.
# App.tsx, the device test, the smoke test, the vectors, and the lab's shared suites with
# imports pointed at the installed packages (the same files npm run typecheck checks).
P="$ROOT/.generated/pack"
if [ "${RNRS_IOS_FIXTURE:-}" = surface-s3 ]; then
  cp "$ROOT/fixtures/surface-s3/App.tsx" "$ROOT/fixtures/paddle-game/game.ts" "$APP/"
  (cd "$APP" && npm install --no-audit --no-fund "$P/rnrs-cli-0.3.0.tgz" "$P/rnrs-runtime-0.3.0.tgz" "$P/rnrs-surface-0.3.0.tgz" "$P/rnrs-example-vello2d-0.3.0.tgz")
elif [ "${RNRS_IOS_FIXTURE:-}" = paddle-game ]; then
  cp "$ROOT/fixtures/paddle-game/App.tsx" "$ROOT/fixtures/paddle-game/smoke.ts" "$APP/"
  source "$ROOT/scripts/consumer/fixture-files.sh"
  copy_fixture_files "$ROOT/fixtures/paddle-game" "$APP" "game.ts contention.ts"
  (cd "$APP" && npm install --no-audit --no-fund "$P/rnrs-cli-0.3.0.tgz" "$P/rnrs-runtime-0.3.0.tgz" "$P/rnrs-surface-0.3.0.tgz" "$P/rnrs-example-vello2d-0.3.0.tgz")
elif [ "${RNRS_IOS_FIXTURE:-}" = touch-probe ]; then
  cp "$ROOT/fixtures/touch-probe-ios/App.tsx" "$APP/"
  (cd "$APP" && npm install --no-audit --no-fund "$P/rnrs-cli-0.3.0.tgz" "$P/rnrs-runtime-0.3.0.tgz" "$P/rnrs-surface-0.3.0.tgz" "$P/rnrs-labs-touch-probe-0.3.0.tgz")
elif [ "${RNRS_IOS_FIXTURE:-}" = bevy ]; then
  cp "$ROOT/fixtures/bevy-consumer/App.tsx" "$ROOT/fixtures/bevy-consumer/smoke.ts" "$APP/"
  (cd "$APP" && npm install --no-audit --no-fund "$P/rnrs-cli-0.3.0.tgz" "$P/rnrs-runtime-0.3.0.tgz" "$P/rnrs-surface-0.3.0.tgz" "$P/rnrs-example-bevy3d-0.3.0.tgz")
elif [ "${RNRS_IOS_FIXTURE:-}" = triangle ]; then
  cp "$ROOT/fixtures/triangle-consumer/App.tsx" "$ROOT/fixtures/triangle-consumer/smoke.ts" "$APP/"
  (cd "$APP" && npm install --no-audit --no-fund "$P/rnrs-cli-0.3.0.tgz" "$P/rnrs-runtime-0.3.0.tgz" "$P/rnrs-surface-0.3.0.tgz" "$P/rnrs-labs-webgpu-triangle-0.3.0.tgz")
elif [ "${RNRS_IOS_FIXTURE:-}" = worklets-lab ]; then
  cp "$ROOT/fixtures/worklets-lab/App.tsx" "$ROOT/fixtures/worklets-lab/GestureLab.tsx" "$ROOT/fixtures/worklets-lab/smoke.ts" \
    "$ROOT/fixtures/worklets-lab/babel.config.js" "$APP/"
  PINS=(react-native-worklets@0.13.0 react-native-reanimated@4.7.1 react-native-gesture-handler@3.3.0)
  (cd "$APP" && npm install --no-audit --no-fund --save-exact "${PINS[@]}" \
    "$P/rnrs-cli-0.3.0.tgz" "$P/rnrs-runtime-0.3.0.tgz" "$P/rnrs-labs-worklets-probe-0.3.0.tgz")
  for pin in "${PINS[@]}"; do
    name="${pin%@*}" want="${pin##*@}"
    got=$(node -p "require('$APP/node_modules/$name/package.json').version")
    [ "$got" = "$want" ] || { echo "$name: installed $got, pinned $want" >&2; exit 1; }
  done
elif [ "${RNRS_IOS_FIXTURE:-}" = smoke ]; then
  cp "$ROOT/${RNRS_IOS_SMOKE_DIR:?set RNRS_IOS_SMOKE_DIR with RNRS_IOS_FIXTURE=smoke}/smoke.ts" "$APP/smoke.ts"
  cp "$ROOT/fixtures/consumer/ios/SmokeApp.tsx" "$APP/App.tsx"
  smoke_pkgs=()
  for m in ${RNRS_IOS_SMOKE_MODULES:-example-counter}; do smoke_pkgs+=("$P/rnrs-$m-0.3.0.tgz"); done
  (cd "$APP" && npm install --no-audit --no-fund "$P/rnrs-cli-0.3.0.tgz" "$P/rnrs-runtime-0.3.0.tgz" "${smoke_pkgs[@]}")
elif [ "${RNRS_IOS_FIXTURE:-}" = modules ]; then
  node "$ROOT/scripts/consumer/ios-fixture.mjs" --modules "$APP"
  (cd "$APP" && npm install --no-audit --no-fund "$P/rnrs-cli-0.3.0.tgz" "$P/rnrs-runtime-0.3.0.tgz" "$P/rnrs-example-http-0.3.0.tgz" "$P/rnrs-example-kv-0.3.0.tgz")
else
  node "$ROOT/scripts/consumer/ios-fixture.mjs" "$APP"
  (cd "$APP" && npm install --no-audit --no-fund "$P/rnrs-cli-0.3.0.tgz" "$P/rnrs-runtime-0.3.0.tgz" "$P/rnrs-example-blake3-0.3.0.tgz" \
    "$P/rnrs-example-counter-0.3.0.tgz" "$P/rnrs-labs-meter-0.3.0.tgz" "$P/rnrs-labs-values-0.3.0.tgz")
fi
# Optional Rust logging configuration (RNRS_APP_LOGGING, JSON for rustNativeApp.logging).
if [ -n "${RNRS_APP_LOGGING:-}" ]; then node "$ROOT/scripts/consumer/app-logging.mjs" "$APP" "$RNRS_APP_LOGGING"; fi
# Modules compiled from source, rustNativeApp.sourceBuild (RNRS_SOURCE_BUILD: "*", the default,
# or a comma-separated list of package names). This script builds and checks source bundles
# (the app's Cargo lock below), so it needs at least one.
node "$ROOT/scripts/consumer/source-build.mjs" "$APP" "${RNRS_SOURCE_BUILD-*}"


# Rust toolchain for the framework's script phase (cargo with the iOS targets), project-local.
export RUSTUP_HOME="${RUSTUP_HOME:-$ROOT/.generated/rustup}"
export CARGO_HOME="${CARGO_HOME:-$ROOT/.generated/cargo}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.90.0}"
rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal --target aarch64-apple-ios,aarch64-apple-ios-sim,x86_64-apple-ios >/dev/null

# React Native's supported prebuilt core and dependencies (pod install environment, not an
# app edit; the Expo SDK 58 Podfile sets the same two variables unless
# ios.buildReactNativeFromSource). Adopted for 0.83.1, whose source-built fmt 11.0.2 Xcode 26.4+
# clang rejects (facebook/react-native#55601, fixed in 0.84); 0.88 source builds are untested.
export RCT_USE_RN_DEP="${RCT_USE_RN_DEP:-1}" RCT_USE_PREBUILT_RNCORE="${RCT_USE_PREBUILT_RNCORE:-1}"
# The device test drives the framework's native test hooks; the default package omits them.
# (RNRS_TEST_HOOKS=0 builds the default package instead.)
export RNRS_TEST_HOOKS="${RNRS_TEST_HOOKS:-1}"
(cd "$APP/ios" && pod install)
# The reference is the untouched template after the same `npm install` and `pod install`:
# React Native's own pod install edits ios/ (RCTNewArchEnabled in Info.plist, privacy
# manifest aggregation and build settings in the project, .xcode.env.local), so any
# difference left below comes from the added packages.
(cd "$REF" && npm install --no-audit --no-fund >/dev/null && cd ios && pod install >/dev/null)

# Metro (the template's "Bundle React Native code and images" phase) uses watchman when it is
# on PATH. Watchman refuses to start at a lowered scheduling priority (background or nohup
# sessions: "running at a lower than normal priority"), and Metro then waits indefinitely
# for `watch-project`. Keep it off PATH so Metro crawls the files itself (build environment only, not an app edit).
PATH="$(printf %s "$PATH" | tr : '\n' | while read -r d; do [ -x "$d/watchman" ] || printf '%s:' "$d"; done)"
export PATH="${PATH%:}"

signing=(CODE_SIGNING_ALLOWED=NO)
plist=()
if [ -n "${RNRS_IOS_LOCAL_NETWORK_USAGE:-}" ]; then
  plist=(GENERATE_INFOPLIST_FILE=YES INFOPLIST_KEY_NSLocalNetworkUsageDescription="$RNRS_IOS_LOCAL_NETWORK_USAGE")
fi
for sdk in $SDKS; do
  if [ "$sdk" = iphoneos ]; then
    # A specific device (its UDID) lets automatic signing register it with the team.
    dest="${RNRS_IOS_DEVICE:+id=$RNRS_IOS_DEVICE}"; dest="${dest:-generic/platform=iOS}"
    if [ -n "${RNRS_IOS_TEAM:-}" ]; then
      signing=(DEVELOPMENT_TEAM="$RNRS_IOS_TEAM" CODE_SIGN_STYLE=Automatic PRODUCT_BUNDLE_IDENTIFIER="${RNRS_IOS_BUNDLE_ID:?set RNRS_IOS_BUNDLE_ID with RNRS_IOS_TEAM}" -allowProvisioningUpdates)
    fi
  else
    dest='generic/platform=iOS Simulator'
    signing=(CODE_SIGNING_ALLOWED=NO)
    # Only the requested simulator slices (e.g. arm64 on Apple silicon, to save time and disk).
    if [ -n "${RNRS_IOS_SIM_ARCHS:-}" ]; then signing+=(ARCHS="$RNRS_IOS_SIM_ARCHS" ONLY_ACTIVE_ARCH=NO); fi
  fi
  (cd "$APP/ios" && xcodebuild -workspace HelloWorld.xcworkspace -scheme HelloWorld -configuration Release -sdk "$sdk" \
    -destination "$dest" -derivedDataPath "$C/build" "${signing[@]}" ${plist[@]+"${plist[@]}"} build > "$C/xcodebuild-$sdk.log" 2>&1) ||
    { grep -E "error:|BUILD FAILED" "$C/xcodebuild-$sdk.log" | head -40; exit 1; }
  tail -n 3 "$C/xcodebuild-$sdk.log"
done
[ -f "$APP/rnrs-ios.Cargo.lock" ] || { echo "the first build did not create rnrs-ios.Cargo.lock" >&2; exit 1; }

echo "checking that the app's native trees equal the template's (both after pod install)"
# Pods/, Podfile.lock and the workspace are pod install outputs that list the dependencies.
diff -r -q -x Pods -x Podfile.lock -x HelloWorld.xcworkspace -x build -x xcuserdata -x project.pbxproj "$REF/ios" "$APP/ios"
# React Native's privacy manifest aggregation adds a PBXBuildFile with a random ID (and so a
# different sort position) on every pod install; apart from that ID the projects must match.
pbx() { sed -E 's/[0-9A-F]{24} (\/\* PrivacyInfo\.xcprivacy in Resources \*\/)/<id> \1/' "$1/ios/HelloWorld.xcodeproj/project.pbxproj" | sort; }
diff <(pbx "$REF") <(pbx "$APP")
diff -r -q -x build -x .gradle -x .cxx "$REF/android" "$APP/android"
extra=$(find "$APP" \( -path "$APP/node_modules" -o -path "$APP/.rnrs" -o -path "$APP/android" -o -path "$APP/ios" \) -prune -o \
  \( -name Cargo.toml -o -name '*.rs' -o -name '*.cpp' -o -name '*.mm' -o -name '*.m' -o -name '*.swift' -o -name '*.kt' -o -name '*.java' \) -print)
if [ -n "$extra" ]; then echo "unexpected native or Rust sources in the app: $extra" >&2; exit 1; fi
echo "native trees unchanged; apps under $C/build/Build/Products/"

# The linked app binaries contain the native test hooks exactly when they were requested.
for sdk in $SDKS; do
  bin="$C/build/Build/Products/Release-$sdk/HelloWorld.app/HelloWorld"
  grep -a -q "__rnrsRuntime" "$bin" || { echo "$bin: no framework bindings found" >&2; exit 1; }
  hooks=$({ grep -a -o -E "(invalidate|forceBytesCopyOut|collectGarbage|reload)ForTesting" "$bin" || true; } | sort -u | tr "\n" " ")
  if [ "$RNRS_TEST_HOOKS" = 1 ]; then
    [ -n "$hooks" ] || { echo "$bin: RNRS_TEST_HOOKS=1 but no test hooks in the binary" >&2; exit 1; }
  else
    [ -z "$hooks" ] || { echo "$bin: default build contains test hooks: $hooks" >&2; exit 1; }
  fi
  if [ -n "${RNRS_IOS_LOCAL_NETWORK_USAGE:-}" ]; then
    plutil -extract NSLocalNetworkUsageDescription raw "$(dirname "$bin")/Info.plist" >/dev/null ||
      { echo "$bin: NSLocalNetworkUsageDescription missing from the built Info.plist" >&2; exit 1; }
  fi
  echo "$sdk binary: test hooks [${hooks:-none}] (RNRS_TEST_HOOKS=$RNRS_TEST_HOOKS), sha256 $(shasum -a 256 "$bin" | cut -d" " -f1)"
done

# The lock is portable: a relocated copy (another absolute path, no .rnrs/ or Pods) builds the
# bundle --locked with the lock unchanged, and --locked refuses a missing lock.
if [ "${RNRS_IOS_SKIP_RELOCATED:-0}" = 1 ]; then
  echo "relocated --locked check SKIPPED (RNRS_IOS_SKIP_RELOCATED=1, lab repeat run): not tested by this build"
  exit 0
fi
MOVED="$C/rn-app-moved"
rm -rf "$MOVED" && mkdir -p "$MOVED"
(cd "$APP" && tar --exclude=./.rnrs --exclude=./ios/Pods --exclude=./ios/build -cf - .) | (cd "$MOVED" && tar -xf -)
RNRS="$MOVED/node_modules/@rnrs/cli/bin/rnrs.mjs"
node "$RNRS" build --target ios --app "$MOVED" --sdk iphoneos --arch arm64 --locked
cmp "$APP/rnrs-ios.Cargo.lock" "$MOVED/rnrs-ios.Cargo.lock"
node "$RNRS" lock --check --target ios --app "$MOVED"
rm "$MOVED/rnrs-ios.Cargo.lock"
if node "$RNRS" build --target ios --app "$MOVED" --sdk iphoneos --locked > "$C/locked-missing.log" 2>&1; then
  echo "--locked accepted a missing lock" >&2; exit 1
fi
grep -q "rnrs-ios.Cargo.lock is missing" "$C/locked-missing.log"
echo "relocated consumer built --locked with the lock unchanged; a missing lock was refused"
