// Summarizes a framework-comparison run set (docs/compare.md):
//   node scripts/compare-summarize.mjs results/rnr-compare/<label> [<run-set>]
//     -> summary.md, summary.json for the default run set `raw`; <run-set>/summary.{md,json} otherwise.
// Fails on an incomplete, failed, debug or diagnostics run instead of dropping it silently.
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const CONTROL = 'jsi-cpp';

export function quantile(sorted, q) {
  // Nearest rank.
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const range = xs => { const s = [...xs].sort((a, b) => a - b); return {median: median(s), p10: quantile(s, 0.1), p90: quantile(s, 0.9), n: s.length}; };

/** ctx: {apkSha256, runner (runner-provenance.json or null)}. */
export function checkRun(run, ctx = {}) {
  const problems = [];
  const start = run.start;
  if (start) {
    if (start.seed !== run.seed || start.run !== run.run || start.mode !== run.mode || start.rounds !== run.rounds)
      problems.push(`start record (${start.mode} run ${start.run}, seed ${start.seed}, ${start.rounds} rounds) does not match the file (${run.mode} run ${run.run}, seed ${run.seed}, ${run.rounds} rounds)`);
  }
  const keys = new Set();
  for (const s of run.samples) {
    const k = `${s.round}|${s.workload}|${s.path}`;
    if (keys.has(k)) problems.push(`duplicate sample ${k}`);
    keys.add(k);
  }
  for (const w of start?.workloads ?? []) for (let r = 0; r < run.rounds; r++) for (const p of w.paths)
    if (!keys.has(`${r}|${w.workload}|${p}`)) problems.push(`missing sample ${r}|${w.workload}|${p}`);
  // Android: the installed APK's SHA-256 read from the device; iOS: the manifest hash of the .app
  // the runner installed (checked against provenance before installing).
  const apk = run.conditions?.before?.apkSha256 ?? run.conditions?.before?.artifactSha256;
  if (!apk) problems.push('no installed-APK hash recorded');
  else if (ctx.apkSha256 && apk !== ctx.apkSha256) problems.push('installed APK hash differs from provenance');
  if (ctx.runner) {
    const r = ctx.runner;
    if (run.device?.serialno !== r.serial) problems.push(`device serial ${run.device?.serialno} is not the runner's ${r.serial}`);
    if ((start?.preSample ?? 'idle') !== (r.preSample ?? 'idle')) problems.push(`preSample ${start?.preSample ?? 'idle'}, runner ${r.preSample}`);
    const base = run.mode === 'pressure' ? r.pressureSeedBase ?? 2101 : r.seedBase ?? 2001;
    if (run.seed !== base + run.run - 1) problems.push(`seed ${run.seed}, expected ${base + run.run - 1}`);
  }
  if (run.done?.type !== 'compare-done') problems.push(`not completed: ${run.done?.error ?? run.done?.type}`);
  const env = run.start?.environment;
  if (!env) problems.push('no start record');
  else {
    if (env.dev !== false) problems.push('__DEV__ is not false');
    if (env.diagnostics !== false) problems.push('diagnostics build');
    if (env.nitroBuildType !== 'release') problems.push('Nitro not release');
  }
  const expected = (run.start?.workloads ?? []).reduce((n, w) => n + w.paths.length, 0) * run.rounds;
  if (run.samples.length !== expected) problems.push(`${run.samples.length} samples, expected ${expected}`);
  return problems;
}

const nsPerCall = s => (s.elapsedMs * 1e6) / s.calls;
const delta = (s, key) => {
  const a = s.before?.[key], b = s.after?.[key];
  return typeof a === 'number' && typeof b === 'number' ? b - a : null;
};

/** Per workload and path: per-run medians, pooled range, paired per-round difference to the control. */
export function summarize(runs) {
  const out = {};
  for (const run of runs) {
    for (const s of run.samples) {
      const w = (out[s.workload] ??= {calls: s.calls, paths: {}});
      const p = (w.paths[s.path] ??= {perRun: {}, all: [], diffs: {}, allDiffs: [], gcInTiming: 0, collections: [], totalAllocatedBytes: [], liveHeapDelta: [], nativeLiveDelta: [], mallocZonesDelta: []});
      (p.perRun[run.run] ??= []).push(nsPerCall(s));
      p.all.push(nsPerCall(s));
      const c = delta(s, 'hermes_numCollections');
      if (c !== null) { p.collections.push(c); if (c > 0) p.gcInTiming++; }
      // Cumulative (totalAllocatedBytes, pressure runs only) vs live heap (allocatedBytes).
      const a = delta(s, 'hermes_totalAllocatedBytes');
      if (a !== null) p.totalAllocatedBytes.push(a);
      const l = delta(s, 'hermes_allocatedBytes');
      if (l !== null) p.liveHeapDelta.push(l);
      const n = delta(s, 'nativeAllocatedBytes');
      if (n !== null) p.nativeLiveDelta.push(n);
      const z = delta(s, 'mallocZonesInUseBytes');
      if (z !== null) p.mallocZonesDelta.push(z);
      const control = run.samples.find(o => o.workload === s.workload && o.round === s.round && o.path === CONTROL);
      if (control && s.path !== CONTROL && s.path !== 'js') {
        const d = nsPerCall(s) - nsPerCall(control);
        (p.diffs[run.run] ??= []).push(d);
        p.allDiffs.push(d);
      }
    }
  }
  const result = {};
  for (const [workload, w] of Object.entries(out)) {
    result[workload] = {calls: w.calls, paths: {}};
    for (const [name, p] of Object.entries(w.paths)) {
      result[workload].paths[name] = {
        nsPerCall: range(p.all),
        perRunMedianNs: Object.fromEntries(Object.entries(p.perRun).map(([r, xs]) => [r, median(xs)])),
        diffVsControlNs: p.allDiffs.length ? range(p.allDiffs) : null,
        perRunMedianDiffNs: p.allDiffs.length ? Object.fromEntries(Object.entries(p.diffs).map(([r, xs]) => [r, median(xs)])) : null,
        samplesWithGcInTiming: p.gcInTiming, samples: p.all.length,
        medianCollections: median(p.collections), medianTotalAllocatedBytes: median(p.totalAllocatedBytes), medianLiveHeapDelta: median(p.liveHeapDelta), medianNativeLiveDelta: median(p.nativeLiveDelta), medianMallocZonesDelta: median(p.mallocZonesDelta),
      };
    }
  }
  return result;
}

const PATH_ORDER = ['js', 'jsi-cpp', 'jsi-rust', 'turbo-cpp', 'nitro-cpp', 'nitro-rust', 'rnrs-rust'];
const f = (x, d = 0) => (x === null || x === undefined ? '—' : x.toFixed(d));
const fs = x => (x === null || x === undefined ? '—' : (x >= 0 ? '+' : '') + x.toFixed(0));

export function markdown(provenance, ordinary, pressure, runs, runSet = 'raw', runner = null) {
  const pre = [...new Set(runs.map(r => r.start?.preSample ? `${r.start.preSample}${r.start.busyMs ? ` ${r.start.busyMs} ms` : ''}` : 'idle (v1 harness default)'))].join(', ');
  const lines = [`# Framework comparison: build ${provenance.label}, run set ${runSet}`, '',
    provenance.platform === 'ios'
      ? `Commit \`${provenance.commit}\` (${provenance.source?.kind}; archive SHA-256 \`${provenance.source?.archiveSha256}\` as recorded by the caller, not verified by the build). App manifest SHA-256 \`${provenance.artifact?.manifestSha256}\`, binary \`${provenance.artifact?.binarySha256}\`.`
      : `Commit \`${provenance.commit}\`, dirty files at build start: ${provenance.dirtyFilesAtBuildStart.length ? provenance.dirtyFilesAtBuildStart.join(', ') : 'none'}. APK SHA-256 \`${provenance.apkSha256}\`.`,
    `Device: ${[...new Set(runs.map(r => `${r.device?.model} (${r.device?.product ?? '?'}), serial ${r.device?.serialno ?? 'not recorded'}, ${r.device?.build}`))].join('; ')}.`,
    `Serial: ${runner ? `${runner.serial} (checked against ${runner.platform === 'ios' ? 'the devicectl UDID' : 'ro.serialno'} in every run)` : 'not recorded by this run set'}. Pre-sample: ${pre}. Seeds: ${runs.map(r => `${r.mode} ${r.run}=${r.seed}`).join(', ')}.`,
    `Runs: ${runs.filter(r => r.mode === 'compare').length} ordinary, ${runs.filter(r => r.mode === 'pressure').length} pressure, each a fresh process with ${runs[0]?.rounds} shuffled rounds.`, '',
    `ns per call: pooled median [nearest-rank p10–p90] over all samples, then per-run medians. "Δ vs ${CONTROL}" is the per-round paired difference to the handwritten JSI C++ control (same round, same process), median [p10–p90], then per-run medians. No ratios are reported. The JS rows do not make a native call and have no Δ.`, ''];
  for (const [workload, w] of Object.entries(ordinary)) {
    lines.push(`## ${workload} (${w.calls} calls per sample)`, '', `| path | ns/call | per run | Δ vs ${CONTROL} ns | Δ per run | samples with GC in timing |`, '| --- | ---: | --- | ---: | --- | ---: |');
    for (const name of PATH_ORDER.filter(n => w.paths[n])) {
      const p = w.paths[name];
      lines.push(`| ${name} | ${f(p.nsPerCall.median)} [${f(p.nsPerCall.p10)}–${f(p.nsPerCall.p90)}] | ${Object.values(p.perRunMedianNs).map(x => f(x)).join(', ')} | ${p.diffVsControlNs ? `${fs(p.diffVsControlNs.median)} [${fs(p.diffVsControlNs.p10)}–${fs(p.diffVsControlNs.p90)}]` : '—'} | ${p.perRunMedianDiffNs ? Object.values(p.perRunMedianDiffNs).map(fs).join(', ') : '—'} | ${p.samplesWithGcInTiming}/${p.samples} |`);
    }
    lines.push('');
  }
  for (const [workload, w] of Object.entries(pressure)) {
    lines.push(`## ${workload} (separate runs, ${w.calls} calls per sample)`, '', '| path | ms per sample | per run | Δ vs jsi-cpp ms, paired per round | Δ per run | median Hermes collections in timing | median Hermes totalAllocatedBytes delta (cumulative) | median Hermes allocatedBytes delta (live heap, not allocation) | median malloc live-byte delta (Android mallinfo, process-wide, not allocation) | median malloc-zones in-use delta (iOS, all malloc zones, not allocation) |', '| --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |');
    for (const name of PATH_ORDER.filter(n => w.paths[n])) {
      const p = w.paths[name];
      const ms = x => f(x === null ? null : (x * w.calls) / 1e6, 1);
      const sms = x => (x === null || x === undefined ? '—' : (x >= 0 ? '+' : '') + ((x * w.calls) / 1e6).toFixed(1));
      lines.push(`| ${name} | ${ms(p.nsPerCall.median)} [${ms(p.nsPerCall.p10)}–${ms(p.nsPerCall.p90)}] | ${Object.values(p.perRunMedianNs).map(ms).join(', ')} | ${p.diffVsControlNs ? `${sms(p.diffVsControlNs.median)} [${sms(p.diffVsControlNs.p10)}–${sms(p.diffVsControlNs.p90)}]` : '—'} | ${p.perRunMedianDiffNs ? Object.values(p.perRunMedianDiffNs).map(sms).join(', ') : '—'} | ${f(p.medianCollections)} | ${f(p.medianTotalAllocatedBytes)} | ${f(p.medianLiveHeapDelta)} | ${f(p.medianNativeLiveDelta)} | ${f(p.medianMallocZonesDelta)} |`);
    }
    lines.push('');
  }
  const artifact = provenance.apkSha256 ?? provenance.artifact?.manifestSha256;
  if (provenance.platform === 'ios') {
    // iOS: the hash is of the local .app the runner verified and installed, not read back from the
    // phone (unlike Android's APK hash); the phone-reported installed version and container are listed.
    const inst = r => r.conditions.before.installed ?? {};
    lines.push('## Conditions', '',
      'thermalState is the coarse ProcessInfo state (0 nominal, 1 fair, 2 serious, 3 critical), not a temperature. "Local bundle verified" means the runner checked the manifest of the local .app it installed against provenance; it is not a readback from the phone. The phone-reported installed version and container follow.', '',
      '| run | thermalState before/after | OS | local bundle verified and installed | installed version (bundle version) | installed container |', '| --- | --- | --- | --- | --- | --- |');
    for (const r of runs) lines.push(`| ${r.mode} ${r.run} | ${r.conditions.before.thermalState} / ${r.conditions.after.thermalState} | ${r.device?.build} | ${r.conditions.before.artifactSha256 === artifact} | ${inst(r).version ?? '?'} (${inst(r).bundleVersion ?? '?'}) | ${inst(r).url ?? '?'} |`);
    const containers = new Set(runs.map(r => inst(r).url)), versions = new Set(runs.map(r => `${inst(r).version}/${inst(r).bundleVersion}`));
    lines.push('', `Installed container and version across these runs: ${containers.size === 1 && versions.size === 1 ? 'stable (one container, one version)' : `${containers.size} containers, ${versions.size} versions`}.`);
    return lines.join('\n') + '\n';
  }
  lines.push('## Conditions', '', '| run | battery °C before/after | thermal before/after | governor | APK SHA-256 read back from the device matches |', '| --- | --- | --- | --- | --- |');
  for (const r of runs) {
    const t = c => (c?.batteryTemperatureDeciC ? (Number(c.batteryTemperatureDeciC) / 10).toFixed(1) : '?');
    lines.push(`| ${r.mode} ${r.run} | ${t(r.conditions.before)} / ${t(r.conditions.after)} | ${r.conditions.before.thermalStatus} / ${r.conditions.after.thermalStatus} | ${r.conditions.before.cpuGovernor?.cpu0} / ${r.conditions.before.cpuGovernor?.cpu4} | ${r.conditions.before.apkSha256 === provenance.apkSha256} |`);
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  const runSet = process.argv[3] ?? 'raw';
  const outDir = runSet === 'raw' ? dir : path.join(dir, runSet);
  const provenance = JSON.parse(readFileSync(path.join(dir, 'provenance.json'), 'utf8'));
  const rp = path.join(dir, runSet, 'runner-provenance.json');
  const runner = existsSync(rp) ? JSON.parse(readFileSync(rp, 'utf8')) : null;
  if (runner && (runner.apkSha256 ?? runner.artifactManifestSha256) !== (provenance.apkSha256 ?? provenance.artifact?.manifestSha256)) { console.error('runner-provenance APK differs from the build'); process.exit(1); }
  const runs = readdirSync(path.join(dir, runSet)).filter(n => /^(compare|pressure)-run\d+\.json$/.test(n)).sort()
    .map(n => ({...JSON.parse(readFileSync(path.join(dir, runSet, n), 'utf8'))}));
  const problems = runs.flatMap(r => checkRun(r, {apkSha256: provenance.apkSha256 ?? provenance.artifact?.manifestSha256, runner}).map(p => `${r.mode} run ${r.run}: ${p}`));
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  const ordinary = summarize(runs.filter(r => r.mode === 'compare'));
  const pressure = summarize(runs.filter(r => r.mode === 'pressure'));
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({provenance, runner, ordinary, pressure,
    environment: runs[0]?.start?.environment, device: runs[0]?.device}, null, 2) + '\n');
  writeFileSync(path.join(outDir, 'summary.md'), markdown(provenance, ordinary, pressure, runs, runSet, runner) +
    (runner ? `\nRunner: commit \`${runner.runnerCommit}\` (${runner.runnerDirtyFiles ? `dirty: ${runner.runnerDirtyFiles.length ? runner.runnerDirtyFiles.join(', ') : 'none'}` : runner.runnerSource}), serial ${runner.serial}; the ${runner.platform === 'ios' ? 'app' : 'APK'} is the ${runner.build} build from \`${runner.buildCommit}\`.\n` : '\nRunner provenance: not recorded (runs predate runner-provenance.json).\n'));
  console.log(readFileSync(path.join(outDir, 'summary.md'), 'utf8'));
}
