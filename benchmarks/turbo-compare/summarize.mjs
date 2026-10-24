// Summarizes one run set (run-*.json, runner-provenance.json and build-provenance.json from
// run-android.mjs or run-ios.mjs) into summary.json and summary.md, after strict validation:
// exactly the planned runs, one build and device identity throughout, a release non-diagnostics
// app with the expected correctness checks all passing, and complete, unique, numerically valid
// warmup and measured sample sets whose iteration counts match the run set's fixed n.
// Reported per (workload, path): ns per unit (a call, or a batch unit), pooled median [p10-p90]
// and per-run medians, GC-inclusive (primary). Descriptive only: the same without samples that
// contained a GC, and rank correlations with round, position in round and process order (drift).
// Per declared pair: the within-round paired difference, same statistics. These are complete
// path totals including the JS loop; nothing is subtracted or decomposed.
//   node benchmarks/turbo-compare/summarize.mjs <run-set dir>
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, median } from './runner-lib.mjs';
import { WORKLOADS, pairsFor } from './workloads.mjs';

/** Correctness checks the harness runs (app/harness.ts correctness()). */
export const EXPECTED_CHECKS = 84;
const MAX_N = 1_000_000;
const COLUMNS = ['phase', 'round', 'pos', 'workload', 'path', 'n', 'ms', 'gcs'];

export function loadRunSet(dir) {
  const runs = readdirSync(dir)
    .filter((f) => /^run-\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
  const read = (f) =>
    existsSync(path.join(dir, f)) ? JSON.parse(readFileSync(path.join(dir, f), 'utf8')) : null;
  return { runs, runner: read('runner-provenance.json'), build: read('build-provenance.json') };
}

/** Deep equality of JSON values, independent of object key order. */
const canonical = (x) =>
  JSON.stringify(x, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
const same = (a, b) => canonical(a) === canonical(b);

export function validate({ runs, runner, build }) {
  const problems = [];
  const bad = (m) => problems.push(m);
  if (!runner) return ['no runner-provenance.json'];
  if (!build) return ['no build-provenance.json'];
  const platform = build.platform;
  // The runner ran this build: commit and artifact hash.
  if (runner.buildCommit !== build.commit) bad('runner buildCommit differs from the build');
  const artifact = platform === 'android' ? 'apkSha256' : 'binarySha256';
  if (!build[artifact] || runner[artifact] !== build[artifact])
    bad(`runner ${artifact} differs from the build`);
  if (platform === 'android' && runner.installedApkSha256 !== build.apkSha256)
    bad('installed APK hash differs from the build');
  if (runner.stoppedAfterRun)
    bad(
      `runner stopped after run ${runner.stoppedAfterRun.index}: ${runner.stoppedAfterRun.reason}`,
    );
  // Exactly the planned runs, indexed 1..plannedRuns, each listed once by the runner.
  const planned = runner.plannedRuns;
  if (!Number.isInteger(planned) || planned < 1) bad('runner provenance has no plannedRuns');
  if (runs.length !== planned) bad(`${runs.length} run files, ${planned} planned`);
  if (
    !same(
      runs.map((r) => r.index),
      Array.from({ length: runs.length }, (_, i) => i + 1),
    )
  )
    bad('run indices are not 1..n');
  if (
    !same(
      runner.runs.map((r) => r.index),
      runs.map((r) => r.index),
    )
  )
    bad('runner provenance lists other runs');
  const seeds = runs.map((r) => r.seed);
  if (new Set(seeds).size !== seeds.length) bad('repeated seeds');
  const fixedN = runner.runConfig?.fixedN;
  if (!fixedN) bad('run config has no fixedN');
  const deviceId = platform === 'android' ? runner.device?.serial : runner.device?.udid;
  let checkNames = null;
  for (const run of runs) {
    const tag = `run ${run.index}`;
    const listed = runner.runs.find((x) => x.index === run.index);
    if (!listed || listed.seed !== run.seed || listed.runId !== run.runId)
      bad(`${tag}: not as listed in runner provenance`);
    const runDevice = platform === 'android' ? run.serial : run.udid;
    if (!deviceId || runDevice !== deviceId)
      bad(`${tag}: device ${runDevice} is not the runner's ${deviceId}`);
    if (run[artifact] !== build[artifact]) bad(`${tag}: ${artifact} differs from the build`);
    const r = run.report;
    if (!run.done || r?.type !== 'report') {
      bad(`${tag}: not completed (${r?.message ?? 'no report'})`);
      continue;
    }
    if (r.runId !== run.runId || r.seed !== run.seed)
      bad(`${tag}: report runId/seed differ from the runner's`);
    if (!same(r.config, { runId: run.runId, seed: run.seed, ...runner.runConfig }))
      bad(`${tag}: app config differs from the runner's`);
    if (r.config.mode !== 'timed') bad(`${tag}: mode ${r.config.mode}`);
    // Release, non-diagnostics state as reported by the app.
    const e = r.env ?? {};
    if (e.platform !== platform) bad(`${tag}: platform ${e.platform}`);
    if (e.dev !== false) bad(`${tag}: __DEV__ is not false`);
    if (e.hermes?.Build !== 'Release' || e.hermes?.['Debugger Enabled'] !== false)
      bad(`${tag}: not a release Hermes without debugger`);
    if (e.timer !== 'performance.now') bad(`${tag}: timer ${e.timer}`);
    if (!(e.timerResolutionMs > 0 && e.timerResolutionMs < 0.1))
      bad(`${tag}: timer resolution ${e.timerResolutionMs} ms`);
    if (!Array.isArray(e.rnrsDiagnosticsKeys) || e.rnrsDiagnosticsKeys.length)
      bad(`${tag}: rnrs diagnostics build`);
    if (e.rnrsTestHooks !== false) bad(`${tag}: rnrs test hooks`);
    if (e.cxxBuild?.optimize !== true || e.cxxBuild?.ndebug !== true)
      bad(`${tag}: C++ not optimized/NDEBUG`);
    // Correctness: the expected, identical, all-passing set.
    if (!Array.isArray(r.checks) || r.checks.length !== EXPECTED_CHECKS)
      bad(`${tag}: ${r.checks?.length} checks, expected ${EXPECTED_CHECKS}`);
    else {
      if (r.checks.some((c) => c.ok !== true)) bad(`${tag}: failed checks`);
      const names = r.checks.map((c) => `${c.path}|${c.name}`);
      if (new Set(names).size !== names.length) bad(`${tag}: duplicate check names`);
      checkNames ??= names;
      if (!same(names, checkNames)) bad(`${tag}: check set differs from run 1`);
    }
    // Samples: complete, unique, known, numerically valid, n = fixed n.
    if (!same(r.columns, COLUMNS)) bad(`${tag}: unexpected columns`);
    const cases = WORKLOADS.flatMap((w) => Object.keys(w.paths).map((p) => [w.id, p]));
    const known = new Set(cases.map(([w, p]) => `${w}|${p}`));
    const rounds = [r.config.warmupRounds, r.config.rounds];
    const seen = new Set();
    const positions = new Set();
    for (const row of r.rows ?? []) {
      const [phase, round, pos, w, p, n, ms, gcs] = row;
      const key = `${phase}|${round}|${w}|${p}`;
      if (row.length !== COLUMNS.length) bad(`${tag}: malformed row ${JSON.stringify(row)}`);
      else if (phase !== 0 && phase !== 1) bad(`${tag}: unknown phase in ${key}`);
      else if (!(Number.isInteger(round) && round >= 0 && round < rounds[phase]))
        bad(`${tag}: round out of range in ${key}`);
      else if (!known.has(`${w}|${p}`)) bad(`${tag}: unknown workload/path ${w}|${p}`);
      else if (!(Number.isInteger(n) && n >= 1 && n <= MAX_N)) bad(`${tag}: invalid n in ${key}`);
      else if (fixedN && n !== fixedN[w])
        bad(`${tag}: n ${n} is not the fixed ${fixedN[w]} in ${key}`);
      else if (!(Number.isFinite(ms) && ms > 0)) bad(`${tag}: invalid ms in ${key}`);
      else if (!(gcs === null || (Number.isInteger(gcs) && gcs >= 0)))
        bad(`${tag}: invalid GC count in ${key}`);
      else if (!(Number.isInteger(pos) && pos >= 0 && pos < cases.length))
        bad(`${tag}: invalid position in ${key}`);
      if (seen.has(key)) bad(`${tag}: duplicate sample ${key}`);
      seen.add(key);
      const pk = `${phase}|${round}|${pos}`;
      if (positions.has(pk)) bad(`${tag}: duplicate position ${pk}`);
      positions.add(pk);
    }
    for (const phase of [0, 1])
      for (let round = 0; round < rounds[phase]; round++)
        for (const [w, p] of cases)
          if (!seen.has(`${phase}|${round}|${w}|${p}`))
            bad(`${tag}: missing sample ${phase}|${round}|${w}|${p}`);
  }
  return problems;
}

/** Spearman rank correlation (average ranks for ties); NaN for fewer than 3 points. */
export function spearman(xs, ys) {
  if (xs.length < 3) return NaN;
  const rank = (v) => {
    const order = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = Array.from({ length: v.length }, () => 0);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const a = rank(xs);
  const b = rank(ys);
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}

/** ns per unit, keyed by run index, round, workload, path (measured or warmup phase). */
function samples(runs, phase) {
  const out = [];
  for (const run of runs)
    for (const [ph, round, pos, w, p, n, ms, gcs] of run.report.rows)
      if (ph === phase)
        out.push({ run: run.index, round, pos, w, p, n, ns: (ms * 1e6) / n, ms, gcs });
  return out;
}

export function summarize(runs) {
  const measured = samples(runs, 1);
  const warmup = samples(runs, 0);
  const result = [];
  for (const w of WORKLOADS) {
    const paths = {};
    for (const p of Object.keys(w.paths)) {
      const s = measured.filter((x) => x.w === w.id && x.p === p);
      const ws = warmup.filter((x) => x.w === w.id && x.p === p);
      const perRun = runs.map((run) =>
        median(s.filter((x) => x.run === run.index).map((x) => x.ns)),
      );
      const lastRound = Math.max(...s.map((x) => x.round));
      const half = Math.floor(lastRound / 2);
      const noGc = s.filter((x) => x.gcs === 0);
      // Drift: ranks within each run (ns relative to that run's median) against round and position.
      const rel = s.map((x) => x.ns / perRun[runs.findIndex((r) => r.index === x.run)]);
      paths[p] = {
        ...describe(s.map((x) => x.ns)),
        perRun,
        count: s.length,
        n: [...new Set(s.map((x) => x.n))],
        sampleMs: describe(s.map((x) => x.ms)),
        warmupMedian: median(ws.map((x) => x.ns)),
        firstHalfMedian: median(s.filter((x) => x.round <= half).map((x) => x.ns)),
        secondHalfMedian: median(s.filter((x) => x.round > half).map((x) => x.ns)),
        samplesWithGc: s.filter((x) => x.gcs > 0).length,
        noGcMedian: median(noGc.map((x) => x.ns)),
        noGcSamples: noGc.length,
        rhoRound: spearman(
          s.map((x) => x.round),
          rel,
        ),
        rhoPosition: spearman(
          s.map((x) => x.pos),
          rel,
        ),
        rhoProcessOrder: spearman(
          runs.map((r) => r.index),
          perRun,
        ),
      };
    }
    const pairs = pairsFor(w).map(([a, b]) => {
      const diffs = [];
      const perRunDiffs = [];
      for (const run of runs) {
        const d = [];
        for (const x of measured.filter((m) => m.run === run.index && m.w === w.id && m.p === a)) {
          const y = measured.find(
            (m) => m.run === run.index && m.w === w.id && m.p === b && m.round === x.round,
          );
          d.push(x.ns - y.ns);
        }
        diffs.push(...d);
        perRunDiffs.push(median(d));
      }
      return {
        a,
        b,
        ...describe(diffs),
        perRun: perRunDiffs,
        perRunRange: [Math.min(...perRunDiffs), Math.max(...perRunDiffs)],
        perRunPositive: perRunDiffs.filter((d) => d > 0).length,
        medianOfRunMedians: median(perRunDiffs),
      };
    });
    result.push({ workload: w.id, group: w.group, unit: w.unit ?? 'call', paths, pairs });
  }
  return result;
}

const f = (v) =>
  Number.isFinite(v)
    ? Math.abs(v) >= 100
      ? Math.round(v).toLocaleString('en-US')
      : v.toFixed(1)
    : '–';
const sgn = (v) => (Number.isFinite(v) && v > 0 ? '+' : '') + f(v);
const r2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '–');
const label = (w) => `${w.workload}${w.unit !== 'call' ? ` (per ${w.unit})` : ''}`;

export function markdown(summary, runs, header) {
  const out = [header, ''];
  out.push(
    'ns per unit (a call; batch rows: one unit of work). Complete path totals including the JS loop and harness,',
    'GC-inclusive. Pooled median [p10–p90] over all measured samples; per-run medians in process order.',
    '',
    '| workload | path | n/sample | median [p10–p90] | per-run medians | sample ms median [min–max] |',
    '| --- | --- | ---: | ---: | --- | --- |',
  );
  for (const w of summary)
    for (const [p, s] of Object.entries(w.paths))
      out.push(
        `| ${label(w)} | ${p} | ${s.n.join(',')} | ${f(s.median)} [${f(s.p10)}–${f(s.p90)}] | ${s.perRun.map(f).join(', ')} | ${s.sampleMs.median.toFixed(2)} [${s.sampleMs.min.toFixed(2)}–${s.sampleMs.max.toFixed(2)}] |`,
      );
  out.push(
    '',
    'Paired Δ (within round and process). Per-run medians in process order; "runs > 0": per-run medians above zero.',
    '',
    '| workload | Δ | pooled median [p10–p90] | median of run medians [min–max] | runs > 0 | per-run medians |',
    '| --- | --- | ---: | ---: | ---: | --- |',
  );
  for (const w of summary)
    for (const d of w.pairs)
      out.push(
        `| ${w.workload} | ${d.a} − ${d.b} | ${sgn(d.median)} [${sgn(d.p10)}–${sgn(d.p90)}] | ${sgn(d.medianOfRunMedians)} [${sgn(d.perRunRange[0])}–${sgn(d.perRunRange[1])}] | ${d.perRunPositive}/${d.perRun.length} | ${d.perRun.map(sgn).join(', ')} |`,
      );
  out.push(
    '',
    'Descriptive sensitivity and drift (not used for the primary numbers): samples containing a Hermes GC, the median',
    'without them, warmup and half medians, and Spearman ρ of ns (relative to the run median) with round, with',
    'position in the round, and of per-run medians with process order.',
    '',
    '| workload | path | GC samples | median w/o GC samples (n) | warmup median | 1st / 2nd half | ρ round | ρ position | ρ process |',
    '| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |',
  );
  for (const w of summary)
    for (const [p, s] of Object.entries(w.paths))
      out.push(
        `| ${label(w)} | ${p} | ${s.samplesWithGc}/${s.count} | ${f(s.noGcMedian)} (${s.noGcSamples}) | ${f(s.warmupMedian)} | ${f(s.firstHalfMedian)} / ${f(s.secondHalfMedian)} | ${r2(s.rhoRound)} | ${r2(s.rhoPosition)} | ${r2(s.rhoProcessOrder)} |`,
      );
  out.push('', `Runs: ${runs.map((r) => `${r.index} (seed ${r.seed})`).join(', ')}`);
  return out.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2]);
  const set = loadRunSet(dir);
  const problems = validate(set);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  const summary = summarize(set.runs);
  writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
  const env = set.runs[0].report.env;
  const header = `# ${path.basename(dir)}: ${env.platform} ${env.platformVersion}, RN ${env.reactNative?.major}.${env.reactNative?.minor}.${env.reactNative?.patch}, build ${set.build.label} (${set.build.commit.slice(0, 7)}), ${set.runs.length} runs x ${set.runs[0].report.config.rounds} rounds`;
  writeFileSync(path.join(dir, 'summary.md'), markdown(summary, set.runs, header));
  console.log(`${dir}/summary.md`);
}
