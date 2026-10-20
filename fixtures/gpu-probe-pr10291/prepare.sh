#!/usr/bin/env bash
# Prepares minimally patched wgpu-hal sources for the probe variant in this directory:
# the crates.io wgpu-hal 30.0.1 (classic Vello, wgpu 30) and 29.0.4 (vello_hybrid, wgpu 29)
# tarballs, verified against the checksums in fixtures/gpu-probe/Cargo.lock, extracted to the
# ignored .patched/ directory, plus wgpu-hal-pr10291.diff (upstream PR #10291) and nothing else.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
LOCK="$D/../gpu-probe/Cargo.lock"
rm -rf "$D/.patched"
mkdir -p "$D/.patched"
for v in 30.0.1 29.0.4; do
  want=$(awk -v v="$v" '$0=="name = \"wgpu-hal\""{n=1;next} n&&$0=="version = \""v"\""{m=1;next} m&&/^checksum/{gsub(/"/,"",$3);print $3;exit} /^\[\[package\]\]/{n=0;m=0}' "$LOCK")
  [ -n "$want" ] || { echo "no checksum for wgpu-hal $v in $LOCK" >&2; exit 1; }
  crate="$D/.patched/wgpu-hal-$v.crate"
  curl -sSfL -o "$crate" "https://static.crates.io/crates/wgpu-hal/wgpu-hal-$v.crate"
  got=$(sha256sum "$crate" | cut -d' ' -f1)
  [ "$got" = "$want" ] || { echo "wgpu-hal $v: sha256 $got, expected $want" >&2; exit 1; }
  tar -xzf "$crate" -C "$D/.patched"
  (cd "$D/.patched/wgpu-hal-$v" && patch -p1 --no-backup-if-mismatch < "$D/wgpu-hal-pr10291.diff")
  grep -q 'is_some_and(|f| f.robust_image_access2 != 0)' "$D/.patched/wgpu-hal-$v/src/vulkan/adapter.rs"
  echo "wgpu-hal $v: sha256 $got verified, PR #10291 applied"
done
