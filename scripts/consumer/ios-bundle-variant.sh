#!/usr/bin/env bash
# C1 S3 run 3 (docs/research/ios-surface-c1-design.md): one native binary, one JS bundle per
# variant. On the Mac, after scripts/consumer/ios-app.sh built the surface-s3 consumer:
#
#   RNR_IOS_OUT=<consumer dir> RNR_SOURCE_COMMIT=<sha> scripts/consumer/ios-bundle-variant.sh <variant> <out dir>
#
# Variants (all from committed fixture sources of this checkout):
#   s3                       fixtures/surface-s3/App.tsx (the harness the binary was built with;
#                            the toolchain-equivalence reference)
#   control-hook-http        D1  fixtures/surface-s3/variants/control-hook-http.tsx
#   control-surface-nofetch  D2  fixtures/surface-s3/variants/control-surface-nofetch.tsx
#   control-quiesced-http    D3  fixtures/surface-s3/variants/control-quiesced-http.tsx
#   control-delayed-first-fetch  D4  fixtures/surface-s3/variants/control-delayed-first-fetch.tsx
#   s3-instrumented          the matched repro with RNR-NET request logging
#   s3-no-unmount-post       E1: s3-instrumented without the unmount-time post
#
# Enforced, not asserted: the checkout is RNR_SOURCE_COMMIT with fixtures/ and scripts/ unmodified
# (a git checkout: HEAD, no diff, no untracked files there; an archive from
# scripts/consumer/source-archive.sh: REVISION and every fixtures/ and scripts/ file against
# SOURCE_SHA256SUMS, no extra files). The s3 variant goes first, for toolchain equivalence: Metro's
# output must equal Xcode's intermediate JS, and this hermesc with these flags must reproduce
# Xcode's embedded bundle from that intermediate (hermesc records the input path in the
# bytecode, so bundles compiled from different paths differ only there). No other variant is
# bundled until that holds or <out>/s3/TOOLCHAIN-DIFFERENCE.md records why it does not. The consumer's App.tsx is
# restored to fixtures/surface-s3/App.tsx on exit (errors included) and checked; if that fails the
# script says the consumer tree is no longer the built source.
#
# The variant becomes the consumer's App.tsx; Metro bundles index.js with the app's own
# node_modules (--dev false, --reset-cache, unminified as Xcode's phase does for Hermes) and
# Xcode's hermesc compiles it (-O). The simulator app is copied to <out dir>/<variant>/HelloWorld.app
# and its main.jsbundle replaced. A linker-signed app with no sealed resources is not re-signed:
# its binary must stay byte-identical, with the built app's codesign -v outcome (otherwise it is
# re-signed ad hoc, must pass codesign -v and be identical without signatures). provenance.json
# records the binary and bundle sha256s, the variant, the source and commit, the hermesc path and
# sha256, and the equivalence results. No native file and no other app is touched.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VARIANT="${1:?variant}"
OUT="${2:?out dir}"
C="${RNR_IOS_OUT:-$ROOT/.generated/consumer-ios}"
COMMIT="${RNR_SOURCE_COMMIT:?set RNR_SOURCE_COMMIT to the source commit of this checkout}"
APP="$C/rn-app"
BUILT="$C/build/Build/Products/Release-iphonesimulator/HelloWorld.app"
F="$ROOT/fixtures/surface-s3"
case "$VARIANT" in
  s3) SRC="$F/App.tsx" ;;
  control-hook-http | control-surface-nofetch | control-quiesced-http | control-delayed-first-fetch | s3-instrumented | s3-no-unmount-post) SRC="$F/variants/$VARIANT.tsx" ;;
  *) echo "unknown variant $VARIANT" >&2; exit 1 ;;
esac
[ -d "$BUILT" ] || { echo "no built simulator app at $BUILT" >&2; exit 1; }
fail() { echo "$1" >&2; exit 1; }

if git -C "$ROOT" rev-parse --git-dir > /dev/null 2>&1; then
  [ "$(git -C "$ROOT" rev-parse HEAD)" = "$COMMIT" ] || fail "checkout HEAD $(git -C "$ROOT" rev-parse HEAD) is not RNR_SOURCE_COMMIT $COMMIT"
  git -C "$ROOT" diff --quiet HEAD -- fixtures scripts || fail "fixtures/ or scripts/ differ from $COMMIT"
  [ -z "$(git -C "$ROOT" ls-files --others --exclude-standard -- fixtures scripts)" ] || fail "untracked files in fixtures/ or scripts/"
else
  [ -f "$ROOT/REVISION" ] && [ "$(cat "$ROOT/REVISION")" = "$COMMIT" ] || fail "REVISION is not RNR_SOURCE_COMMIT $COMMIT"
  [ -f "$ROOT/SOURCE_SHA256SUMS" ] || fail "no SOURCE_SHA256SUMS (make the archive with scripts/consumer/source-archive.sh)"
  (cd "$ROOT" && grep -E "  (fixtures|scripts)/" SOURCE_SHA256SUMS | shasum -a 256 -c --quiet -) || fail "fixtures/ or scripts/ differ from $COMMIT"
  extra=$(cd "$ROOT" && comm -13 <(grep -E "  (fixtures|scripts)/" SOURCE_SHA256SUMS | sed "s/^[0-9a-f]*  //" | sort) <(find fixtures scripts -type f | sort))
  [ -z "$extra" ] || fail "files not in $COMMIT under fixtures/ or scripts/: $extra"
fi
if [ "$VARIANT" != s3 ]; then
  [ -f "$OUT/s3/provenance.json" ] || fail "bundle the s3 variant first (toolchain equivalence)"
  { grep -q "\"metroEqualsXcodeIntermediate\": true" "$OUT/s3/provenance.json" && grep -q "\"hermescReproducesXcodeEmbedded\": true" "$OUT/s3/provenance.json"; } ||
    [ -s "$OUT/s3/TOOLCHAIN-DIFFERENCE.md" ] ||
    fail "toolchain equivalence does not hold for s3: record why in $OUT/s3/TOOLCHAIN-DIFFERENCE.md before bundling variants"
fi

restore() {
  cp "$F/App.tsx" "$APP/App.tsx" && rm -f "$APP/controlHttp.tsx"
  if cmp -s "$F/App.tsx" "$APP/App.tsx" && [ ! -e "$APP/controlHttp.tsx" ]; then
    echo "consumer App.tsx restored to fixtures/surface-s3/App.tsx ($(shasum -a 256 "$APP/App.tsx" | cut -d" " -f1))"
  else
    echo "consumer App.tsx NOT restored: the consumer tree is no longer the built source" >&2
  fi
}
trap restore EXIT

cp "$SRC" "$APP/App.tsx"
cp "$ROOT/fixtures/paddle-game/game.ts" "$F/variants/controlHttp.tsx" "$APP/"
W="$OUT/$VARIANT"
rm -rf "$W" && mkdir -p "$W"
# Xcode's phase uses the hermesc of the app's hermes-compiler package (HERMES_CLI_PATH in its log).
HERMESC="$APP/node_modules/hermes-compiler/hermesc/osx-bin/hermesc"
[ -x "$HERMESC" ] || fail "no hermesc at $HERMESC"
PRODUCTS="$(dirname "$BUILT")"
(cd "$APP" && node node_modules/react-native/cli.js bundle --entry-file index.js --platform ios --dev false --reset-cache \
  --minify false --bundle-output "$W/main.jsbundle.js" --assets-dest "$W/assets" > "$W/bundle.log" 2>&1) ||
  { tail -20 "$W/bundle.log"; exit 1; }
"$HERMESC" -emit-binary -max-diagnostic-width=80 -O -out "$W/main.jsbundle" "$W/main.jsbundle.js"

sha() { shasum -a 256 "$1" | cut -d" " -f1; }
bundle=$(sha "$W/main.jsbundle")
embedded=$(sha "$BUILT/main.jsbundle")
if [ "$VARIANT" = s3 ]; then
  # hermesc records the input file's path in the bytecode, so a bundle compiled from another path
  # never equals Xcode's. Equivalence is checked in two parts instead: Metro's output equals
  # Xcode's intermediate JS ($PRODUCTS/main.jsbundle, Metro's output in the phase), and this
  # hermesc with these flags, compiling that intermediate at its own path, reproduces Xcode's
  # embedded bundle byte for byte.
  jsEquals=$([ "$(sha "$W/main.jsbundle.js")" = "$(sha "$PRODUCTS/main.jsbundle")" ] && echo true || echo false)
  "$HERMESC" -emit-binary -max-diagnostic-width=80 -O -out "$W/xcode-intermediate.hbc" "$PRODUCTS/main.jsbundle"
  hermescReproduces=$([ "$(sha "$W/xcode-intermediate.hbc")" = "$embedded" ] && echo true || echo false)
  rm -f "$W/xcode-intermediate.hbc"
  equivalence="\"metroEqualsXcodeIntermediate\": $jsEquals, \"hermescReproducesXcodeEmbedded\": $hermescReproduces,"
else
  equivalence=""
fi

cp -R "$BUILT" "$W/HelloWorld.app"
cp "$W/main.jsbundle" "$W/HelloWorld.app/main.jsbundle"
# The simulator build is linker-signed (ad hoc) with no sealed resources: the signature lives in
# the binary and covers it only, so the app is not re-signed and its binary must stay
# byte-identical (signature included). codesign -v rejects such an app as built by Xcode ("code
# has no resources but signature indicates they must be present") and the simulator runs it, so
# the variant must get exactly the built app's codesign -v outcome. Otherwise the app is re-signed
# ad hoc, codesign -v must pass, and the binaries must be equal with their signatures removed.
builtBinary=$(sha "$BUILT/HelloWorld")
if codesign -dv "$BUILT" 2>&1 | grep -q "Sealed Resources=none"; then
  resigned=false
  builtVerify=$(codesign -v "$BUILT" 2>&1 | sed "s|^$BUILT||"; echo "exit=${PIPESTATUS[0]}")
  variantVerify=$(codesign -v "$W/HelloWorld.app" 2>&1 | sed "s|^$W/HelloWorld.app||"; echo "exit=${PIPESTATUS[0]}")
  printf "built: %s\nvariant: %s\n" "$builtVerify" "$variantVerify" > "$W/codesign.log"
  [ "$builtVerify" = "$variantVerify" ] || fail "codesign -v differs between the built app and the variant (see $W/codesign.log)"
  verified="\"same as the built app\""
  binary=$(sha "$W/HelloWorld.app/HelloWorld")
  [ "$binary" = "$builtBinary" ] || fail "the variant's binary differs from the built one"
  unsignedBuilt=null
else
  resigned=true
  codesign --force --sign - "$W/HelloWorld.app" > "$W/codesign.log" 2>&1
  codesign -v "$W/HelloWorld.app" >> "$W/codesign.log" 2>&1 || fail "codesign -v rejects $W/HelloWorld.app (see $W/codesign.log)"
  verified=true
  binary=$(sha "$W/HelloWorld.app/HelloWorld")
  cp "$BUILT/HelloWorld" "$W/built.unsigned" && cp "$W/HelloWorld.app/HelloWorld" "$W/variant.unsigned"
  codesign --remove-signature "$W/built.unsigned" && codesign --remove-signature "$W/variant.unsigned"
  u1=$(sha "$W/built.unsigned"); u2=$(sha "$W/variant.unsigned")
  rm -f "$W/built.unsigned" "$W/variant.unsigned"
  [ "$u1" = "$u2" ] || fail "the variant's binary differs from the built one beyond its signature"
  unsignedBuilt="\"$u1\""
fi
cat > "$W/provenance.json" <<EOF2
{"variant": "$VARIANT", "source": "${SRC#$ROOT/}", "sourceSha256": "$(sha "$SRC")", "sourceCommit": "$COMMIT",
 "builtBinarySha256": "$builtBinary", "variantBinarySha256": "$binary", "unsignedBinarySha256": $unsignedBuilt, "bundleSha256": "$bundle",
 "xcodeEmbeddedBundleSha256": "$embedded", "bundleEqualsXcodeEmbedded": $([ "$bundle" = "$embedded" ] && echo true || echo false), $equivalence
 "hermesc": "${HERMESC#$APP/}", "hermescSha256": "$(sha "$HERMESC")", "hermescFlags": "-emit-binary -O", "metro": "--dev false --reset-cache --minify false",
 "resigned": $resigned, "codesignVerified": $verified}
EOF2
cat "$W/provenance.json"
rm -f "$W/main.jsbundle.js"
if [ "$VARIANT" = s3 ] && ! { [ "$jsEquals" = true ] && [ "$hermescReproduces" = true ]; }; then
  echo "toolchain equivalence does not hold (Metro output $jsEquals, hermesc reproduction $hermescReproduces): record why in $W/TOOLCHAIN-DIFFERENCE.md before bundling variants" >&2
fi
