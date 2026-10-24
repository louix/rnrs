#!/usr/bin/env bash
# Signed Release iphoneos build of the comparison app (on a Mac, inside `nix develop .#ios`; Xcode
# from the system; signing needs the user's GUI session). Same app as build-android.sh: the RN
# 0.88.0 community template, the harness JS (app/), and the packed framework, rnrs benchmark module
# and pure C++ TurboModule library. No app file is edited: signing and the bundle id are xcodebuild
# settings. React Native's prebuilt core (RCT_USE_PREBUILT_RNCORE=1, RCT_USE_RN_DEP=1, as
# scripts/consumer/ios-app.sh), rnrs test hooks off (RNRS_TEST_HOOKS=0), no Rust logging.
#   RNRSCMP_OUT=<dir> RNRS_IOS_TEAM=<team> RNRS_IOS_BUNDLE_ID=<id> RNRS_IOS_DEVICE=<udid> \
#     benchmarks/turbo-compare/build-ios.sh <label>
# The source is a git checkout or a `git archive` tree with a REVISION file. Output in
# $RNRSCMP_OUT/<label>: app/, build/, HelloWorld.app manifest, provenance.json, logs.
set -euo pipefail
LABEL="${1:?usage: build-ios.sh <label>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/benchmarks/turbo-compare"
OUT="${RNRSCMP_OUT:?set RNRSCMP_OUT (outside the source tree)}/$LABEL"
TEMPLATE_SHA256=896707c75d6b0b47aa97041aa605ed45c3329f9204ad6f67064db352c58de19a
[ -e "$OUT" ] && { echo "$OUT exists; pick a new label" >&2; exit 1; }
[ -n "${RNRS_BUNDLE_FEATURES:-}" ] && { echo "RNRS_BUNDLE_FEATURES is set: diagnostics must stay off" >&2; exit 1; }
mkdir -p "$OUT/pack"
exec > >(tee "$OUT/build.log") 2>&1
if [ -f "$ROOT/REVISION" ]; then COMMIT="$(cat "$ROOT/REVISION")"; SOURCE="git archive"; else COMMIT="$(git -C "$ROOT" rev-parse HEAD)"; SOURCE="git checkout"; fi
echo "build $LABEL at $(date -u +%FT%TZ), commit $COMMIT ($SOURCE)"

node "$HERE/gen-cases.mjs" --check
RNRS_PACK_OUT="$OUT/pack" node "$ROOT/scripts/pack.mjs" > "$OUT/pack.log"
node "$ROOT/packages/cli/bin/rnrs.mjs" pack-js "$HERE/rnrs-module"
(cd "$HERE/rnrs-module" && npm pack --ignore-scripts --pack-destination "$OUT/pack" >/dev/null)
(cd "$HERE/cxx-module" && npm pack --ignore-scripts --pack-destination "$OUT/pack" >/dev/null)
(cd "$HERE/nitro-module" && npm pack --ignore-scripts --pack-destination "$OUT/pack" >/dev/null)

TEMPLATE="$OUT/react-native-community-template-0.88.0.tgz"
(cd "$OUT" && npm pack @react-native-community/template@0.88.0 >/dev/null)
echo "$TEMPLATE_SHA256  $TEMPLATE" | shasum -a 256 -c -
APP="$OUT/app"
mkdir -p "$OUT/unpack"
tar -xzf "$TEMPLATE" -C "$OUT/unpack"
cp -R "$OUT/unpack/package/template" "$APP"
for f in _gitignore _watchmanconfig _eslintrc.js _prettierrc.js _bundle ios/_xcode.env; do
  [ -e "$APP/$f" ] && mv "$APP/$f" "$(dirname "$APP/$f")/.$(basename "$f" | sed "s/^_//")"
done
cp "$HERE/app/"*.ts "$HERE/app/App.tsx" "$APP/"
P="$OUT/pack"
(cd "$APP" && npm install --no-audit --no-fund "$P/rnrs-cli-0.1.0.tgz" "$P/rnrs-runtime-0.1.0.tgz" \
  "$P/rnrs-labs-turbo-compare-0.1.0.tgz" "$P/rnrs-bench-cmp-cxx-0.1.0.tgz")
# Nitro Modules core from the registry at the exact version its generated bindings come from.
(cd "$APP" && npm install --no-audit --no-fund --save-exact "$P/rnrs-bench-cmp-nitro-0.1.0.tgz" \
  react-native-nitro-modules@0.37.1)
[ "$(node -p "require('$APP/node_modules/react-native-nitro-modules/package.json').version")" = 0.37.1 ] ||
  { echo "react-native-nitro-modules is not 0.37.1" >&2; exit 1; }
node -e 'const p = require(process.argv[1]); if (p.rustNativeApp?.logging) process.exit(1);' "$APP/package.json" ||
  { echo "rustNativeApp.logging is set" >&2; exit 1; }

export RUSTUP_HOME="${RUSTUP_HOME:?set RUSTUP_HOME outside the source tree}" CARGO_HOME="${CARGO_HOME:?set CARGO_HOME}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.90.0}"
rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal --target aarch64-apple-ios >/dev/null
export RCT_USE_RN_DEP=1 RCT_USE_PREBUILT_RNCORE=1 RNRS_TEST_HOOKS=0
(cd "$APP/ios" && pod install) > "$OUT/pod-install.log" 2>&1 || { tail -40 "$OUT/pod-install.log"; exit 1; }
grep -q "RnrsCmpCxx" "$APP/ios/Podfile.lock" || { echo "RnrsCmpCxx pod not autolinked" >&2; exit 1; }
grep -q "NitroCmp" "$APP/ios/Podfile.lock" || { echo "NitroCmp pod not autolinked" >&2; exit 1; }
# Metro waits forever for watchman at a lowered priority (see scripts/consumer/ios-app.sh).
PATH="$(printf %s "$PATH" | tr : '\n' | while read -r d; do [ -x "$d/watchman" ] || printf '%s:' "$d"; done)"
export PATH="${PATH%:}"
signing=(DEVELOPMENT_TEAM="${RNRS_IOS_TEAM:?}" CODE_SIGN_STYLE=Automatic PRODUCT_BUNDLE_IDENTIFIER="${RNRS_IOS_BUNDLE_ID:?}" -allowProvisioningUpdates)
xb=(-workspace HelloWorld.xcworkspace -scheme HelloWorld -configuration Release -sdk iphoneos
  -destination "id=${RNRS_IOS_DEVICE:?}" -derivedDataPath "$OUT/build")
(cd "$APP/ios" && xcodebuild "${xb[@]}" "${signing[@]}" build > "$OUT/xcodebuild.log" 2>&1) ||
  { grep -E "error:|BUILD FAILED" "$OUT/xcodebuild.log" | head -40; exit 1; }
tail -n 2 "$OUT/xcodebuild.log"
(cd "$APP/ios" && xcodebuild -project Pods/Pods.xcodeproj -target RnrsCmpCxx -configuration Release -sdk iphoneos -showBuildSettings 2>/dev/null |
  grep -E " (GCC_OPTIMIZATION_LEVEL|LLVM_LTO|CONFIGURATION|GCC_PREPROCESSOR_DEFINITIONS) =" > "$OUT/build-settings-RnrsCmpCxx.txt") || true
cat "$OUT/build-settings-RnrsCmpCxx.txt"
# Compile flags per pod target from Xcode's per-target response files (*-common-args.resp, where
# Xcode 26 passes -O and -D flags); the Nitro example and Nitro core must be optimized with NDEBUG.
PODS_BUILD="$OUT/build/Build/Intermediates.noindex/Pods.build/Release-iphoneos"
for target in RnrsCmpCxx NitroCmp NitroModules; do
  ls "$PODS_BUILD/$target.build/Objects-normal/arm64/"*-common-args.resp >/dev/null ||
    { echo "$target: no compile response files" >&2; exit 1; }
  cat "$PODS_BUILD/$target.build/Objects-normal/arm64/"*-common-args.resp | tr ' ' '\n' |
    grep -E '^-O|^-D(N?DEBUG)|^-fstack-protector' | LC_ALL=C sort -u > "$OUT/compile-flags-$target.txt"
  echo "$target: $(tr '\n' ' ' < "$OUT/compile-flags-$target.txt")"
  (cd "$APP/ios" && xcodebuild -project Pods/Pods.xcodeproj -target "$target" -configuration Release -sdk iphoneos -showBuildSettings 2>/dev/null |
    grep -E " (GCC_OPTIMIZATION_LEVEL|LLVM_LTO|CONFIGURATION|GCC_PREPROCESSOR_DEFINITIONS|SWIFT_OPTIMIZATION_LEVEL) =" > "$OUT/build-settings-$target.txt") || true
done
for target in NitroCmp NitroModules; do
  { grep -q -E '^-O(s|2|3|z)$' "$OUT/compile-flags-$target.txt" && grep -q -x -- '-DNDEBUG' "$OUT/compile-flags-$target.txt"; } ||
    { echo "$target pod is not built with optimization and NDEBUG" >&2; exit 1; }
done

BUNDLE="$OUT/build/Build/Products/Release-iphoneos/HelloWorld.app"
BIN="$BUNDLE/HelloWorld"
grep -a -q "__rnrsRuntime" "$BIN" || { echo "no framework bindings in the binary" >&2; exit 1; }
if grep -a -q -E "(invalidate|forceBytesCopyOut|collectGarbage|reload)ForTesting" "$BIN"; then echo "test hooks in the binary" >&2; exit 1; fi
(cd "$BUNDLE" && find . -type f | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$f" "$(shasum -a 256 "$f" | cut -d' ' -f1)"; done) > "$OUT/app-manifest.txt"
cp "$APP/ios/Podfile.lock" "$OUT/Podfile.lock"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
COMMIT="$COMMIT" SOURCE="$SOURCE" OUT="$OUT" APP="$APP" LABEL="$LABEL" BUNDLE_ID="$RNRS_IOS_BUNDLE_ID" \
  BIN_SHA="$(sha "$BIN")" NITROGEN_SHA="$(cd "$HERE/nitro-module" && find nitrogen -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)" MANIFEST_SHA="$(sha "$OUT/app-manifest.txt")" TEMPLATE_SHA="$(sha "$TEMPLATE")" \
  LOCK_SHA="$(sha "$APP/package-lock.json")" PODLOCK_SHA="$(sha "$APP/ios/Podfile.lock")" \
  ARCHIVE_SHA="$(cat "$ROOT/ARCHIVE_SHA256" 2>/dev/null || true)" \
  RUSTC="$(rustc --version)" XCODE="$(xcodebuild -version | tr '\n' ' ')" SDK="$(xcrun --sdk iphoneos --show-sdk-version)" \
  MACOS="$(sw_vers -productVersion) $(sw_vers -buildVersion)" POD="$(pod --version)" \
  node -e '
const fs = require("fs"), path = require("path"), cp = require("child_process");
const e = process.env;
const tarballs = Object.fromEntries(fs.readdirSync(path.join(e.OUT, "pack")).filter((f) => f.endsWith(".tgz"))
  .map((f) => [f, cp.execFileSync("shasum", ["-a", "256", path.join(e.OUT, "pack", f)], { encoding: "utf8" }).split(" ")[0]]));
const ver = (p) => JSON.parse(fs.readFileSync(path.join(e.APP, "node_modules", p, "package.json"), "utf8")).version;
const record = {
  label: e.LABEL, platform: "ios", builtAt: new Date().toISOString(), commit: e.COMMIT, source: e.SOURCE,
  sourceArchiveSha256: e.ARCHIVE_SHA || null, bundleId: e.BUNDLE_ID, binarySha256: e.BIN_SHA, appManifestSha256: e.MANIFEST_SHA,
  template: "@react-native-community/template@0.88.0", templateSha256: e.TEMPLATE_SHA, packageLockSha256: e.LOCK_SHA,
  podfileLockSha256: e.PODLOCK_SHA, tarballs,
  versions: { reactNative: ver("react-native"), codegen: ver("@react-native/codegen"), nitroModules: ver("react-native-nitro-modules"), nitrogen: "0.37.1 (generated output committed in nitro-module/nitrogen)", node: process.version, rustc: e.RUSTC,
    xcode: e.XCODE.trim(), iosSdk: e.SDK, macos: e.MACOS, cocoapods: e.POD },
  prebuiltCore: true, rnrsDiagnostics: false, rnrsTestHooks: false, rustLogging: false,
  cxxBuildSettings: fs.readFileSync(path.join(e.OUT, "build-settings-RnrsCmpCxx.txt"), "utf8").trim().split("\n"),
  compileFlags: Object.fromEntries(["RnrsCmpCxx", "NitroCmp", "NitroModules"].map((t) =>
    [t, fs.readFileSync(path.join(e.OUT, "compile-flags-" + t + ".txt"), "utf8").trim().split("\n")])),
  nitrogenSha256: e.NITROGEN_SHA,
};
fs.writeFileSync(path.join(e.OUT, "provenance.json"), JSON.stringify(record, null, 1) + "\n");
console.log(JSON.stringify({ binarySha256: record.binarySha256, appManifestSha256: record.appManifestSha256, commit: record.commit }));'
echo "app: $BUNDLE"
