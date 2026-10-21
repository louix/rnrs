#!/usr/bin/env bash
# Clean React Native consumer (inside `nix develop`): the pristine RN 0.88.0 community
# template, plus only JS changes (App.tsx, smoke.ts, the vectors JSON) and `npm install` of
# the packed tarballs. No native file of the app is edited; this script verifies that its
# android/ and ios/ trees are byte-identical to the template after the build.
# Output: .generated/consumer/rn-app/android/app/build/outputs/apk/release/app-release.apk
# FIXTURE (fixtures/<FIXTURE>: App.tsx, smoke.ts) and MODULES (packed rnrs-<m>-0.1.0
# tarballs; MODULES="" for none) select the app; defaults: the blake3 + counter consumer.
# EXTRA_TARBALLS adds tarballs by absolute path (newline-separated). PACKS adds other packed
# tarballs (file stems under .generated/pack, e.g. rnrs-surface).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE="${FIXTURE:-consumer}"
MODULES="${MODULES-example-blake3 example-counter}"
NAME="${NAME:-rn-app}"
C="$ROOT/.generated/consumer"
APP="$C/$NAME"
REF="$C/$NAME-template"
TEMPLATE="$C/react-native-community-template-0.88.0.tgz"
mkdir -p "$C"
[ -f "$TEMPLATE" ] || (cd "$C" && npm pack @react-native-community/template@0.88.0 >/dev/null)
echo "template sha256: $(sha256sum "$TEMPLATE" | cut -d' ' -f1)"
# Provenance of the sources packed below (recorded in the build record): the commit and the
# full working-tree state, including staged and untracked files.
SOURCE_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
SOURCE_STATUS="$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)"
node "$ROOT/scripts/pack.mjs"

rm -rf "$APP" "$REF" "$C/unpack" "$C/$NAME.build.json"
mkdir -p "$C/unpack"
tar -xzf "$TEMPLATE" -C "$C/unpack"
for dir in "$APP" "$REF"; do
  cp -r "$C/unpack/package/template" "$dir"
  # What `react-native init` does with the template's dotfiles.
  for f in _gitignore _watchmanconfig _eslintrc.js _prettierrc.js _bundle; do
    [ -e "$dir/$f" ] && mv "$dir/$f" "$dir/.${f#_}"
  done
done

# ANDROID_MIN_SDK (opt-in, e.g. 26 for fixtures/bevy-consumer, packages/bevy3d/README.md): the one app
# build-configuration edit this script makes. It replaces the template's single
# `minSdkVersion = 24` (android/build.gradle ext, which the framework's Gradle also reads for
# its NDK clang, Cargo linker and CMake API level). The build record then lists the android/
# diff from the template instead of claiming an unchanged tree.
ANDROID_DIFF=""
if [ -n "${ANDROID_MIN_SDK:-}" ]; then
  [[ "$ANDROID_MIN_SDK" =~ ^[0-9]+$ ]] && [ "$ANDROID_MIN_SDK" -gt 24 ] || { echo "ANDROID_MIN_SDK must be an integer above the template's 24" >&2; exit 1; }
  [ "$(grep -c "^        minSdkVersion = 24$" "$APP/android/build.gradle")" = 1 ] || { echo "the template's android/build.gradle does not have exactly one minSdkVersion = 24" >&2; exit 1; }
  sed -i "s/^        minSdkVersion = 24$/        minSdkVersion = $ANDROID_MIN_SDK/" "$APP/android/build.gradle"
  ANDROID_DIFF="$(diff -u "$REF/android/build.gradle" "$APP/android/build.gradle" | tail -n +3 || true)"
fi
# The app's own (JS) changes.
cp "$ROOT/fixtures/$FIXTURE/App.tsx" "$ROOT/fixtures/$FIXTURE/smoke.ts" "$APP/"
# FIXTURE_FILES: further JS/TS sources of the fixture (space-separated plain names, e.g.
# "game.ts"), validated and copied by scripts/consumer/fixture-files.sh; hashed in the build record.
source "$ROOT/scripts/consumer/fixture-files.sh"
copy_fixture_files "$ROOT/fixtures/$FIXTURE" "$APP" "${FIXTURE_FILES:-}"
set -f
read -r -a fixture_files <<< "${FIXTURE_FILES:-}"
set +f
FIXTURE_HASHES="$(cd "$APP" && sha256sum App.tsx smoke.ts "${fixture_files[@]}")"
cp "$ROOT/fixtures/blake3/test_vectors.json" "$APP/test_vectors.json"
tarballs=("$C/../pack/rnrs-cli-0.1.0.tgz" "$C/../pack/rnrs-runtime-0.1.0.tgz")
for m in $MODULES; do tarballs+=("$C/../pack/rnrs-$m-0.1.0.tgz"); done
# Further framework tarballs by file stem (e.g. PACKS=rnrs-surface for @rnrs/surface).
for p in ${PACKS:-}; do tarballs+=("$C/../pack/$p-0.1.0.tgz"); done
while IFS= read -r t; do [ -n "$t" ] && tarballs+=("$t"); done <<< "${EXTRA_TARBALLS:-}"
(cd "$APP" && npm install --no-audit --no-fund "${tarballs[@]}")
# Optional Rust logging configuration (RNRS_APP_LOGGING, JSON for rustNativeApp.logging).
if [ -n "${RNRS_APP_LOGGING:-}" ]; then node "$ROOT/scripts/consumer/app-logging.mjs" "$APP" "$RNRS_APP_LOGGING"; fi

# Rust toolchain for the framework's Gradle task (cargo, the Android target).
export RUSTUP_HOME="${RUSTUP_HOME:-$ROOT/.generated/rustup}"
export CARGO_HOME="${CARGO_HOME:-$ROOT/.generated/cargo}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.90.0}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$ROOT/.generated/gradle}"
(cd "$APP/android" && ./gradlew --no-daemon --init-script "$ROOT/scripts/consumer/nix-sdk.init.gradle" assembleRelease -PreactNativeArchitectures=arm64-v8a)

echo "checking that the app's native trees equal the template's"
# With ANDROID_MIN_SDK, the reference build.gradle is replaced by the app's here, so this
# comparison covers the other android/ files only; the recorded diff is the pre-build edit.
for tree in android ios; do
  [ -n "$ANDROID_DIFF" ] && [ "$tree" = android ] && cp "$REF/android/build.gradle" "$REF/android/build.gradle.template" && cp "$APP/android/build.gradle" "$REF/android/build.gradle"
  diff -r -q --exclude=build.gradle.template --exclude=build --exclude=.gradle --exclude=.cxx --exclude=.kotlin --exclude=local.properties "$REF/$tree" "$APP/$tree"
done
# android/ and ios/ were compared above; elsewhere the app must hold no Rust or native sources
# (generated bundle crates live in the ignored .rnrs/ build directory).
extra=$(find "$APP" \( -path "$APP/node_modules" -o -path "$APP/.rnrs" -o -path "$APP/android" -o -path "$APP/ios" \) -prune -o \
  \( -name Cargo.toml -o -name '*.rs' -o -name '*.cpp' -o -name '*.kt' -o -name '*.java' \) -print)
if [ -n "$extra" ]; then echo "unexpected native or Rust sources in the app: $extra" >&2; exit 1; fi
[ -f "$APP/rnrs-android.Cargo.lock" ] || { echo "the first build did not create rnrs-android.Cargo.lock" >&2; exit 1; }

# The Gradle CI path: a relocated copy of the app (another absolute path, no .rnrs/ or build
# outputs) builds with -Prnrs.locked=true against the committed lock, unchanged. CMake
# configure without the bundle (as an IDE sync would) only warns. Without the lock, the
# locked build fails.
MOVED="$C/$NAME-moved"
rm -rf "$MOVED"
mkdir -p "$MOVED"
(cd "$APP" && tar --exclude=./.rnrs --exclude=./android/app/build --exclude=./android/build --exclude=./android/.gradle \
  --exclude=./node_modules/@rnrs/runtime/android/build --exclude=./node_modules/@rnrs/runtime/android/.cxx -cf - .) | (cd "$MOVED" && tar -xf -)
(cd "$MOVED/android" && ./gradlew --no-daemon --init-script "$ROOT/scripts/consumer/nix-sdk.init.gradle" \
  ":rnrs_runtime:configureCMakeRelWithDebInfo[arm64-v8a]" -x :rnrs_runtime:rnrsBuildRustBundle -PreactNativeArchitectures=arm64-v8a) 2>&1 | tee "$C/$NAME-cmake-without-bundle.log" | grep -i "rnrs:" || true
grep -q "is not built yet" "$C/$NAME-cmake-without-bundle.log"
grep -q "BUILD SUCCESSFUL" "$C/$NAME-cmake-without-bundle.log"
(cd "$MOVED/android" && ./gradlew --no-daemon --init-script "$ROOT/scripts/consumer/nix-sdk.init.gradle" assembleRelease \
  -PreactNativeArchitectures=arm64-v8a -Prnrs.locked=true)
cmp "$APP/rnrs-android.Cargo.lock" "$MOVED/rnrs-android.Cargo.lock"
rm "$MOVED/rnrs-android.Cargo.lock"
if (cd "$MOVED/android" && ./gradlew --no-daemon -q --init-script "$ROOT/scripts/consumer/nix-sdk.init.gradle" :rnrs_runtime:rnrsBuildRustBundle \
  -PreactNativeArchitectures=arm64-v8a -Prnrs.locked=true > "$C/$NAME-locked-missing.log" 2>&1); then
  echo "-Prnrs.locked=true accepted a missing lock" >&2; exit 1
fi
grep -q "rnrs-android.Cargo.lock is missing" "$C/$NAME-locked-missing.log"
echo "relocated consumer built with -Prnrs.locked=true; a missing lock was refused"
# Recorded for the smoke result (scripts/consumer/rn-smoke.mjs adds it to its JSON).
cat > "$C/$NAME.build.json" <<JSON
{"template": "@react-native-community/template@0.88.0", "templateSha256": "$(sha256sum "$TEMPLATE" | cut -d' ' -f1)",
 "nativeTreesIdenticalToTemplate": $([ -n "$ANDROID_DIFF" ] && echo '["ios"]' || echo '["android", "ios"]'), "extraNativeOrRustSources": [], "modules": "$MODULES",
 "lockCreated": true, "relocatedLockedBuild": "ok", "missingLockRefused": true, "cmakeWithoutBundleWarns": true}
JSON
# Source provenance and the APK hash, added with node so the status lines are JSON-escaped.
ANDROID_DIFF="$ANDROID_DIFF" SOURCE_HEAD="$SOURCE_HEAD" SOURCE_STATUS="$SOURCE_STATUS" PACKS="${PACKS:-}" FIXTURE="$FIXTURE" FIXTURE_FILES="${FIXTURE_FILES:-}" FIXTURE_HASHES="$FIXTURE_HASHES" \
  APK_SHA256="$(sha256sum "$APP/android/app/build/outputs/apk/release/app-release.apk" | cut -d' ' -f1)" \
  node -e 'const fs = require("fs"); const f = process.argv[1]; const r = JSON.parse(fs.readFileSync(f, "utf8"));
    const status = process.env.SOURCE_STATUS.split("\n").filter(Boolean);
    const fixtureSha256 = Object.fromEntries(process.env.FIXTURE_HASHES.split("\n").filter(Boolean).map(l => l.split(/\s+/)).map(([h, n]) => [n, h]));
    Object.assign(r, {fixture: process.env.FIXTURE, fixtureFiles: process.env.FIXTURE_FILES, fixtureSha256, packs: process.env.PACKS, sourceHead: process.env.SOURCE_HEAD,
      sourceStatusPorcelain: status, sourceClean: status.length === 0, apkSha256: process.env.APK_SHA256});
    if (process.env.ANDROID_DIFF) r.androidBuildConfigDiffFromTemplate = process.env.ANDROID_DIFF.split("\n");
    fs.writeFileSync(f, JSON.stringify(r, null, 1) + "\n");' "$C/$NAME.build.json"
# The default package (no rnrs.testHooks) ships without the native test hooks.
# (Extracted to a file first: with pipefail, grep -q closing the pipe early would fail it.)
unzip -p "$APP/android/app/build/outputs/apk/release/app-release.apk" lib/arm64-v8a/librnrs.so > "$C/librnrs-default.so"
grep -a -q "__rnrsRuntime" "$C/librnrs-default.so" || { echo "librnrs.so check: not the framework library" >&2; exit 1; }
if grep -a -q -E "(invalidate|forceBytesCopyOut|collectGarbage|reload)ForTesting" "$C/librnrs-default.so"; then
  echo "the default librnrs.so contains native test hooks" >&2; exit 1
fi
[ -n "$ANDROID_DIFF" ] && echo "android/build.gradle differs from the template (ANDROID_MIN_SDK=$ANDROID_MIN_SDK):" && echo "$ANDROID_DIFF"
echo "native trees otherwise unchanged; APK: $APP/android/app/build/outputs/apk/release/app-release.apk"
