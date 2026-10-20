#!/usr/bin/env bash
# A source archive of one commit for the Mac (no git there): `git archive` plus REVISION (the
# full commit) and SOURCE_SHA256SUMS (sha256 of every file in the commit, `shasum -a 256 -c`
# format), which scripts/consumer/ios-bundle-variant.sh checks fixtures/ and scripts/ against.
#   scripts/consumer/source-archive.sh <commit> <out.tgz>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMMIT=$(git -C "$ROOT" rev-parse "${1:?commit}^{commit}")
OUT="${2:?out.tgz}"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
S="$T/src-${COMMIT:0:7}"
mkdir -p "$S"
git -C "$ROOT" archive "$COMMIT" | tar -x -C "$S"
echo "$COMMIT" > "$S/REVISION"
(cd "$S" && git -C "$ROOT" ls-tree -r --name-only "$COMMIT" | while IFS= read -r f; do if [ -f "$f" ] && [ ! -L "$f" ]; then sha256sum "$f"; fi; done > SOURCE_SHA256SUMS)
tar -czf "$OUT" -C "$T" "src-${COMMIT:0:7}"
echo "$OUT $(sha256sum "$OUT" | cut -d' ' -f1) commit $COMMIT files $(wc -l < "$S/SOURCE_SHA256SUMS")"
