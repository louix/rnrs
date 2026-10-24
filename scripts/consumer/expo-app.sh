#!/usr/bin/env bash
# Fresh Expo SDK 58 consumer: the pristine expo-template-blank-typescript (tarball sha256
# checked) with expo pinned to 58.0.16, `npm install` of the packed @rnrs/cli, @rnrs/runtime and
# @rnrs/example-counter tarballs, and fixtures/expo-consumer/App.tsx. Then `expo prebuild` with
# default autolinking: no config plugin, app.json entry or edit of the generated native trees.
# The script checks that the generated ios/ and android/ equal those of the same template
# without the packages (prebuilt as a reference), and that the RnrsRuntime pod is autolinked.
# On a Mac (inside `nix develop .#ios`) it then runs `pod install` and an unsigned Release
# simulator build; elsewhere it stops after the prebuild checks.
#
#   RNRS_EXPO_OUT=<dir>         output directory (default .generated/consumer-expo; generated
#                              files there are fixture output, never committed)
#   RNRS_EXPO_SIM_ARCHS=arm64   simulator architectures (default arm64)
#   RNRS_EXPO_SKIP_IOS_BUILD=1  stop after prebuild and pod install
# There is no lockfile: the template's ranges resolve at install time. The script requires
# react-native 0.88.0 and react 19.3.0 and records what resolved in <out>/build-record.json.
# Android is prebuild-checked only (autolinking and the generated tree); this script does not
# build it.
# Output: <out>/build/Build/Products/Release-iphonesimulator/HelloWorld.app
# Run it with scripts/consumer/ios-smoke-sim-test.mjs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
C="${RNRS_EXPO_OUT:-$ROOT/.generated/consumer-expo}"
APP="$C/expo-app"
REF="$C/expo-template"
TEMPLATE_VERSION=58.0.25
TEMPLATE="$C/expo-template-blank-typescript-$TEMPLATE_VERSION.tgz"
TEMPLATE_SHA256=317247c9f1d96ca8bbaa2cc935bbe5defd87c6e26319b07461177b156abc9ebd
EXPO_VERSION=58.0.16
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
mkdir -p "$C"
[ -f "$TEMPLATE" ] || (cd "$C" && npm pack "expo-template-blank-typescript@$TEMPLATE_VERSION" >/dev/null)
echo "$TEMPLATE_SHA256  $TEMPLATE" | sha256 -c -
node "$ROOT/scripts/pack.mjs"
P="$ROOT/.generated/pack"

rm -rf "$APP" "$REF" "$C/unpack" "$C/build"
mkdir -p "$C/unpack"
tar -xzf "$TEMPLATE" -C "$C/unpack"
for dir in "$APP" "$REF"; do
  cp -R "$C/unpack/package" "$dir"
  # What create-expo-app does with the template's package metadata and gitignore.
  mv "$dir/gitignore" "$dir/.gitignore"
  node -e 'const f=process.argv[1],p=JSON.parse(require("fs").readFileSync(f));
    for (const k of ["description","license","version","repository"]) delete p[k];
    p.name="helloworld"; p.version="1.0.0"; p.private=true;
    require("fs").writeFileSync(f, JSON.stringify(p,null,2)+"\n")' "$dir/package.json"
  (cd "$dir" && npm install --no-audit --no-fund "expo@$EXPO_VERSION" >/dev/null)
done
cp "$ROOT/fixtures/expo-consumer/App.tsx" "$APP/"
(cd "$APP" && npm install --no-audit --no-fund "$P/rnrs-cli-0.2.0.tgz" "$P/rnrs-runtime-0.2.0.tgz" "$P/rnrs-example-counter-0.2.0.tgz" >/dev/null)
(cd "$APP" && node -e 'const fs=require("fs"),out=process.argv[1],v={};
  for (const n of ["expo","react","react-native","expo-modules-core","expo-modules-autolinking","@expo/cli","@rnrs/runtime","@rnrs/example-counter"])
    v[n]=require(require.resolve(n+"/package.json",{paths:[process.cwd(),process.cwd()+"/node_modules/expo"]})).version;
  console.log("resolved: "+Object.entries(v).map(([n,x])=>n+"@"+x).join(" "));
  const want={"expo":process.argv[2],"react-native":"0.88.0","react":"19.3.0"};
  const bad=Object.entries(want).filter(([n,x])=>v[n]!==x);
  if (bad.length) { console.error("unexpected versions: "+bad.map(([n,x])=>n+" "+v[n]+" (want "+x+")").join(", ")); process.exit(1); }
  fs.writeFileSync(out, JSON.stringify({template:"expo-template-blank-typescript@"+process.argv[3], templateSha256:process.argv[4], resolved:v}, null, 2)+"\n")' \
  "$C/build-record.json" "$EXPO_VERSION" "$TEMPLATE_VERSION" "$TEMPLATE_SHA256")

# Default autolinking sees the framework package on both platforms (no config plugin).
for platform in ios android; do
  (cd "$APP" && npx expo-modules-autolinking react-native-config --json --platform "$platform") > "$C/autolinking-$platform.json"
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1]));
    const d=c.dependencies["@rnrs/runtime"]?.platforms?.[process.argv[2]];
    if (!d) { console.error("@rnrs/runtime is not autolinked for "+process.argv[2]); process.exit(1); }
    console.log(process.argv[2]+" autolinking: @rnrs/runtime "+JSON.stringify(d).slice(0,200))' "$C/autolinking-$platform.json" "$platform"
done

# Prebuild both apps (CI=1: non-interactive), without installing pods yet.
for dir in "$REF" "$APP"; do (cd "$dir" && CI=1 npx expo prebuild --no-install --clean >/dev/null); done
echo "checking that the generated native trees equal the template's"
diff -r -q -x Pods -x Podfile.lock -x build -x .gradle -x .cxx "$REF/ios" "$APP/ios"
diff -r -q -x build -x .gradle -x .cxx "$REF/android" "$APP/android"
extra=$(find "$APP" \( -path "$APP/node_modules" -o -path "$APP/android" -o -path "$APP/ios" \) -prune -o \
  \( -name Cargo.toml -o -name '*.rs' -o -name '*.cpp' -o -name '*.mm' -o -name '*.m' -o -name '*.swift' -o -name '*.kt' -o -name '*.java' \) -print)
if [ -n "$extra" ]; then echo "unexpected native or Rust sources in the app: $extra" >&2; exit 1; fi
echo "generated ios/ and android/ unchanged by the packages"

[ "$(uname)" = Darwin ] || { echo "not macOS: stopping after prebuild"; exit 0; }

# Rust toolchain for the framework's script phase, project-local (as in ios-app.sh).
export RUSTUP_HOME="${RUSTUP_HOME:-$ROOT/.generated/rustup}"
export CARGO_HOME="${CARGO_HOME:-$ROOT/.generated/cargo}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.90.0}"
rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal --target aarch64-apple-ios,aarch64-apple-ios-sim,x86_64-apple-ios >/dev/null
# The generated Podfile chooses React Native's prebuilt core itself; the environment adds nothing.
unset RCT_USE_RN_DEP RCT_USE_PREBUILT_RNCORE RNRS_TEST_HOOKS
(cd "$APP/ios" && pod install > "$C/pod-install.log")
RUNTIME_VERSION="$(node -p "require('$ROOT/packages/runtime/package.json').version")"
grep -Fq "RnrsRuntime ($RUNTIME_VERSION)" "$APP/ios/Podfile.lock" || { echo "RnrsRuntime pod not autolinked" >&2; exit 1; }
grep -E "^  - (RnrsRuntime|React-Core|ExpoModulesCore|hermes-engine) " "$APP/ios/Podfile.lock" | sort -u
[ "${RNRS_EXPO_SKIP_IOS_BUILD:-0}" = 1 ] && exit 0

# Metro without watchman (see ios-app.sh).
PATH="$(printf %s "$PATH" | tr : '\n' | while read -r d; do [ -x "$d/watchman" ] || printf '%s:' "$d"; done)"
export PATH="${PATH%:}"
ws=$(cd "$APP/ios" && ls -d *.xcworkspace); scheme="${ws%.xcworkspace}"
(cd "$APP/ios" && xcodebuild -workspace "$ws" -scheme "$scheme" -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath "$C/build" CODE_SIGNING_ALLOWED=NO \
  ARCHS="${RNRS_EXPO_SIM_ARCHS:-arm64}" ONLY_ACTIVE_ARCH=NO build > "$C/xcodebuild-iphonesimulator.log" 2>&1) ||
  { grep -E "error:|BUILD FAILED" "$C/xcodebuild-iphonesimulator.log" | head -40; exit 1; }
tail -n 3 "$C/xcodebuild-iphonesimulator.log"
app=$(ls -d "$C"/build/Build/Products/Release-iphonesimulator/*.app)
bin="$app/$(plutil -extract CFBundleExecutable raw "$app/Info.plist")"
grep -a -q "__rnrsRuntime" "$bin" || { echo "$bin: no framework bindings found" >&2; exit 1; }
sum=$(shasum -a 256 "$bin" | cut -d' ' -f1)
node -e 'const fs=require("fs"),[f,app,id,sum]=process.argv.slice(1),r=JSON.parse(fs.readFileSync(f));
  r.iosSimulatorApp={app,bundleId:id,binarySha256:sum}; fs.writeFileSync(f, JSON.stringify(r,null,2)+"\n")' \
  "$C/build-record.json" "$app" "$(plutil -extract CFBundleIdentifier raw "$app/Info.plist")" "$sum"
echo "app $app bundle id $(plutil -extract CFBundleIdentifier raw "$app/Info.plist") sha256 $sum"
