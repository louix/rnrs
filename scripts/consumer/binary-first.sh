#!/usr/bin/env bash
# Binary-first consumers: module packages with prebuilt binaries in apps that build without Rust,
# plus the explicit source override. Usage: scripts/consumer/binary-first.sh android|web
#   android: inside `nix develop` (Android SDK/NDK, JDK); web: inside `nix develop .#web`.
#
# 1. Publisher (Rust allowed): the packed @rnrs/example-counter and @rnrs/labs-meter tarballs get
#    `rnrs build-native --target <target>` (android: all four ABIs), `rnrs check-native`, npm pack.
# 2. prebuilt: a clean app (android: the pristine React Native 0.88.0 template, default
#    architectures, i.e. all four ABIs; web: a Vite app) builds with cargo, rustc, rustup, rustdoc,
#    wasm-bindgen and nix replaced by tripwires that log and fail. Checked: the tripwire printout,
#    an empty tripwire log, no cargo target/ under the app, and both modules' tables linked
#    (android: each lib/<abi>/librnrs.so; web: the registry).
# 3. mixed: the same app with rustNativeApp.sourceBuild = ["@rnrs/example-counter"] (cargo
#    allowed; android: arm64-v8a only). Checked: counter's prebuilt archive or glue is not linked,
#    its table comes from the source bundle, meter's from its prebuilt binary.
# Web runs fixtures/binary-first/web-smoke.ts in headless Chromium for both variants. Android is
# build-only here (no device); fixtures/binary-first/App.tsx and smoke.ts also run on a device or
# simulator. iOS has no CI job for this; see notes in docs/development.md.
# Output: .generated/binary-first/<target>/.
set -euo pipefail
TARGET="${1:?usage: binary-first.sh android|web}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
W="$ROOT/.generated/binary-first/$TARGET"
FIX="$ROOT/fixtures/binary-first"
PACK="$ROOT/.generated/pack"
[ -f "$PACK/rnrs-runtime-0.2.0.tgz" ] || node "$ROOT/scripts/pack.mjs"
export RUSTUP_HOME="${RUSTUP_HOME:-$ROOT/.generated/rustup}"
export CARGO_HOME="${CARGO_HOME:-$ROOT/.generated/cargo}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.90.0}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$ROOT/.generated/gradle}"
RNRS="$ROOT/packages/cli/bin/rnrs.mjs"
rm -rf "$W" && mkdir -p "$W/publish"

echo "== publish: build-native --target $TARGET"
for m in example-counter labs-meter; do
  d="$W/publish/$m"
  mkdir -p "$d" && tar -xzf "$PACK/rnrs-$m-0.2.0.tgz" -C "$d" --strip-components=1
  (cd "$d" && node "$RNRS" build-native . --target "$TARGET" && node "$RNRS" check-native . --target "$TARGET" && rm -rf .rnrs \
    && npm pack --ignore-scripts --pack-destination "$W/publish" > /dev/null)
done
for t in "$W"/publish/*.tgz; do echo "$(basename "$t"): $(tar -tzf "$t" | grep -c 'rnrs/native/') native files"; done

# Tripwires for the prebuilt build: first on PATH; rustup, wasm-bindgen, nix and ~/.cargo
# directories dropped; BASH_ENV unset (it can re-export the full PATH in every non-interactive
# bash, including Gradle's children).
TRIP="$W/tripwire"
mkdir -p "$TRIP/bin" "$TRIP/home"
: > "$TRIP/log"
for t in cargo rustc rustup rustdoc wasm-bindgen nix nix-shell nix-build nix-store; do
  printf '#!/bin/sh\necho "TRIPWIRE %s $*" >> "%s"\nexit 97\n' "$t" "$TRIP/log" > "$TRIP/bin/$t"
  chmod +x "$TRIP/bin/$t"
done
CLEAN_PATH="$TRIP/bin:$(echo "$PATH" | tr ':' '\n' | grep -v -E 'rustup|wasm-bindgen|/nix-[0-9]|\.cargo' | paste -sd:)"
without_rust() { # dir, command...
  local dir="$1"; shift
  env -u BASH_ENV -u RNRS_CARGO -u RNRS_WASM_BINDGEN -u RUSTC -u RUSTUP_TOOLCHAIN -u CARGO_TARGET_DIR \
    CARGO_HOME="$TRIP/no-cargo-home" RUSTUP_HOME="$TRIP/no-rustup-home" PATH="$CLEAN_PATH" \
    bash -c 'cd "$1" && for t in cargo rustc rustup rustdoc wasm-bindgen nix; do
        p="$(command -v "$t")"; echo "resolves $t -> $p"; [ "$p" = "$2/bin/$t" ] || exit 99; done && shift 2 && "$@"' \
    _ "$dir" "$TRIP" "$@"
}
check_no_rust() { # app
  echo "tripwire log ($(wc -l < "$TRIP/log") lines):"
  cat "$TRIP/log"
  [ ! -s "$TRIP/log" ] || { echo "a Rust or Nix tool was invoked" >&2; exit 1; }
  local targets
  targets="$(find "$1" -path "$1/node_modules" -prune -o -type d -name target -print)"
  echo "cargo target/ directories under the app: ${targets:-none}"
  [ -z "$targets" ] || exit 1
}
install_app() { # app dir: the packed framework and the published module tarballs
  (cd "$1" && npm install --no-audit --no-fund "$PACK/rnrs-cli-0.2.0.tgz" "$PACK/rnrs-runtime-0.2.0.tgz" \
    "$W/publish/rnrs-example-counter-0.2.0.tgz" "$W/publish/rnrs-labs-meter-0.2.0.tgz" > "$1.npm.log" 2>&1)
}

case "$TARGET" in
android)
  TEMPLATE="$ROOT/.generated/consumer/react-native-community-template-0.88.0.tgz"
  mkdir -p "$(dirname "$TEMPLATE")"
  [ -f "$TEMPLATE" ] || (cd "$(dirname "$TEMPLATE")" && npm pack @react-native-community/template@0.88.0 > /dev/null)
  NDK_BIN="$(node -e 'import(process.argv[1]).then((m) => console.log(m.ndkBin()))' "$ROOT/tools/rnrs-gen/native.mjs")"
  GRADLE=(./gradlew --no-daemon --init-script "$ROOT/scripts/consumer/nix-sdk.init.gradle" assembleRelease)
  for variant in prebuilt mixed; do
    APP="$W/$variant"
    mkdir -p "$W/unpack" && tar -xzf "$TEMPLATE" -C "$W/unpack"
    rm -rf "$APP" && cp -r "$W/unpack/package/template" "$APP" && rm -rf "$W/unpack"
    for f in _gitignore _watchmanconfig _eslintrc.js _prettierrc.js _bundle; do [ -e "$APP/$f" ] && mv "$APP/$f" "$APP/.${f#_}"; done
    cp "$FIX/App.tsx" "$FIX/smoke.ts" "$APP/"
    install_app "$APP"
    echo "== android $variant"
    if [ "$variant" = prebuilt ]; then
      # The template's default reactNativeArchitectures: all four ABIs.
      (without_rust "$APP/android" "${GRADLE[@]}") > "$W/$variant.gradle.log" 2>&1 || { tail -40 "$W/$variant.gradle.log"; exit 1; }
      head -5 "$W/$variant.gradle.log"
      check_no_rust "$APP"
      ABIS="arm64-v8a armeabi-v7a x86 x86_64"
    else
      node "$ROOT/scripts/consumer/source-build.mjs" "$APP" "@rnrs/example-counter"
      (cd "$APP/android" && "${GRADLE[@]}" -PreactNativeArchitectures=arm64-v8a) > "$W/$variant.gradle.log" 2>&1 \
        || { tail -40 "$W/$variant.gradle.log"; exit 1; }
      if grep -q "librnrs_counter" "$APP/.rnrs/android/modules.cmake"; then echo "mixed: counter's prebuilt archive is linked" >&2; exit 1; fi
      grep -q "librnrs_meter" "$APP/.rnrs/android/modules.cmake" || { echo "mixed: meter's prebuilt archive is not linked" >&2; exit 1; }
      ABIS="arm64-v8a"
    fi
    grep -E "^rnrs: android:" "$W/$variant.gradle.log"
    APK="$APP/android/app/build/outputs/apk/release/app-release.apk"
    # The table symbols of this framework's ABI (tools/rnrs-gen tableSymbol).
    PREFIX="$(node --input-type=module -e "import { tableSymbol } from '$ROOT/tools/rnrs-gen/bundle.mjs'; console.log(tableSymbol(''))")"
    for abi in $ABIS; do
      unzip -p "$APK" "lib/$abi/librnrs.so" > "$W/$variant-$abi-librnrs.so"
      tables="$("$NDK_BIN/llvm-nm" -D --defined-only "$W/$variant-$abi-librnrs.so" | awk '{print $3}' | grep "^$PREFIX" | sort | tr '\n' ' ')"
      echo "$variant $abi librnrs.so ($(wc -c < "$W/$variant-$abi-librnrs.so") B) tables: $tables"
      [ "$tables" = "${PREFIX}counter ${PREFIX}meter " ] || { echo "$abi: expected both module tables" >&2; exit 1; }
    done
  done
  ;;
web)
  for variant in prebuilt mixed; do
    APP="$W/$variant"
    rm -rf "$APP" && mkdir -p "$APP"
    printf '{"name": "binary-first-web", "version": "0.0.0", "private": true, "type": "module", "devDependencies": {"vite": "6.4.4"}}\n' > "$APP/package.json"
    cp "$FIX/index.html" "$APP/"
    cp "$FIX/web-main.ts" "$APP/main.ts"
    cp "$FIX/web-smoke.ts" "$APP/"
    install_app "$APP"
    echo "== web $variant"
    if [ "$variant" = prebuilt ]; then
      (without_rust "$APP" bash -c 'npx rnrs build --target web --app . && npx vite build --logLevel warn') > "$W/$variant.build.log" 2>&1 \
        || { tail -40 "$W/$variant.build.log"; exit 1; }
      head -6 "$W/$variant.build.log"
      check_no_rust "$APP"
    else
      node "$ROOT/scripts/consumer/source-build.mjs" "$APP" "@rnrs/example-counter"
      (cd "$APP" && npx rnrs build --target web --app . && npx vite build --logLevel warn) > "$W/$variant.build.log" 2>&1 \
        || { tail -40 "$W/$variant.build.log"; exit 1; }
      if grep -q "rnrs_counter.js" "$APP/.rnrs/web/rnrs.js"; then echo "mixed: counter's prebuilt glue is imported" >&2; exit 1; fi
      grep -q "export const instances = \[source_bundle, m_meter\];" "$APP/.rnrs/web/rnrs.js" || { echo "mixed: unexpected registry" >&2; exit 1; }
    fi
    grep -E "^rnrs: web:" "$W/$variant.build.log"
    grep -E "^import" "$APP/.rnrs/web/rnrs.js"
    RNRS_WEB_ROOT="$APP/dist" node "$ROOT/scripts/web-test.mjs" "$W/$variant.result.json"
  done
  ;;
*) echo "unknown target $TARGET" >&2; exit 2 ;;
esac
echo "binary-first $TARGET: prebuilt and mixed consumers OK"
