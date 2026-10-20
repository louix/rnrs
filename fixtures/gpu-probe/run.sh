#!/usr/bin/env bash
# Builds the probes and runs them on one device, writing a new directory
# results/surface/runs/<UTC timestamp>-<serial>/probe-*.txt. Existing results are never
# overwritten (the 2026-10-19 files in results/surface/ are immutable evidence).
# Usage (inside `nix develop`, Rust env sourced): fixtures/gpu-probe/run.sh <adb-serial> [variant]
# variant: gpu-probe (default, crates.io wgpu) or gpu-probe-pr10291 (wgpu-hal patched with
# upstream PR #10291; run its prepare.sh first). Run directories are named <UTC>-<serial>-<variant>.
# Each record names the exact command, binary sha256 and exit status. Device-side files are
# removed afterwards.
set -uo pipefail
S="${1:?adb serial required}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VARIANT="${2:-gpu-probe}"
case "$VARIANT" in gpu-probe|gpu-probe-pr10291) ;; *) echo "unknown variant $VARIANT" >&2; exit 1;; esac
P="$ROOT/fixtures/$VARIANT"
SRC="$ROOT/fixtures/gpu-probe"
R="$ROOT/results/surface"
T=/data/local/tmp
[ "$(adb -s "$S" get-state 2>/dev/null)" = device ] || { echo "device $S is not connected" >&2; exit 1; }
(cd "$P" && cargo build --locked --release --target aarch64-linux-android --bins) || exit 1
# Results are collected in a temporary directory and copied to a new run directory only if the device
# stayed connected throughout.
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
adb_() { adb -s "$S" "$@"; }
header() {
  echo "# $(date -u +%FT%TZ) serial=$S model=$(adb_ shell getprop ro.product.model) build=$(adb_ shell getprop ro.build.fingerprint)"
  echo "# variant $VARIANT; source commit $(git -C "$ROOT" rev-parse HEAD)$(git -C "$ROOT" diff --quiet -- "$P" "$SRC" || echo ' (probe sources modified)')"
  echo "# Cargo.lock sha256 $(sha256sum "$P/Cargo.lock" | cut -c1-64)"
  if [ "$VARIANT" = gpu-probe-pr10291 ]; then echo "# patch sha256 $(sha256sum "$P/wgpu-hal-pr10291.diff" | cut -c1-64) (upstream PR #10291, merge 7a2c88d314be4154347802748838a9a653cb9372)"; fi
  for b in gpu-probe hybrid imgload cpu; do
    echo "# sha256 $(sha256sum "$P/target/aarch64-linux-android/release/$b" | cut -c1-64) $b"
  done
}
for b in gpu-probe hybrid imgload cpu; do adb_ push "$P/target/aarch64-linux-android/release/$b" "$T/rnr-probe-$b" >/dev/null; done
run() { # run <binary> <env> [args]
  local bin="$1" env="$2" args="${3:-}"
  echo "== \$ cd $T && $env ./rnr-probe-$bin $args"
  adb_ shell "cd $T && $env ./rnr-probe-$bin $args 2>&1; echo exit=\$?"
}
{
  header
  for env in "" "PROBE_EMPTY=1" "PROBE_ONLY=rect" "PROBE_ONLY=circle" "PROBE_CPU=1" "PROBE_BACKEND=gl"; do run gpu-probe "$env"; done
} > "$OUT/probe-vello-classic.txt" 2>&1
{
  header
  adb_ logcat -c
  run hybrid ""
  sleep 2
  echo "== crash backtrace (logcat)"
  adb_ logcat -d | grep -E "F DEBUG.*(#0[0-9]|Cause|signal)"
  for k in u32 f32 array; do run imgload "" "$k checked"; done
} > "$OUT/probe-vello-hybrid.txt" 2>&1
{
  header
  for env in "PROBE_SIZE=256x256" "PROBE_SIZE=1080x2400 PROBE_THREADS=0" "PROBE_SIZE=1080x2400 PROBE_THREADS=2" "PROBE_SIZE=540x1200 PROBE_THREADS=0"; do run cpu "$env"; done
} > "$OUT/probe-vello-cpu.txt" 2>&1
adb_ shell "rm -f $T/rnr-probe-*"
if grep -q "not found\|no devices" "$OUT"/*.txt || [ "$(adb -s "$S" get-state 2>/dev/null)" != device ]; then
  echo "device $S disconnected during the run; nothing written" >&2; exit 1
fi
RUN="$R/runs/$(date -u +%Y%m%dT%H%M%SZ)-$S-$VARIANT"
[ -e "$RUN" ] && { echo "$RUN exists" >&2; exit 1; }
mkdir -p "$RUN"
cp "$OUT"/probe-vello-*.txt "$RUN"/
echo "wrote $RUN"
grep -h -E "^==|RESULT|exit=|readback" "$RUN"/probe-vello-*.txt
