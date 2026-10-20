// Summarizes the conversion pilot's raw JSON (results/rnr-pilot/raw/<platform>-run<N>.json)
// into results/rnr-pilot/summary.json and summary.md. Statistics are empirical: medians and
// nearest-rank p10/p90 over the pooled round samples (8 rounds x runs), not confidence
// intervals. Lag p99 is reported only with at least 1000 samples.
// Usage: node scripts/pilot-summarize.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'results/rnr-pilot');

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
const median = (v) => percentile(v, 0.5);

/** Cases whose "matched" control is only a partial match (docs/pilot.md): their ratios are
 *  not comparable and are not reported; absolute values and differences are. */
export const PARTIAL_CONTROLS = {
  android: ['cell-call', 'cell-create-get-dispose'],
  web: ['cell-call', 'cell-create-get-dispose'],
};
const round = (x, d = 3) => (x === null || x === undefined ? null : Number(x.toFixed(d)));

function loadRuns(platform) {
  const runs = [];
  for (const n of [1, 2, 3, 4]) {
    const file = path.join(DIR, 'raw', `${platform}-run${n}.json`);
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const pilot = platform === 'web' ? raw.pilot : raw.result;
    if (!pilot) throw new Error(`${file}: no pilot result (${raw.error ?? 'unknown'})`);
    runs.push({ n, raw, pilot });
  }
  return runs;
}

export function summarize(platform, runs) {
  const throughput = {};
  for (const { n, pilot } of runs) {
    for (const s of pilot.throughput.samples) {
      const c = (throughput[s.case] ??= { impls: {} });
      const i = (c.impls[s.impl] ??= { samples: [], perRun: {} });
      i.samples.push(s.usPerCall);
      (i.perRun[n] ??= []).push(s.usPerCall);
    }
  }
  const meta = Object.fromEntries(runs[0].pilot.throughput.cases.map((c) => [c.id, c]));
  const cases = Object.entries(throughput).map(([id, c]) => {
    const impls = Object.fromEntries(
      Object.entries(c.impls).map(([kind, i]) => [
        kind,
        {
          n: i.samples.length,
          medianUs: round(median(i.samples)),
          p10Us: round(percentile(i.samples, 0.1)),
          p90Us: round(percentile(i.samples, 0.9)),
          perRunMedianUs: Object.fromEntries(
            Object.entries(i.perRun).map(([r, v]) => [r, round(median(v))]),
          ),
          note: meta[id]?.impls.find((x) => x.kind === kind)?.note ?? null,
        },
      ]),
    );
    const partial = (PARTIAL_CONTROLS[platform] ?? []).includes(id);
    const ratio = (a, b) =>
      impls[a] && impls[b] && impls[b].medianUs > 0
        ? round(impls[a].medianUs / impls[b].medianUs, 2)
        : null;
    const perRun = (a, b, f) =>
      impls[a] && impls[b]
        ? runs.map((r) => {
            const x = impls[a].perRunMedianUs[r.n],
              y = impls[b].perRunMedianUs[r.n];
            return x === undefined || y === undefined ? null : f(x, y);
          })
        : null;
    const diff = (a, b) =>
      impls[a] && impls[b] ? round(impls[a].medianUs - impls[b].medianUs) : null;
    return {
      id,
      group: meta[id]?.group,
      iterationsPerMeasurement: runs.map(
        (r) => r.pilot.throughput.cases.find((c) => c.id === id)?.iterations,
      ),
      impls,
      matchedControl: impls.matched ? (partial ? 'partial' : 'matched') : 'none',
      generatedMinusMatchedUs: diff('generated', 'matched'),
      generatedMinusMatchedUsPerRun: perRun('generated', 'matched', (x, y) => round(x - y)),
      generatedOverMatched: partial ? null : ratio('generated', 'matched'),
      generatedOverMatchedPerRun: partial
        ? null
        : perRun('generated', 'matched', (x, y) => (y > 0 ? round(x / y, 2) : null)),
      generatedOverJs: ratio('generated', 'js'),
    };
  });
  const pooled = (key) => runs.flatMap((r) => r.pilot.asyncLatency[key]);
  const latency = Object.fromEntries(
    ['generated', 'jsPromise', 'jsTimeout'].map((k) => {
      const v = pooled(k).map((x) => x * 1000);
      return [
        k,
        {
          samples: v.length,
          p50Us: round(median(v), 1),
          p90Us: round(percentile(v, 0.9), 1),
          p99Us: v.length >= 1000 ? round(percentile(v, 0.99), 1) : null,
          perRunP50Us: runs.map((r) =>
            round(median(r.pilot.asyncLatency[k].map((x) => x * 1000)), 1),
          ),
          perRunOver50Us: runs.map(
            (r) => r.pilot.asyncLatency[k].filter((x) => x * 1000 > 50).length,
          ),
        },
      ];
    }),
  );
  const lagStats = (l) => ({
    samples: l.samples.length,
    missedTicks: l.missedTicks,
    durationMs: round(l.durationMs, 0),
    p50Ms: round(median(l.samples), 2),
    p99Ms: l.samples.length >= 1000 ? round(percentile(l.samples, 0.99), 2) : null,
    maxMs: round(Math.max(...l.samples, l.pendingAtStopMs), 2),
  });
  const lag = runs.map(({ n, pilot }) => {
    const l = pilot.continuous.lag;
    const total = l.samples.reduce((a, b) => a + b, 0) + l.pendingAtStopMs;
    return {
      run: n,
      idle: pilot.continuous.idleLag ? lagStats(pilot.continuous.idleLag) : null,
      calls: pilot.continuous.calls,
      samples: l.samples.length,
      expectedTicks: l.expectedTicks,
      missedTicks: l.missedTicks,
      overflowed: l.overflowed,
      p50Ms: round(median(l.samples), 2),
      p99Ms: l.samples.length >= 1000 ? round(percentile(l.samples, 0.99), 2) : null,
      maxMs: round(Math.max(...l.samples, l.pendingAtStopMs), 2),
      totalLateMs: round(total, 1),
      pendingAtStopMs: round(l.pendingAtStopMs, 2),
      chunkMs: {
        median: round(median(pilot.continuous.chunkMs), 2),
        p90: round(percentile(pilot.continuous.chunkMs, 0.9), 2),
        max: round(Math.max(...pilot.continuous.chunkMs), 2),
      },
      chunks: pilot.continuous.chunks,
      asyncCompleted: pilot.continuous.asyncDone,
      durationMs: round(pilot.continuous.durationMs, 0),
    };
  });
  const series = (samples, key) => {
    const v = samples.map((s) => s[key]).filter((x) => typeof x === 'number');
    if (!v.length) return 'unavailable';
    return {
      first: v[0],
      last: v[v.length - 1],
      min: Math.min(...v),
      max: Math.max(...v),
      samples: v.length,
    };
  };
  const memory = runs.map(({ n, raw, pilot }) => {
    const inProcess = pilot.continuous.memory.map((m) => m.counters);
    const keys = [...new Set(inProcess.flatMap((c) => Object.keys(c)))];
    const out = {
      run: n,
      inProcess: Object.fromEntries(keys.map((k) => [k, series(inProcess, k)])),
    };
    if (raw.externalMemory)
      out.external = Object.fromEntries(
        ['pssKiB', 'rssKiB', 'nativeHeapKiB', 'javaHeapKiB'].map((k) => [
          k,
          series(raw.externalMemory.samples, k),
        ]),
      );
    if (raw.environment?.measureUserAgentSpecificMemory)
      out.measureUserAgentSpecificMemory = raw.environment.measureUserAgentSpecificMemory;
    return out;
  });
  const lifetime = runs.map(({ n, pilot }) => {
    const live = (s) =>
      s.stats.native.Cell ? s.stats.native.Cell.created - s.stats.native.Cell.dropped : null;
    // Web outputs are copied out of Wasm, not adopted: the counter does not exist there.
    const adopted = (s) =>
      typeof s.stats.bytesAdopted === 'number'
        ? s.stats.bytesAdopted - s.stats.bytesReleased
        : 'unavailable';
    const L = pilot.lifetime;
    const a0 = adopted(L.before),
      a1 = adopted(L.after);
    // Derived from the counters (older raw files carry an off-by-one round count).
    const converged = live(L.after) <= live(L.before) && (typeof a0 !== 'number' || a1 <= a0);
    return {
      run: n,
      converged,
      forcedGcRoundsAsRecorded: L.forcedGcRounds ?? null,
      forcedGcRoundsExecuted: L.forcedGcRoundsExecuted ?? null,
      cellsLive: { before: live(L.before), holding: live(L.holding), afterGc: live(L.after) },
      adoptedBuffersLive: { before: a0, holding: adopted(L.holding), afterGc: a1 },
      counters: {
        before: L.before.counters,
        holding: L.holding.counters,
        afterGc: L.after.counters,
      },
    };
  });
  const environment = runs.map(({ n, raw }) => ({
    run: n,
    seed: raw.seed ?? raw.pilot?.seed,
    device: raw.device,
    conditions: raw.conditions,
    environment: raw.environment,
  }));
  return {
    platform,
    runs: runs.length,
    cases,
    latency,
    lag,
    memory,
    lifetime,
    environment,
    controlNotes: runs[0].pilot.controlNotes,
  };
}

function markdown(all) {
  const lines = [
    '# Conversion pilot: summary',
    '',
    'Generated by `scripts/pilot-summarize.mjs` from `raw/`. Per-call times are **end-to-end totals of complete paths** in µs (JS call, conversion, method, result conversion, harness accumulation), median [p10–p90] over the pooled round samples (8 shuffled rounds × 2 fresh runs = 16), with per-run medians in summary.json. These are empirical ranges, not confidence intervals. Differences between rows compare complete paths: the controls omit the framework wrapper, argument packing, admission and generation checks, so a difference is not the cost of any single component such as the boundary crossing.',
    '',
    '`matched`: a handwritten control with the same validation, conversion and ownership semantics for these inputs; `partial`: a control that is only partly comparable (ratio not reported); `plain`: a handwritten control with a weaker contract; `js`: pure JS, a floor reference only (the JIT may simplify it in Chromium).',
    '',
  ];
  for (const s of all) {
    lines.push(
      `## ${s.platform}`,
      '',
      '| case | generated | matched | plain | js | gen − matched µs (per run) | gen/matched (per run) | calls per measurement (per run) |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    const fmt = (i) => (i ? `${i.medianUs} [${i.p10Us}–${i.p90Us}]` : '—');
    const ratioCell = (c) =>
      c.matchedControl === 'none'
        ? 'no baseline'
        : c.matchedControl === 'partial'
          ? 'not comparable (partial control)'
          : `${c.generatedOverMatched} (${c.generatedOverMatchedPerRun.join(', ')})`;
    const diffCell = (c) =>
      c.generatedMinusMatchedUs === null
        ? '—'
        : `${c.generatedMinusMatchedUs} (${c.generatedMinusMatchedUsPerRun.join(', ')})`;
    for (const c of s.cases)
      lines.push(
        `| ${c.id} | ${fmt(c.impls.generated)} | ${fmt(c.impls.matched)} | ${fmt(c.impls.plain)} | ${fmt(c.impls.js)} | ${diffCell(c)} | ${ratioCell(c)} | ${c.iterationsPerMeasurement.join(', ')} |`,
      );
    lines.push(
      '',
      'Async admission-to-settle latency (sequential awaits; µs):',
      '',
      '| path | samples | p50 | p90 | p99 | per-run p50 | per-run samples > 50 µs |',
      '| --- | ---: | ---: | ---: | ---: | --- | --- |',
    );
    for (const [k, v] of Object.entries(s.latency))
      lines.push(
        `| ${k} | ${v.samples} | ${v.p50Us} | ${v.p90Us} | ${v.p99Us ?? 'withheld (<1000)'} | ${v.perRunP50Us.join(', ')} | ${v.perRunOver50Us.join(', ')} |`,
      );
    lines.push(
      '',
      'Continuous phase (20 s, mixed calls in 4 ms chunks, no forced GC): lateness of a 10 ms absolute-schedule timer, against an idle 10 s baseline of the same sampler:',
      '',
      '| run | idle (10 s): samples / missed ticks / p50 / p99 / max ms | load (20 s) samples | missed ticks | p50 ms | p99 ms | max ms | total late ms | chunk ms median/p90/max | calls |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |',
    );
    for (const l of s.lag)
      lines.push(
        `| ${l.run} | ${l.idle ? `${l.idle.samples} / ${l.idle.missedTicks} / ${l.idle.p50Ms} / ${l.idle.p99Ms ?? 'withheld'} / ${l.idle.maxMs}` : '—'} | ${l.samples} | ${l.missedTicks} | ${l.p50Ms} | ${l.p99Ms ?? 'withheld'} | ${l.maxMs} | ${l.totalLateMs} | ${l.chunkMs.median}/${l.chunkMs.p90}/${l.chunkMs.max} | ${l.calls} |`,
      );
    lines.push('', 'Memory during the continuous phase (first → last, max):', '');
    for (const m of s.memory) {
      const parts = [];
      for (const [k, v] of Object.entries(m.inProcess))
        parts.push(`${k}: ${typeof v === 'string' ? v : `${v.first} → ${v.last} (max ${v.max})`}`);
      for (const [k, v] of Object.entries(m.external ?? {}))
        parts.push(`${k}: ${typeof v === 'string' ? v : `${v.first} → ${v.last} (max ${v.max})`}`);
      lines.push(`- run ${m.run}: ${parts.join('; ')}`);
    }
    lines.push(
      '',
      'Forced-GC lifetime diagnostics (2000 cells + 200 × 4 KiB buffers held, then released):',
      '',
    );
    for (const l of s.lifetime)
      lines.push(
        `- run ${l.run}: ${l.converged ? 'converged' : 'NOT converged'}; cells live ${l.cellsLive.before} → ${l.cellsLive.holding} → ${l.cellsLive.afterGc}; adopted buffers live ${typeof l.adoptedBuffersLive.before === 'number' ? `${l.adoptedBuffersLive.before} → ${l.adoptedBuffersLive.holding} → ${l.adoptedBuffersLive.afterGc}` : 'unavailable (outputs are copied, not adopted)'}`,
      );
    lines.push('');
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const all = ['android', 'web']
    .map((p) => [p, loadRuns(p)])
    .filter(([, r]) => r.length)
    .map(([p, r]) => summarize(p, r));
  writeFileSync(path.join(DIR, 'summary.json'), JSON.stringify(all, null, 2) + '\n');
  writeFileSync(path.join(DIR, 'summary.md'), markdown(all) + '\n');
  console.log(markdown(all));
}
