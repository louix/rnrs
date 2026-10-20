#!/usr/bin/env python3
"""Bounded Pixel 8a PR10291 validation. Run inside nix develop after committed builds.
No logcat, package enumeration, settings changes, or adb server operations.
"""
import datetime
import hashlib
import json
import pathlib
import subprocess
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[2]
SERIAL = "42261JEKB07916"
VARIANTS = ("gpu-probe", "gpu-probe-pr10291")
TARGET = "aarch64-linux-android/release"

def command(args, timeout=20):
    return subprocess.run(args, cwd=ROOT, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True, timeout=timeout)

def adb(*args, timeout=20):
    return command(["adb", "-s", SERIAL, *args], timeout)

def checked(result):
    if result.returncode:
        raise RuntimeError(result.stdout)
    return result.stdout.strip()

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def identity():
    return checked(adb("shell", "getprop ro.serialno; getprop ro.product.model; "
                       "getprop ro.build.fingerprint; getconf PAGE_SIZE; "
                       "dumpsys SurfaceFlinger | grep '^GLES:'"))

def thermal():
    # Battery temperature is coarse context, not GPU frequency or junction temperature.
    return checked(adb("shell", "dumpsys battery | grep -E 'temperature:|level:|status:'"))

def save_json(path, obj):
    with path.open("x") as f:
        json.dump(obj, f, indent=2)
        f.write("\n")

def main():
    checked(command(["git", "diff", "--exit-code", "HEAD", "--", "fixtures/gpu-probe",
                     "fixtures/gpu-probe-pr10291"]))
    checked(adb("get-state"))
    initial = identity()
    assert initial.splitlines()[0:2] == [SERIAL, "Pixel 8a"], initial
    assert "Mali-G715" in initial and "\n4096\n" in initial, initial
    locks = [tomllib.loads((ROOT / "fixtures" / v / "Cargo.lock").read_text()) for v in VARIANTS]
    def normalized(lock):
        return sorted((p["name"], p["version"], p.get("source", ""), p.get("checksum", ""),
                       tuple(p.get("dependencies", []))) for p in lock["package"]
                      if p["name"] not in (*VARIANTS, "wgpu-hal"))
    assert normalized(locks[0]) == normalized(locks[1]), "dependency drift"
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = ROOT / "results/surface/runs" / (stamp + "-" + SERIAL + "-paired-pr10291")
    out.mkdir()
    remote = "/data/local/tmp/rnr-paired-" + stamp
    files = sorted((ROOT / "fixtures/gpu-probe/src").rglob("*.rs"))
    files += [ROOT / "fixtures/gpu-probe/paired.py"]
    for v in VARIANTS:
        files += [ROOT / "fixtures" / v / n for n in ("Cargo.toml", "Cargo.lock")]
        files += [ROOT / "fixtures" / v / "target" / TARGET / n for n in ("gpu-probe", "hybrid", "cpu")]
    files += [ROOT / "fixtures/gpu-probe-pr10291" / n for n in ("prepare.sh", "wgpu-hal-pr10291.diff")]
    for version in ("29.0.4", "30.0.1"):
        files += [ROOT / "fixtures/gpu-probe-pr10291/.patched" / ("wgpu-hal-" + version + ".crate"),
                  ROOT / "fixtures/gpu-probe-pr10291/.patched" / ("wgpu-hal-" + version) / "src/vulkan/adapter.rs"]
    meta = {"commit": checked(command(["git", "rev-parse", "HEAD"])),
            "identity": initial, "rustc": checked(command(["rustc", "-Vv"])),
            "files": {str(p.relative_to(ROOT)): sha(p) for p in files},
            "order": [], "device_timeout_seconds": 45, "host_timeout_seconds": 55,
            "workload": "256x256 static three shapes; two GPU frames, CPU control 12 frames"}
    save_json(out / "provenance.json", meta)
    checked(adb("shell", "mkdir " + remote))
    try:
        # One invocation per cell; never automatically repeat a crash.
        for v, binary in [(v, b) for b in ("hybrid", "gpu-probe", "cpu") for v in VARIANTS]:
            name = v + "-" + binary
            record = {"variant": v, "binary": binary, "utc": datetime.datetime.now(datetime.timezone.utc).isoformat()}
            record["identity_before"] = identity()
            assert record["identity_before"] == initial, "device identity changed"
            record["battery_before"] = thermal()
            local = ROOT / "fixtures" / v / "target" / TARGET / binary
            checked(adb("push", str(local), remote + "/probe"))
            checked(adb("shell", "chmod 700 " + remote + "/probe"))
            record["device_binary_sha256"] = checked(adb("shell", "sha256sum " + remote + "/probe")).split()[0]
            assert record["device_binary_sha256"] == sha(local)
            shell = ("cd " + remote + " && ulimit -c 0; cd " + remote +
                     " && PROBE_VALIDATE=1 PROBE_RGBA=" + remote + "/readback.rgba"
                     " timeout -s TERM -k 3 45 ./probe")
            record["command"] = ["adb", "-s", SERIAL, "shell", shell]
            save_json(out / (name + "-started.json"), record)
            try:
                result = adb("shell", shell, timeout=55)
                record["exit"] = result.returncode
                output = result.stdout
            except subprocess.TimeoutExpired as e:
                record["host_timeout"] = True
                output = e.stdout or b""
                if isinstance(output, bytes):
                    output = output.decode(errors="replace")
            (out / (name + ".txt")).write_text(output)
            record["identity_after"] = identity()
            record["battery_after"] = thermal()
            save_json(out / (name + ".json"), record)
            print(name, record.get("exit", "host timeout"), flush=True)
            if record.get("host_timeout") or record.get("exit") in (124, 137) or record["identity_after"] != initial:
                raise RuntimeError("Stopped after timeout or identity change")
            if result.returncode == 0:
                checked(adb("pull", remote + "/readback.rgba", str(out / (name + ".rgba"))))
            checked(adb("shell", "rm -f " + remote + "/readback.rgba"))
            meta["order"].append(name)
    finally:
        cleanup = adb("shell", "rm -f " + remote + "/probe " + remote +
                      "/readback.rgba; rmdir " + remote)
        (out / "cleanup.txt").write_text(cleanup.stdout + "\nexit=" + str(cleanup.returncode) + "\n")
        save_json(out / "completed-order.json", meta["order"])
        hashes = {p.name: sha(p) for p in sorted(out.iterdir()) if p.is_file()}
        save_json(out / "evidence-sha256.json", hashes)
        print(out, flush=True)

if __name__ == "__main__":
    main()
