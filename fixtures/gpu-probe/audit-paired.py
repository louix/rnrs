#!/usr/bin/env python3
"""Read-only audit: python3 fixtures/gpu-probe/audit-paired.py RUN_DIRECTORY."""
import hashlib
import json
import pathlib
import sys
import tarfile
import tomllib

root = pathlib.Path(__file__).resolve().parents[2]
run = pathlib.Path(sys.argv[1]).resolve()
sha = lambda b: hashlib.sha256(b).hexdigest()
manifest = json.loads((run / "evidence-sha256.json").read_text())
for name, expected in manifest.items():
    assert sha((run / name).read_bytes()) == expected, name
provenance = json.loads((run / "provenance.json").read_text())
for name, expected in provenance["files"].items():
    assert sha((root / name).read_bytes()) == expected, name
lock = tomllib.loads((root / "fixtures/gpu-probe/Cargo.lock").read_text())
old = """            robust_image_access: match phd_features.robustness2 {
                Some(ref f) => f.robust_image_access2 != 0,
                None => phd_features
                    .image_robustness
                    .is_some_and(|ext| ext.robust_image_access != 0),
            },"""
new = """            robust_image_access: phd_features
                .robustness2
                .is_some_and(|f| f.robust_image_access2 != 0)
                || phd_features
                    .image_robustness
                    .is_some_and(|ext| ext.robust_image_access != 0),"""
source_audit = {}
patched = root / "fixtures/gpu-probe-pr10291/.patched"
for version in ("29.0.4", "30.0.1"):
    crate = patched / ("wgpu-hal-" + version + ".crate")
    package = next(p for p in lock["package"] if p["name"] == "wgpu-hal" and p["version"] == version)
    assert sha(crate.read_bytes()) == package["checksum"]
    count = 0
    with tarfile.open(crate) as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            original = archive.extractfile(member).read()
            expected = original
            if member.name.endswith("/src/vulkan/adapter.rs"):
                assert original.decode().count(old) == 1
                expected = original.decode().replace(old, new).encode()
            assert (patched / member.name).read_bytes() == expected, member.name
            count += 1
    source_audit[version] = {"archive_sha256": sha(crate.read_bytes()),
                             "files_verified": count, "only_change": "PR10291 adapter hunk"}

def compare(a, b):
    assert len(a) == len(b) == 256 * 256 * 4
    deltas = [abs(x - y) for x, y in zip(a, b)]
    return {"bytes": len(a), "differing_bytes": sum(d != 0 for d in deltas),
            "differing_pixels": sum(any(deltas[i:i+4]) for i in range(0, len(deltas), 4)),
            "max_channel_delta": max(deltas), "mean_absolute_channel_delta": sum(deltas) / len(deltas)}

baseline_cpu = (run / "gpu-probe-cpu.rgba").read_bytes()
patched_cpu = (run / "gpu-probe-pr10291-cpu.rgba").read_bytes()
hybrid = (run / "gpu-probe-pr10291-hybrid.rgba").read_bytes()
records = [json.loads((run / (name + ".json")).read_text())
           for name in json.loads((run / "completed-order.json").read_text())]
for record in records:
    assert record["identity_before"] == record["identity_after"] == provenance["identity"]
report = {"source_audit": source_audit,
          "evidence_hashes_verified": len(manifest),
          "provenance_file_hashes_verified": len(provenance["files"]),
          "cpu_baseline_vs_patched": compare(baseline_cpu, patched_cpu),
          "patched_hybrid_vs_cpu": compare(hybrid, patched_cpu),
          "records": [{"variant": r["variant"], "binary": r["binary"], "exit": r["exit"],
                       "utc": r["utc"], "battery_before": r["battery_before"],
                       "battery_after": r["battery_after"]} for r in records]}
print(json.dumps(report, indent=2))
