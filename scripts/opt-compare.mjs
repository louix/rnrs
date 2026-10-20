// Compares two optimization checkpoints of the unchanged pilot (docs/optimization.md):
// generated-path medians (pooled and per run), absolute and relative deltas, and the matched
// control's drift between the two checkpoints (it does not change, so its drift is a noise
// indicator). Nothing is filtered: every case is reported, regressions included.
// Usage: node scripts/opt-compare.mjs <before> <after> web|android [--md out.md]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from './pilot-summarize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'results/rnr-opt/raw');

/** Both runs are required; a missing or incomplete run is an error, not a smaller sample. */
export function load(label, platform) {
  const runs = [];
  for (const n of [1, 2]) {
    const file = path.join(RAW, `${label}-pilot-${platform}-run${n}.json`);
    if (!existsSync(file))
      throw new Error(`${label}/${platform}: missing run ${n} (${path.relative(ROOT, file)})`);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const pilot = platform === 'web' ? raw.pilot : raw.result;
    if (!pilot) throw new Error(`${label}/${platform}: run ${n} has no pilot result`);
    runs.push({ n, raw, pilot });
  }
  const summary = summarize(platform, runs);
  summary.buildCheck = buildCheck(label, platform, runs);
  return summary;
}

/** Diagnostics status of a checkpoint's timed runs: "verified-off" only when every run
 *  recorded diagnostics:false at runtime; "unverified" for runs that predate the flag. */
export function buildCheck(label, platform, runs) {
  const flags = runs.map((r) => r.raw.environment?.diagnostics);
  if (flags.some((f) => f === true))
    throw new Error(`${label}/${platform}: a timed run is a diagnostics build`);
  const provenanceFile = path.join(RAW, `${label}-pilot-${platform}-provenance.json`);
  const provenance = existsSync(provenanceFile)
    ? JSON.parse(readFileSync(provenanceFile, 'utf8'))
    : null;
  return {
    diagnostics: flags.every((f) => f === false)
      ? 'verified-off'
      : 'unverified (recorded before the flag existed)',
    provenance,
  };
}

export function compare(before, after) {
  return after.cases.map((a) => {
    const b = before.cases.find((c) => c.id === a.id);
    const g0 = b.impls.generated,
      g1 = a.impls.generated,
      m0 = b.impls.matched,
      m1 = a.impls.matched;
    const pct = (x, y) => Math.round(((y - x) / x) * 1000) / 10;
    return {
      id: a.id,
      generatedBefore: g0.medianUs,
      generatedAfter: g1.medianUs,
      deltaUs: Math.round((g1.medianUs - g0.medianUs) * 1000) / 1000,
      deltaPct: pct(g0.medianUs, g1.medianUs),
      perRunBefore: Object.values(g0.perRunMedianUs),
      perRunAfter: Object.values(g1.perRunMedianUs),
      p10p90After: [g1.p10Us, g1.p90Us],
      matchedDriftPct: m0 && m1 ? pct(m0.medianUs, m1.medianUs) : null,
      // Host-speed-normalized: generated / matched control within each run (same process,
      // same conditions); not reported for partial controls.
      ratioPerRunBefore: b.generatedOverMatchedPerRun,
      ratioPerRunAfter: a.generatedOverMatchedPerRun,
    };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [before, after, platform] = process.argv.slice(2);
  const b = load(before, platform),
    a = load(after, platform);
  const prov = (s) =>
    s.buildCheck.provenance
      ? `commit ${s.buildCheck.provenance.commit.slice(0, 7)}${s.buildCheck.provenance.dirtyFiles.length ? ' (dirty)' : ''}`
      : 'no provenance record';
  const lines = [
    `### ${platform}: ${before} → ${after}`,
    '',
    `Diagnostics build: ${before} ${b.buildCheck.diagnostics}, ${after} ${a.buildCheck.diagnostics}. Provenance: ${before} ${prov(b)}; ${after} ${prov(a)}.`,
    '',
    '| case | generated before → after µs | Δ µs | Δ % | per run before → after | after p10–p90 | matched control drift % | gen/matched per run before → after |',
    '| --- | ---: | ---: | ---: | --- | --- | ---: | --- |',
  ];
  const rows = compare(b, a);
  for (const r of rows)
    lines.push(
      `| ${r.id} | ${r.generatedBefore} → ${r.generatedAfter} | ${r.deltaUs} | ${r.deltaPct} | ${r.perRunBefore.join(', ')} → ${r.perRunAfter.join(', ')} | ${r.p10p90After.join('–')} | ${r.matchedDriftPct ?? '—'} | ${r.ratioPerRunBefore ? `${r.ratioPerRunBefore.join(', ')} → ${r.ratioPerRunAfter.join(', ')}` : 'partial/none'} |`,
    );
  const md = lines.join('\n');
  const i = process.argv.indexOf('--md');
  if (i > 0) writeFileSync(process.argv[i + 1], md + '\n');
  console.log(md);
}
