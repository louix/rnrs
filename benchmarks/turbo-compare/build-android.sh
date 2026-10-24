#!/usr/bin/env bash
# Release APK of the comparison app (inside `nix develop`): the RN 0.88.0 community template, the
# harness JS (app/), and npm installs of the packed framework, the rnrs benchmark module
# (rnrs-module/) and the pure C++ TurboModule library (cxx-module/). The one native edit is the
# applicationId (dev.rustjsilab.rnrscmp), so no other app on the device is replaced; its diff is
# recorded. Diagnostics (-Prnrs.diagnostics) and Rust logging (rustNativeApp.logging) stay off.
#   benchmarks/turbo-compare/build-android.sh <label>
# Output: .generated/turbo-compare/<label>/ (app, tarballs, build.log, provenance.json, app-release.apk).
# Refuses an existing label and, unless RNRSCMP_ALLOW_DIRTY=1 (recorded), a dirty tree.
set -euo pipefail
LABEL="${1:?usage: build-android.sh <label>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/benchmarks/turbo-compare"
OUT="$ROOT/.generated/turbo-compare/$LABEL"
TEMPLATE_SHA256=896707c75d6b0b47aa97041aa605ed45c3329f9204ad6f67064db352c58de19a
APP_ID=dev.rustjsilab.rnrscmp
[ -e "$OUT" ] && { echo "$OUT exists; pick a new label" >&2; exit 1; }
STATUS="$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)"
if [ -n "$STATUS" ] && [ "${RNRSCMP_ALLOW_DIRTY:-0}" != 1 ]; then
  echo "dirty tree (RNRSCMP_ALLOW_DIRTY=1 to build anyway; recorded):" >&2; echo "$STATUS" >&2; exit 1
fi
[ -n "${RNRS_BUNDLE_FEATURES:-}" ] && { echo "RNRS_BUNDLE_FEATURES is set: diagnostics must stay off" >&2; exit 1; }
mkdir -p "$OUT/pack"
exec > >(tee "$OUT/build.log") 2>&1
echo "build $LABEL at $(date -u +%FT%TZ), commit $(git -C "$ROOT" rev-parse HEAD)"
git -C "$ROOT" diff HEAD > "$OUT/dirty.diff"

node "$HERE/gen-cases.mjs" --check
# Framework and module tarballs.
RNRS_PACK_OUT="$OUT/pack" node "$ROOT/scripts/pack.mjs" > "$OUT/pack.log"
node "$ROOT/packages/cli/bin/rnrs.mjs" pack-js "$HERE/rnrs-module"
(cd "$HERE/rnrs-module" && npm pack --ignore-scripts --pack-destination "$OUT/pack" >/dev/null)
(cd "$HERE/cxx-module" && npm pack --ignore-scripts --pack-destination "$OUT/pack" >/dev/null)
(cd "$HERE/nitro-module" && npm pack --ignore-scripts --pack-destination "$OUT/pack" >/dev/null)

TEMPLATE="$ROOT/.generated/turbo-compare/react-native-community-template-0.88.0.tgz"
[ -f "$TEMPLATE" ] || (cd "$(dirname "$TEMPLATE")" && npm pack @react-native-community/template@0.88.0 >/dev/null)
echo "$TEMPLATE_SHA256  $TEMPLATE" | sha256sum -c -
APP="$OUT/app"
mkdir -p "$OUT/unpack"
tar -xzf "$TEMPLATE" -C "$OUT/unpack"
cp -r "$OUT/unpack/package/template" "$APP"
for f in _gitignore _watchmanconfig _eslintrc.js _prettierrc.js _bundle; do
  [ -e "$APP/$f" ] && mv "$APP/$f" "$APP/.${f#_}"
done
cp "$HERE/app/"*.ts "$HERE/app/App.tsx" "$APP/"
GRADLE="$APP/android/app/build.gradle"
[ "$(grep -c '^        applicationId "com.helloworld"$' "$GRADLE")" = 1 ] || { echo "template applicationId not found" >&2; exit 1; }
cp "$GRADLE" "$OUT/build.gradle.template"
sed -i "s/^        applicationId \"com.helloworld\"$/        applicationId \"$APP_ID\"/" "$GRADLE"
diff -u "$OUT/build.gradle.template" "$GRADLE" > "$OUT/android-app-build.gradle.diff" || true

P="$OUT/pack"
(cd "$APP" && npm install --no-audit --no-fund "$P/rnrs-cli-0.2.0.tgz" "$P/rnrs-runtime-0.2.0.tgz" \
  "$P/rnrs-labs-turbo-compare-0.2.0.tgz" "$P/rnrs-bench-cmp-cxx-0.1.0.tgz")
# Nitro Modules core from the registry at the exact version its generated bindings come from.
(cd "$APP" && npm install --no-audit --no-fund --save-exact "$P/rnrs-bench-cmp-nitro-0.1.0.tgz" \
  react-native-nitro-modules@0.37.1)
[ "$(node -p "require('$APP/node_modules/react-native-nitro-modules/package.json').version")" = 0.37.1 ] ||
  { echo "react-native-nitro-modules is not 0.37.1" >&2; exit 1; }
node -e 'const p = require(process.argv[1]); if (p.rustNativeApp?.logging) process.exit(1);' "$APP/package.json" ||
  { echo "rustNativeApp.logging is set" >&2; exit 1; }

export RUSTUP_HOME="${RUSTUP_HOME:-$ROOT/.generated/rustup}"
export CARGO_HOME="${CARGO_HOME:-$ROOT/.generated/cargo}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.90.0}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$ROOT/.generated/gradle}"
rustup target add aarch64-linux-android >/dev/null
(cd "$APP/android" && ./gradlew --no-daemon --init-script "$ROOT/scripts/consumer/nix-sdk.init.gradle" assembleRelease \
  -PreactNativeArchitectures=arm64-v8a)
APK="$APP/android/app/build/outputs/apk/release/app-release.apk"
cp "$APK" "$OUT/app-release.apk"

# The C++ TurboModule's compile command (optimization flags) from CMake's compile database.
CDB="$(find "$APP/android/app/.cxx" -name compile_commands.json -path '*arm64-v8a*' | head -1)"
node -e 'const db = require(process.argv[1]); const e = db.find((x) => x.file.endsWith("RnrsCmpCxx.cpp"));
  if (!e) { console.error("RnrsCmpCxx.cpp not in the compile database"); process.exit(1); }
  require("fs").writeFileSync(process.argv[2], (e.command ?? e.arguments.join(" ")) + "\n");' "$CDB" "$OUT/RnrsCmpCxx.compile.txt"
grep -q -- "-O[23s]" "$OUT/RnrsCmpCxx.compile.txt" || { echo "RnrsCmpCxx.cpp not compiled with optimization" >&2; exit 1; }
# Nitro: the example HybridObject and the Nitro core library, each with optimization (the last -O
# wins) and NDEBUG.
for spec in "cmp-nitro:@rnrs-bench/cmp-nitro:HybridNitroCmpSpec.cpp:NitroCmp" \
  "nitro-core:react-native-nitro-modules:HybridObject.cpp:NitroModules"; do
  IFS=: read -r _ pkg file name <<< "$spec"
  db="$(find "$APP/node_modules/$pkg/android/.cxx" -name compile_commands.json -path '*RelWithDebInfo*arm64-v8a*' | head -1)"
  node -e 'const db = require(process.argv[1]); const e = db.find((x) => x.file.endsWith("/" + process.argv[2]));
    if (!e) { console.error(process.argv[2] + " not in " + process.argv[1]); process.exit(1); }
    require("fs").writeFileSync(process.argv[3], (e.command ?? e.arguments.join(" ")) + "\n");' "$db" "$file" "$OUT/$name.compile.txt"
  last="$(grep -o -- ' -O[0-9sz]*' "$OUT/$name.compile.txt" | tail -1)"
  { [[ "$last" =~ ^\ -O[23s]$ ]] && grep -q -- ' -DNDEBUG' "$OUT/$name.compile.txt"; } ||
    { echo "$name: last optimization flag '$last' or NDEBUG missing" >&2; exit 1; }
done
unzip -p "$APK" lib/arm64-v8a/librnrs.so > "$OUT/librnrs.so"
unzip -p "$APK" lib/arm64-v8a/libappmodules.so > "$OUT/libappmodules.so"
for lib in libNitroCmp.so libNitroModules.so; do
  unzip -l "$APK" "lib/arm64-v8a/$lib" >/dev/null || { echo "$lib missing from the APK" >&2; exit 1; }
done
if grep -a -q -E "(invalidate|forceBytesCopyOut|collectGarbage|reload)ForTesting" "$OUT/librnrs.so"; then
  echo "librnrs.so contains native test hooks" >&2; exit 1
fi

sha() { sha256sum "$1" | cut -d' ' -f1; }
STATUS="$STATUS" OUT="$OUT" APP="$APP" LABEL="$LABEL" ROOT="$ROOT" APP_ID="$APP_ID" \
  APK_SHA="$(sha "$APK")" NITROGEN_SHA="$(cd "$HERE/nitro-module" && find nitrogen -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)" TEMPLATE_SHA="$(sha "$TEMPLATE")" LIBRNRS_SHA="$(sha "$OUT/librnrs.so")" \
  LIBAPPMODULES_SHA="$(sha "$OUT/libappmodules.so")" LOCK_SHA="$(sha "$APP/package-lock.json")" \
  RUSTC="$(rustc --version)" CARGO="$(cargo --version)" JAVA="$(java -version 2>&1 | head -1)" \
  GRADLE_VERSION="$(grep distributionUrl "$APP/android/gradle/wrapper/gradle-wrapper.properties")" \
  NDK="$(grep ndkVersion "$APP/android/build.gradle" | tr -s ' ')" \
  node -e '
const fs = require("fs"), path = require("path"), cp = require("child_process");
const e = process.env;
const git = (...a) => cp.execFileSync("git", ["-C", e.ROOT, ...a], { encoding: "utf8" }).trim();
const tarballs = Object.fromEntries(fs.readdirSync(path.join(e.OUT, "pack")).filter((f) => f.endsWith(".tgz"))
  .map((f) => [f, cp.execFileSync("sha256sum", [path.join(e.OUT, "pack", f)], { encoding: "utf8" }).split(" ")[0]]));
const ver = (p) => JSON.parse(fs.readFileSync(path.join(e.APP, "node_modules", p, "package.json"), "utf8")).version;
const record = {
  label: e.LABEL, platform: "android", builtAt: new Date().toISOString(),
  commit: git("rev-parse", "HEAD"), sourceStatus: e.STATUS.split("\n").filter(Boolean), sourceClean: !e.STATUS,
  applicationId: e.APP_ID, apkSha256: e.APK_SHA, librnrsSha256: e.LIBRNRS_SHA, libappmodulesSha256: e.LIBAPPMODULES_SHA,
  template: "@react-native-community/template@0.88.0", templateSha256: e.TEMPLATE_SHA, packageLockSha256: e.LOCK_SHA,
  tarballs, versions: { reactNative: ver("react-native"), codegen: ver("@react-native/codegen"), nitroModules: ver("react-native-nitro-modules"), nitrogen: "0.37.1 (generated output committed in nitro-module/nitrogen)", hermesCompiler: ver("hermes-compiler"),
    node: process.version, rustc: e.RUSTC, cargo: e.CARGO, java: e.JAVA, gradle: e.GRADLE_VERSION, ndk: e.NDK },
  rnrsDiagnostics: false, rnrsTestHooks: false, rustLogging: false,
  cxxCompile: fs.readFileSync(path.join(e.OUT, "RnrsCmpCxx.compile.txt"), "utf8").trim(),
  nitroCompile: fs.readFileSync(path.join(e.OUT, "NitroCmp.compile.txt"), "utf8").trim(),
  nitroModulesCompile: fs.readFileSync(path.join(e.OUT, "NitroModules.compile.txt"), "utf8").trim(),
  nitrogenSha256: e.NITROGEN_SHA,
};
fs.writeFileSync(path.join(e.OUT, "provenance.json"), JSON.stringify(record, null, 1) + "\n");
console.log(JSON.stringify({ apkSha256: record.apkSha256, commit: record.commit, clean: record.sourceClean }));'
echo "APK: $OUT/app-release.apk"
