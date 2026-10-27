#!/usr/bin/env bash
# A new module package wrapping a crates.io crate (crc32fast), made with the public commands
# outside this repository, then consumed by a fresh app:
#   npm exec --package=<@rnrs/cli and @rnrs/runtime tarballs> -- rnrs init (one-off, nothing
#   installed); npm install -D of both tarballs (in place of the registry versions init wrote);
#   the author's edits (fixtures/fresh-crc: spec, lib.rs, one Cargo dependency); rnrs test;
#   rnrs check; npm pack (prepack generates).
# The author directory's path contains a space. The package must hold no handwritten
# native code (C/C++/ObjC/Swift/Kotlin/Java/Gradle/CMake/podspec).
# Usage: scripts/consumer/fresh-author.sh web       (inside `nix develop .#web`)
#        scripts/consumer/fresh-author.sh android   (inside `nix develop`; then
#        NAME=fresh-rn node scripts/consumer/rn-smoke.mjs on a device)
# Android also builds with NODE_BINARY set to a node wrapper whose path contains a space,
# and checks that the framework's Gradle task ran it.
set -euo pipefail
MODE="${1:?usage: fresh-author.sh web|android [results.json]}"
OUT_JSON="${2:+$(realpath -m "$2")}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
C="$ROOT/.generated/consumer"
WORK="$C/fresh author"
PKG="$WORK/crc"
PACK="$ROOT/.generated/pack"
FIX="$ROOT/fixtures/fresh-crc"
node "$ROOT/scripts/pack.mjs"   # always: the tarballs must match this checkout
export RUSTUP_HOME="${RUSTUP_HOME:-$ROOT/.generated/rustup}"
export CARGO_HOME="${CARGO_HOME:-$ROOT/.generated/cargo}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.90.0}"

# --- the author ---------------------------------------------------------------------------
rm -rf "$WORK"
mkdir -p "$PKG"
cd "$PKG"
# A package.json first: npm would otherwise install into the nearest ancestor package.
echo '{"name": "@demo/crc", "private": true}' > package.json
npm exec --yes --package="$PACK/rnrs-cli-0.4.0.tgz" --package="$PACK/rnrs-runtime-0.4.0.tgz" -- rnrs init
node -e 'const d = require("./package.json").devDependencies; const root = process.argv[1]; if (d["@rnrs/cli"] !== require(root + "/packages/cli/package.json").version || d["@rnrs/runtime"] !== require(root + "/packages/runtime/package.json").version) throw new Error("rnrs init did not write the devDependencies: " + JSON.stringify(d))' "$ROOT"
[ ! -e node_modules ] || { echo "rnrs init installed something" >&2; exit 1; }
# Not published: the tarballs stand in for the registry versions init wrote.
npm install --no-audit --no-fund --save-dev "$PACK/rnrs-cli-0.4.0.tgz" "$PACK/rnrs-runtime-0.4.0.tgz"
cp "$FIX/crc.spec.ts" crc.spec.ts
cp "$FIX/lib.rs" rust/src/lib.rs
printf 'crc32fast = "1"\n' >> rust/Cargo.toml
npx rnrs test
npx rnrs check
tarball="$PKG/$(npm pack --silent | tail -1)"
listing="$(tar -tzf "$tarball")"
echo "author tarball: $(echo "$listing" | tr '\n' ' ')"
for f in crc.spec.ts rust/Cargo.toml rust/src/lib.rs rust/src/rnrs_interface.rs rnrs/index.ts rnrs/web.ts; do
  grep -qx "package/$f" <<< "$listing" || { echo "the tarball lacks $f" >&2; exit 1; }
done
native=$(find "$PKG" \( -path "$PKG/node_modules" -o -path "$PKG/.rnrs" \) -prune -o -type f \
  \( -name '*.c' -o -name '*.cpp' -o -name '*.h' -o -name '*.mm' -o -name '*.m' -o -name '*.swift' -o -name '*.kt' \
     -o -name '*.java' -o -name '*.gradle' -o -name CMakeLists.txt -o -name '*.podspec' \) -print)
if [ -n "$native" ]; then echo "native sources in the author package: $native" >&2; exit 1; fi
echo "author package: only package.json, .gitignore, crc.spec.ts and rust/ written; no native sources"
cp "$tarball" "$C/demo-crc-0.1.0.tgz"

# --- the app --------------------------------------------------------------------------------
case "$MODE" in
web)
  APP="$C/fresh-web"
  rm -rf "$APP" && mkdir -p "$APP" && cd "$APP"
  printf '{"name": "fresh-web", "version": "0.0.0", "private": true, "type": "module", "devDependencies": {"vite": "6.4.4"}}\n' > package.json
  cp "$FIX/index.html" index.html
  cp "$FIX/web-main.ts" main.ts
  cp "$FIX/smoke.ts" smoke.ts
  npm install --no-audit --no-fund "$PACK/rnrs-cli-0.4.0.tgz" "$PACK/rnrs-runtime-0.4.0.tgz" "$C/demo-crc-0.1.0.tgz"
  node "$ROOT/scripts/consumer/source-build.mjs" . "*"  # the fresh package ships no prebuilt binary
  npx rnrs build --target web --app .
  npx vite build --logLevel warn
  RNRS_WEB_ROOT="$APP/dist" node "$ROOT/scripts/web-test.mjs" $OUT_JSON
  ;;
android)
  NODE_DIR="$WORK/node bin"
  mkdir -p "$NODE_DIR"
  printf '#!/bin/sh\necho "$*" >> "%s/used"\nexec '"'"'%s'"'"' "$@"\n' "$NODE_DIR" "$(command -v node)" > "$NODE_DIR/node"
  chmod +x "$NODE_DIR/node"
  NODE_BINARY="$NODE_DIR/node" FIXTURE=fresh-crc MODULES="" NAME=fresh-rn EXTRA_TARBALLS="$C/demo-crc-0.1.0.tgz" \
    bash "$ROOT/scripts/consumer/rn-app.sh"
  grep -q "cli/run.mjs build --target android" "$NODE_DIR/used" || { echo "the Gradle task did not run NODE_BINARY" >&2; exit 1; }
  echo "rnrsLinkModules ran NODE_BINARY ($NODE_DIR/node)"
  ;;
*) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
