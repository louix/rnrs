// Runs the browser page (web/build.sh) in fresh headless Chromium processes, one per run, each with
// its own seed, and summarizes per-run medians and within-round paired differences against rnrs.
// Informational: the host is not a controlled device. Records host load before and after each run.
//   node benchmarks/turbo-compare/web/run-web.mjs --out <dir> --fixed-n <json> [--runs 6]
//     [--rounds 4] [--warmup 2] [--timeout-s 300]
// CHROMIUM names the browser (scripts/web-test.mjs); LD_LIBRARY_PATH/BASH_ENV are not passed on.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, median, newSeed } from '../runner-lib.mjs';
import { WEB_WORKLOADS, webPairsFor } from '../workloads.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) {
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
  }
  return args[i + 1];
};
const OUT = path.resolve(opt('out'));
const RUNS = Number(opt('runs', '6'));
const fixedN = JSON.parse(readFileSync(opt('fixed-n'), 'utf8'));
const config = {
  rounds: Number(opt('rounds', '4')),
  warmupRounds: Number(opt('warmup', '2')),
  fixedN,
};
if (existsSync(OUT) && readdirSync(OUT).length) throw new Error(`${OUT} is not empty`);
mkdirSync(OUT, { recursive: true });
const build = JSON.parse(readFileSync(path.join(HERE, 'dist/provenance.json'), 'utf8'));
const env = {
  ...process.env,
  RNRS_WEB_ROOT: HERE,
  RNRS_WEB_TIMEOUT_MS: String(Number(opt('timeout-s', '300')) * 1000),
};
delete env.LD_LIBRARY_PATH;
delete env.BASH_ENV;

const runs = [];
for (let i = 1; i <= RUNS; i++) {
  const runId = `web-${i}`;
  const seed = newSeed();
  const load = { before: loadavg() };
  const file = path.join(OUT, `run-${i}.json`);
  const child = spawnSync(process.execPath, [path.join(ROOT, 'scripts/web-test.mjs'), file], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...env,
      RNRS_WEB_QUERY: `config=${encodeURIComponent(JSON.stringify({ runId, seed, ...config }))}`,
    },
  });
  load.after = loadavg();
  writeFileSync(path.join(OUT, `run-${i}.log`), child.stdout + child.stderr);
  const result = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const ok = child.status === 0 && result?.ok === true;
  runs.push({ index: i, runId, seed, ok, browser: result?.browser, load, report: result?.report });
  console.log(
    `run ${i} seed ${seed}: ${ok ? 'done' : `FAILED ${result?.error ?? child.status}`}, load ${load.before[0].toFixed(2)} -> ${load.after[0].toFixed(2)}`,
  );
  if (!ok) process.exit(1);
}

// Validation: identical semantics, complete unique samples at the fixed n.
const problems = [];
const workloads = WEB_WORKLOADS.filter((w) => w.id in fixedN);
for (const run of runs) {
  const r = run.report;
  if (JSON.stringify(r.semantics) !== JSON.stringify(runs[0].report.semantics))
    problems.push(`run ${run.index}: semantics differ from run 1`);
  const seen = new Set();
  for (const [phase, round, , w, p, n, ms] of r.rows) {
    const key = `${phase}|${round}|${w}|${p}`;
    if (seen.has(key)) problems.push(`run ${run.index}: duplicate ${key}`);
    seen.add(key);
    if (n !== fixedN[w] || !(ms > 0)) problems.push(`run ${run.index}: invalid sample ${key}`);
  }
  for (const phase of [0, 1])
    for (let round = 0; round < (phase ? config.rounds : config.warmupRounds); round++)
      for (const w of workloads)
        for (const p of Object.keys(w.paths))
          if (!seen.has(`${phase}|${round}|${w.id}|${p}`))
            problems.push(`run ${run.index}: missing ${phase}|${round}|${w.id}|${p}`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const ns = (row) => (row[6] * 1e6) / row[5];
const measured = runs.flatMap((run) =>
  run.report.rows.filter((row) => row[0] === 1).map((row) => ({ run: run.index, row })),
);
const summary = workloads.map((w) => {
  const paths = Object.fromEntries(
    Object.keys(w.paths).map((p) => {
      const s = measured.filter((x) => x.row[3] === w.id && x.row[4] === p);
      return [
        p,
        {
          ...describe(s.map((x) => ns(x.row))),
          perRun: runs.map((run) =>
            median(s.filter((x) => x.run === run.index).map((x) => ns(x.row))),
          ),
          minMs: Math.min(...s.map((x) => x.row[6])),
        },
      ];
    }),
  );
  const pairs = webPairsFor().map(([a, b]) => {
    const perRun = runs.map((run) => {
      const d = [];
      for (let round = 0; round < config.rounds; round++) {
        const get = (p) =>
          measured.find(
            (x) => x.run === run.index && x.row[1] === round && x.row[3] === w.id && x.row[4] === p,
          );
        d.push(ns(get(a).row) - ns(get(b).row));
      }
      return median(d);
    });
    return { a, b, perRun, median: median(perRun) };
  });
  return { workload: w.id, paths, pairs };
});
const timer = runs.map((run) => run.report.env.timerResolutionMs);
writeFileSync(
  path.join(OUT, 'summary.json'),
  JSON.stringify(
    {
      build,
      config,
      browsers: [...new Set(runs.map((r) => r.browser))],
      timerResolutionMs: timer,
      loads: runs.map((r) => r.load),
      semantics: runs[0].report.semantics,
      summary,
    },
    null,
    1,
  ) + '\n',
);
const f = (v) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));
const lines = [
  `# Browser page (informational) — ${runs.length} fresh ${runs[0].browser} processes`,
  '',
  `Build ${build.commit} (clean: ${build.sourceClean}); timer resolution ${Math.max(...timer)} ms; min sample ${f(Math.min(...summary.flatMap((w) => Object.values(w.paths).map((p) => p.minMs))))} ms.`,
  '',
  '| workload | path | n | median ns/call (pooled) | per-run medians |',
  '|---|---|---:|---:|---|',
  ...summary.flatMap((w) =>
    Object.entries(w.paths).map(
      ([p, s]) =>
        `| ${w.workload} | ${p} | ${fixedN[w.workload]} | ${f(s.median)} | ${s.perRun.map(f).join(', ')} |`,
    ),
  ),
  '',
  '| workload | pair | median of per-run paired medians | per run |',
  '|---|---|---:|---|',
  ...summary.flatMap((w) =>
    w.pairs.map(
      (d) => `| ${w.workload} | ${d.a} − ${d.b} | ${f(d.median)} | ${d.perRun.map(f).join(', ')} |`,
    ),
  ),
  '',
];
writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n'));
console.log(path.join(OUT, 'summary.md'));
