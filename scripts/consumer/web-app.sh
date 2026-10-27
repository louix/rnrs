#!/usr/bin/env bash
# Clean Vite consumer (inside `nix develop .#web`): a minimal Vite app whose only sources are
# index.html, main.ts, smoke.ts and the vectors JSON, with the packed tarballs installed.
# `rnrs build --target web` builds the app's Wasm bundle into its ignored .rnrs/web; Vite then
# bundles the app, and scripts/web-test.mjs runs dist/ in headless Chromium. The first
# build creates the app's rnrs-web.Cargo.lock; a relocated copy of the app (another absolute
# path, no .rnrs/) must then build with --locked against that lock unchanged, and --locked
# must fail once the lock is removed.
# Usage: scripts/consumer/web-app.sh [results.json]
# FIXTURE (fixtures/<FIXTURE>: index.html, web-main.ts, smoke.ts) and MODULES (packed
# rnrs-<m>-0.1.0 tarball stems, e.g. example-counter) select the app; defaults: the blake3 + counter consumer.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE="${FIXTURE:-consumer}"
MODULES="${MODULES:-example-blake3 example-counter}"
NAME="${NAME:-web-app}"
APP="$ROOT/.generated/consumer/$NAME"
PACK="$ROOT/.generated/pack"
[ -f "$PACK/rnrs-runtime-0.4.0.tgz" ] || node "$ROOT/scripts/pack.mjs"

rm -rf "$APP"
mkdir -p "$APP"
cat > "$APP/package.json" <<'JSON'
{
  "name": "rnrs-vite-consumer",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "devDependencies": {"vite": "6.4.4"}
}
JSON
cp "$ROOT/fixtures/$FIXTURE/index.html" "$APP/index.html"
cp "$ROOT/fixtures/$FIXTURE/web-main.ts" "$APP/main.ts"
cp "$ROOT/fixtures/$FIXTURE/smoke.ts" "$APP/smoke.ts"
cp "$ROOT/fixtures/blake3/test_vectors.json" "$APP/test_vectors.json"
printf '.rnrs/\nnode_modules/\ndist/\n' > "$APP/.gitignore"
tarballs=("$PACK/rnrs-cli-0.4.0.tgz" "$PACK/rnrs-runtime-0.4.0.tgz")
for m in $MODULES; do tarballs+=("$PACK/rnrs-$m-0.4.0.tgz"); done
(cd "$APP" && npm install --no-audit --no-fund "${tarballs[@]}")
# Optional Rust logging configuration (RNRS_APP_LOGGING, JSON for rustNativeApp.logging).
if [ -n "${RNRS_APP_LOGGING:-}" ]; then node "$ROOT/scripts/consumer/app-logging.mjs" "$APP" "$RNRS_APP_LOGGING"; fi
# Every module compiled from source (rustNativeApp.sourceBuild): this script checks source bundles.
node "$ROOT/scripts/consumer/source-build.mjs" "$APP" "*"

export RUSTUP_HOME="${RUSTUP_HOME:-$ROOT/.generated/rustup}"
export CARGO_HOME="${CARGO_HOME:-$ROOT/.generated/cargo}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.90.0}"
(cd "$APP" && npx rnrs build --target web --app .)

MOVED="$ROOT/.generated/consumer/$NAME-moved"
rm -rf "$MOVED"
mkdir -p "$MOVED"
(cd "$APP" && tar --exclude=./.rnrs --exclude=./dist -cf - .) | (cd "$MOVED" && tar -xf -)
(cd "$MOVED" && npx rnrs build --target web --app . --locked)
cmp "$APP/rnrs-web.Cargo.lock" "$MOVED/rnrs-web.Cargo.lock"
rm "$MOVED/rnrs-web.Cargo.lock"
if (cd "$MOVED" && npx rnrs build --target web --app . --locked 2>/dev/null); then echo "--locked accepted a missing lock" >&2; exit 1; fi
echo "relocated consumer built --locked with the same lock; --locked refused a missing lock"
APP="$MOVED"
(cd "$APP" && npx vite build --logLevel warn)
RNRS_WEB_ROOT="$APP/dist" node "$ROOT/scripts/web-test.mjs" "${1:-}"
