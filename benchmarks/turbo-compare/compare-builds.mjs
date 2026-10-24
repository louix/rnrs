// Before/after comparison of two builds on one phone (analysis only; the harness is unchanged).
// Each run set directory holds one fresh-process run of one build (run-android.mjs or
// run-ios.mjs with --runs 1) and is validated by summarize.mjs's validator. Run sets are given
// in ABAB order and paired by position: (A1, B1), (A2, B2), ...
//   node benchmarks/turbo-compare/compare-builds.mjs <out.md> A1 B1 [A2 B2 ...]
// Reported per workload and path: each run's median ns/unit for A and B, and B − A per pair.
// Primary per workload: the within-process paired difference rnrs − tm (TurboModule and JSI
// rows are unchanged controls in the same process), per run for A and B, and its change B − A
// per pair. Nothing is attributed to a component; these are complete path totals.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { median } from './runner-lib.mjs';
import { loadRunSet, summarize, validate } from './summarize.mjs';
import { WORKLOADS } from './workloads.mjs';

const [out, ...dirs] = process.argv.slice(2);
if (!out || dirs.length < 2 || dirs.length % 2) {
  console.error('usage: compare-builds.mjs <out.md> A1 B1 [A2 B2 ...]');
  process.exit(2);
}
const sets = dirs.map((d) => {
  const set = loadRunSet(path.resolve(d));
  const problems = validate(set);
  if (problems.length) throw new Error(`${d}: ${problems.join('; ')}`);
  if (set.runs.length !== 1) throw new Error(`${d}: expected one run per set`);
  return { dir: d, set, summary: summarize(set.runs) };
});
const pairs = [];
for (let i = 0; i < sets.length; i += 2) pairs.push([sets[i], sets[i + 1]]);
const builds = [pairs[0][0].set.build, pairs[0][1].set.build];
for (const [a, b] of pairs) {
  if (a.set.build.commit !== builds[0].commit || b.set.build.commit !== builds[1].commit)
    throw new Error('every A set must be one build and every B set another');
  const fixed = [a, b].map((s) => JSON.stringify(s.set.runner.runConfig.fixedN));
  if (fixed[0] !== fixed[1]) throw new Error('A and B use different fixed n');
}

const f = (v) =>
  Number.isFinite(v)
    ? Math.abs(v) >= 100
      ? Math.round(v).toLocaleString('en-US')
      : v.toFixed(1)
    : '–';
const sgn = (v) => (Number.isFinite(v) && v > 0 ? '+' : '') + f(v);
const range = (d) => `${sgn(median(d))} [${sgn(Math.min(...d))}…${sgn(Math.max(...d))}]`;
const pct = (b, a) => (Number.isFinite(a) && a ? `${sgn(((b - a) / a) * 100)} %` : '–');
const row = (s, w, p) => s.summary.find((x) => x.workload === w).paths[p].perRun[0];
const delta = (s, w) =>
  s.summary.find((x) => x.workload === w).pairs.find((d) => d.a === 'rnrs' && d.b === 'tm')
    ?.perRun[0];

const artifact = (b) => b.apkSha256 ?? b.binarySha256;
const lines = [
  `# Before/after: A = ${builds[0].label} (${builds[0].commit.slice(0, 7)}, ${artifact(builds[0]).slice(0, 12)}…) vs B = ${builds[1].label} (${builds[1].commit.slice(0, 7)}, ${artifact(builds[1]).slice(0, 12)}…)`,
  '',
  `Pairs (ABAB order): ${pairs.map(([a, b], i) => `${i + 1}: ${path.basename(a.dir)} seed ${a.set.runs[0].seed} / ${path.basename(b.dir)} seed ${b.set.runs[0].seed}`).join('; ')}.`,
  'ns per unit, complete path totals incl. JS loop (GC-inclusive). Per-run medians; B − A per pair. Fixed n identical for A and B.',
  '',
  '## Primary: within-process rnrs − tm, A vs B',
  '',
  '| workload | A: rnrs − tm per run | B: rnrs − tm per run | B − A per pair | median B − A [min…max] | pairs > 0 |',
  '| --- | --- | --- | --- | ---: | ---: |',
];
for (const w of WORKLOADS) {
  if (!w.paths.rnrs || !w.paths.tm) continue;
  const a = pairs.map(([x]) => delta(x, w.id));
  const b = pairs.map(([, y]) => delta(y, w.id));
  const d = a.map((v, i) => b[i] - v);
  lines.push(
    `| ${w.id} | ${a.map(sgn).join(', ')} | ${b.map(sgn).join(', ')} | ${d.map(sgn).join(', ')} | ${range(d)} | ${d.filter((x) => x > 0).length}/${d.length} |`,
  );
}
lines.push(
  '',
  '## Per path: per-run medians A / B and B − A per pair',
  '',
  '| workload | path | A | B | B − A | median B − A [min…max] | pairs > 0 | B vs A (medians) |',
  '| --- | --- | --- | --- | --- | ---: | ---: | ---: |',
);
for (const w of WORKLOADS)
  for (const p of Object.keys(w.paths)) {
    const a = pairs.map(([x]) => row(x, w.id, p));
    const b = pairs.map(([, y]) => row(y, w.id, p));
    const d = a.map((v, i) => b[i] - v);
    lines.push(
      `| ${w.id} | ${p} | ${a.map(f).join(', ')} | ${b.map(f).join(', ')} | ${d.map(sgn).join(', ')} | ${range(d)} | ${d.filter((x) => x > 0).length}/${d.length} | ${pct(median(b), median(a))} |`,
    );
  }
writeFileSync(out, lines.join('\n') + '\n');
console.log(out);
