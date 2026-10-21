#!/usr/bin/env bash
# An app whose dependency graph selects @rnrs/example-kv (targets: android) cannot be bundled for
# the web: `rnrs build --target web` fails, naming the dependency chain, before any build, and
# importing the package in a browser build fails with its packaged rnrs/web.ts stub. Nothing
# substitutes other semantics.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/.generated/consumer/kv-web"
PACK="$ROOT/.generated/pack"
[ -f "$PACK/rnrs-example-kv-0.1.0.tgz" ] || node "$ROOT/scripts/pack.mjs"
rm -rf "$APP" && mkdir -p "$APP"
printf '{"name": "kv-web", "version": "0.0.0", "private": true, "type": "module"}\n' > "$APP/package.json"
(cd "$APP" && npm install --no-audit --no-fund "$PACK/rnrs-cli-0.1.0.tgz" "$PACK/rnrs-runtime-0.1.0.tgz" "$PACK/rnrs-example-kv-0.1.0.tgz" >/dev/null)
if out=$(cd "$APP" && npx rnrs build --target web --app . 2>&1); then echo "web build of a kv app succeeded" >&2; exit 1; fi
echo "$out" | grep -q 'kv-web -> @rnrs/example-kv: example-kv declares rustNative.targets \[android, ios\] and cannot be bundled for web'
[ ! -d "$APP/.rnrs/web/target" ]
grep -q 'does not support the web target' "$APP/node_modules/@rnrs/example-kv/rnrs/web.ts"
echo "kv web build refused: $(echo "$out" | head -1)"
