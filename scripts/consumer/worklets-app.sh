#!/usr/bin/env bash
# Worklets lab app (inside `nix develop`; docs/research/worklets-poc-plan.md). A throwaway RN
# 0.88.0 community-template app with JS-only changes (fixtures/worklets-lab: App.tsx,
# GestureLab.tsx, smoke.ts, babel.config.js), the packed @rnrs/runtime and lab probe module, and the pinned
# react-native-worklets 0.13.0, react-native-reanimated 4.7.1 and react-native-gesture-handler
# 3.3.0 (exact versions, verified after install). Built with the native test hooks
# (RNR_TEST_HOOKS=1). The app's android/ and ios/ trees must stay byte-identical to the
# template's. @rnrs/runtime itself has no dependency on any of these packages.
# Output: .generated/consumer/worklets-lab/android/app/build/outputs/apk/release/app-release.apk
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME=worklets-lab
C="$ROOT/.generated/consumer"
APP="$C/$NAME"
REF="$C/$NAME-template"
TEMPLATE="$C/react-native-community-template-0.88.0.tgz"
PINS=(react-native-worklets@0.13.0 react-native-reanimated@4.7.1 react-native-gesture-handler@3.3.0)
mkdir -p "$C"
[ -f "$TEMPLATE" ] || (cd "$C" && npm pack @react-native-community/template@0.88.0 >/dev/null)
echo "template sha256: $(sha256sum "$TEMPLATE" | cut -d' ' -f1)"
node "$ROOT/scripts/pack.mjs"

rm -rf "$APP" "$REF" "$C/unpack-$NAME" "$C/$NAME.build.json"
mkdir -p "$C/unpack-$NAME"
tar -xzf "$TEMPLATE" -C "$C/unpack-$NAME"
for dir in "$APP" "$REF"; do
  cp -r "$C/unpack-$NAME/package/template" "$dir"
  for f in _gitignore _watchmanconfig _eslintrc.js _prettierrc.js _bundle; do
    [ -e "$dir/$f" ] && mv "$dir/$f" "$dir/.${f#_}"
  done
done

cp "$ROOT/fixtures/worklets-lab/App.tsx" "$ROOT/fixtures/worklets-lab/GestureLab.tsx" "$ROOT/fixtures/worklets-lab/smoke.ts" "$ROOT/fixtures/worklets-lab/babel.config.js" "$APP/"
(cd "$APP" && npm install --no-audit --no-fund --save-exact "${PINS[@]}" \
  "$C/../pack/rnrs-cli-0.1.0.tgz" "$C/../pack/rnrs-runtime-0.1.0.tgz" "$C/../pack/rnrs-labs-worklets-probe-0.1.0.tgz")
for pin in "${PINS[@]}"; do
  name="${pin%@*}" want="${pin##*@}"
  got=$(node -p "require('$APP/node_modules/$name/package.json').version")
  [ "$got" = "$want" ] || { echo "$name: installed $got, pinned $want" >&2; exit 1; }
done
# @rnrs/runtime must not depend on worklets, Reanimated or RNGH.
if node -e "const p=require('$APP/node_modules/@rnrs/runtime/package.json');const d={...p.dependencies,...p.peerDependencies,...p.optionalDependencies};process.exit(Object.keys(d).some(k=>/worklets|reanimated|gesture-handler/.test(k))?0:1)"; then
  echo "@rnrs/runtime declares a worklets/Reanimated/RNGH dependency" >&2; exit 1
fi

export RUSTUP_HOME="${RUSTUP_HOME:-$ROOT/.generated/rustup}"
export CARGO_HOME="${CARGO_HOME:-$ROOT/.generated/cargo}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.90.0}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$ROOT/.generated/gradle}"
# A fresh isolated toolchain lacks the Android target (idempotent when present).
rustup target add aarch64-linux-android >/dev/null
export RNR_TEST_HOOKS=1
(cd "$APP/android" && ./gradlew --no-daemon --init-script "$ROOT/scripts/consumer/nix-sdk.init.gradle" assembleRelease -PreactNativeArchitectures=arm64-v8a)

echo "checking that the app's native trees equal the template's"
for tree in android ios; do
  diff -r -q --exclude=build --exclude=.gradle --exclude=.cxx --exclude=.kotlin --exclude=local.properties "$REF/$tree" "$APP/$tree"
done
unzip -p "$APP/android/app/build/outputs/apk/release/app-release.apk" lib/arm64-v8a/librnr.so > "$C/librnr-$NAME.so"
grep -a -q "routeProbeForTesting" "$C/librnr-$NAME.so" || { echo "librnr.so lacks the test hooks" >&2; exit 1; }
versions=$(cd "$APP" && node -p "JSON.stringify(Object.fromEntries(['react-native','react-native-worklets','react-native-reanimated','react-native-gesture-handler'].map(n=>[n,require('./node_modules/'+n+'/package.json').version])))")
cat > "$C/$NAME.build.json" <<JSON
{"template": "@react-native-community/template@0.88.0", "templateSha256": "$(sha256sum "$TEMPLATE" | cut -d' ' -f1)",
 "nativeTreesIdenticalToTemplate": ["android", "ios"], "testHooks": true, "versions": $versions}
JSON
echo "APK: $APP/android/app/build/outputs/apk/release/app-release.apk"
