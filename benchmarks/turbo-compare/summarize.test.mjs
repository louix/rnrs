import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { collector, describe, fnv1a, quantile } from './runner-lib.mjs';
import { render } from './gen-cases.mjs';
import { EXPECTED_CHECKS, spearman, summarize, validate } from './summarize.mjs';
import { WORKLOADS } from './workloads.mjs';

const FIXED_N = Object.fromEntries(WORKLOADS.map((w, i) => [w.id, 100 + i]));
const RUN_CONFIG = {
  mode: 'timed',
  rounds: 4,
  warmupRounds: 2,
  targetMs: 10,
  settleMs: 1500,
  fixedN: FIXED_N,
};
const CHECKS = Array.from({ length: EXPECTED_CHECKS }, (_, i) => ({
  path: 'tm',
  name: `check ${i}`,
  ok: true,
}));

function fakeRun(index, seed, nsFor) {
  const rows = [];
  for (const [phase, rounds] of [
    [0, RUN_CONFIG.warmupRounds],
    [1, RUN_CONFIG.rounds],
  ])
    for (let round = 0; round < rounds; round++) {
      let pos = 0;
      for (const w of WORKLOADS)
        for (const p of Object.keys(w.paths)) {
          const n = FIXED_N[w.id];
          rows.push([phase, round, pos++, w.id, p, n, (nsFor(w.id, p, round, phase) * n) / 1e6, 0]);
        }
    }
  const runId = `r${index}`;
  return {
    index,
    seed,
    runId,
    serial: 'S1',
    apkSha256: 'apk',
    done: true,
    report: {
      type: 'report',
      runId,
      seed,
      // Key order as the app reports it (defaults merged first): compared independently of order.
      config: { ...RUN_CONFIG, runId, seed },
      env: {
        platform: 'android',
        dev: false,
        hermes: { Build: 'Release', 'Debugger Enabled': false },
        timer: 'performance.now',
        timerResolutionMs: 0.001,
        rnrsDiagnosticsKeys: [],
        rnrsTestHooks: false,
        cxxBuild: { optimize: true, ndebug: true },
      },
      checks: CHECKS,
      semantics: [{ path: 'nitro', probe: "add('1', 2)", outcome: 'value 3' }],
      columns: ['phase', 'round', 'pos', 'workload', 'path', 'n', 'ms', 'gcs'],
      rows,
    },
  };
}

function fakeSet(nsFor = () => 100, count = 2) {
  const runs = Array.from({ length: count }, (_, i) => fakeRun(i + 1, 11 * (i + 1), nsFor(i + 1)));
  return {
    runs,
    build: { platform: 'android', commit: 'c1', apkSha256: 'apk' },
    runner: {
      buildCommit: 'c1',
      apkSha256: 'apk',
      installedApkSha256: 'apk',
      device: { serial: 'S1' },
      runConfig: RUN_CONFIG,
      plannedRuns: count,
      runs: runs.map((r) => ({ index: r.index, runId: r.runId, seed: r.seed })),
    },
  };
}
const flat = () => () => 100;

test('a complete run set validates; paired differences are within round and process', () => {
  const set = fakeSet(
    (run) => (w, p, round) =>
      p === 'rnrs' ? 300 + round + run : p === 'tm' ? 100 + run * 10 : p === 'jsi' ? 80 : 50,
  );
  assert.deepEqual(validate(set), []);
  const add = summarize(set.runs).find((w) => w.workload === 'add');
  assert.deepEqual(add.paths.tm.perRun, [110, 120]);
  const d = add.pairs.find((x) => x.a === 'rnrs' && x.b === 'tm');
  // run 1: 301+r - 110 over r 0..3 -> 192.5; run 2: 302+r - 120 -> 183.5
  assert.deepEqual(d.perRun, [192.5, 183.5]);
  assert.equal(d.perRunPositive, 2);
  assert.ok(add.paths.rnrs.rhoRound > 0.9);
});

test('rejects truncated runs and missing warmup samples', () => {
  const set = fakeSet(flat);
  set.runs[1].report.rows = set.runs[1].report.rows.filter((r) => !(r[0] === 1 && r[1] === 3));
  set.runs[0].report.rows = set.runs[0].report.rows.filter((r) => !(r[0] === 0 && r[3] === 'nop'));
  const problems = validate(set);
  assert.ok(problems.some((p) => p.startsWith('run 2: missing sample 1|3|')));
  assert.ok(problems.some((p) => p.startsWith('run 1: missing sample 0|0|nop|')));
});

test('rejects unexpected rows: unknown path, extra round, duplicate', () => {
  const set = fakeSet(flat);
  const rows = set.runs[0].report.rows;
  rows.push([1, 0, 99, 'add', 'bogus', 101, 1, 0]);
  rows.push([1, 4, 0, 'add', 'tm', 101, 1, 0]);
  rows.push(rows[0].slice());
  const problems = validate(set);
  assert.ok(problems.some((p) => p.includes('unknown workload/path add|bogus')));
  assert.ok(problems.some((p) => p.includes('round out of range')));
  assert.ok(problems.some((p) => p.includes('duplicate sample')));
});

test('rejects n that differs from the fixed n, and invalid numbers', () => {
  const set = fakeSet(flat);
  const rows = set.runs[0].report.rows;
  rows[3] = [...rows[3]];
  rows[3][5] = rows[3][5] + 1;
  rows[4] = [...rows[4]];
  rows[4][6] = NaN;
  rows[5] = [...rows[5]];
  rows[5][6] = -1;
  rows[6] = [...rows[6]];
  rows[6][5] = 2.5;
  const problems = validate(set);
  assert.ok(problems.some((p) => p.includes('is not the fixed')));
  assert.equal(problems.filter((p) => p.includes('invalid ms')).length, 2);
  assert.ok(problems.some((p) => p.includes('invalid n')));
  const noFixed = fakeSet(flat);
  delete noFixed.runner.runConfig;
  assert.ok(validate(noFixed).includes('run config has no fixedN'));
});

test('rejects mixed provenance: build hash, device, app config, run list and count', () => {
  const set = fakeSet(flat, 3);
  set.runs[1].apkSha256 = 'other';
  set.runs[2].serial = 'S2';
  set.runs[0].report.config = { ...set.runs[0].report.config, rounds: 5 };
  const problems = validate(set);
  assert.ok(problems.includes('run 2: apkSha256 differs from the build'));
  assert.ok(problems.some((p) => p.startsWith('run 3: device S2')));
  assert.ok(problems.includes("run 1: app config differs from the runner's"));
  const fewer = fakeSet(flat, 3);
  fewer.runs.pop();
  assert.ok(validate(fewer).includes('2 run files, 3 planned'));
  const other = fakeSet(flat);
  other.runner.installedApkSha256 = 'x';
  other.build.commit = 'c2';
  const p2 = validate(other);
  assert.ok(p2.includes('installed APK hash differs from the build'));
  assert.ok(p2.includes('runner buildCommit differs from the build'));
  const stopped = fakeSet(flat);
  stopped.runner.stoppedAfterRun = { index: 1, reason: 'thermal status 0->1' };
  assert.ok(validate(stopped).some((p) => p.includes('thermal status')));
});

test('rejects failed, missing or different correctness checks and non-release state', () => {
  const set = fakeSet(flat, 3);
  set.runs[0].report.checks = CHECKS.slice(1);
  set.runs[1].report.checks = CHECKS.map((c, i) => (i === 0 ? { ...c, ok: false } : c));
  set.runs[2].report.env = {
    ...set.runs[2].report.env,
    dev: true,
    timer: 'Date.now',
    rnrsDiagnosticsKeys: ['diagContexts'],
  };
  const problems = validate(set);
  assert.ok(problems.some((p) => p.startsWith(`run 1: ${EXPECTED_CHECKS - 1} checks`)));
  assert.ok(problems.includes('run 2: failed checks'));
  assert.ok(problems.includes('run 3: __DEV__ is not false'));
  assert.ok(problems.includes('run 3: timer Date.now'));
  assert.ok(problems.includes('run 3: rnrs diagnostics build'));
});

test('spearman', () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.ok(Number.isNaN(spearman([1, 2], [1, 2])));
});

test('collector reassembles verified chunks of its own run and rejects altered text', () => {
  const text = JSON.stringify({ type: 'done', v: 'é a '.repeat(3) });
  const head = `${text.length}:${fnv1a(text)}`;
  const lines = [text.slice(0, 7), text.slice(7)].map(
    (c, i) => `RNRSCMP2 x1 ${i + 1}/2 ${head} ${c}|`,
  );
  const c = collector('x1');
  assert.equal(c.line(`E ReactNativeJS: RNRSCMP2 other 1/1 ${head} {}|`), null);
  assert.equal(c.line(lines[0]), null);
  assert.deepEqual(c.line(lines[1]), JSON.parse(text));
  // A trailing space lost at a chunk boundary (the iOS console defect) is detected.
  const cut = text.indexOf(' ') + 1;
  const trimmed = [text.slice(0, cut).trimEnd(), text.slice(cut)].map(
    (x, i) => `RNRSCMP2 x1 ${i + 1}/2 ${head} ${x}|`,
  );
  const d = collector('x1');
  d.line(trimmed[0]);
  assert.match(d.line(trimmed[1]).message, /transport integrity/);
});

test('the app and the runner hash identically', async () => {
  const harness = readFileSync(new URL('./app/harness.ts', import.meta.url), 'utf8');
  const body = harness.slice(
    harness.indexOf('export function fnv1a'),
    harness.indexOf('/** One report'),
  );
  const js = body.replace('export ', '').replace('(text: string): string', '(text)');
  const appFnv = new Function(`${js}; return fnv1a;`)();
  for (const t of ['', 'abc', 'é中😀', JSON.stringify({ a: [1, 2] })])
    assert.equal(appFnv(t), fnv1a(t));
});

test('nearest-rank quantiles', () => {
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1), 1);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(describe([3, 1, 2]).median, 2);
});

test('the committed cases file matches the workload table', () => {
  const committed = readFileSync(new URL('./app/cases.generated.ts', import.meta.url), 'utf8');
  assert.equal(committed, render());
});

test('a fixed n listing a subset selects the measured workloads; semantics must agree', () => {
  const subset = ['nop', 'add', 'arrIn-256'];
  const fixedN = Object.fromEntries(subset.map((w) => [w, FIXED_N[w]]));
  const set = fakeSet(flat);
  const runConfig = { ...RUN_CONFIG, fixedN };
  set.runner.runConfig = runConfig;
  for (const run of set.runs) {
    const r = run.report;
    r.config = { ...runConfig, runId: run.runId, seed: run.seed };
    const next = new Map();
    r.rows = r.rows
      .filter((row) => subset.includes(row[3]))
      .map((row) => {
        const key = `${row[0]}|${row[1]}`;
        const pos = next.get(key) ?? 0;
        next.set(key, pos + 1);
        return [row[0], row[1], pos, ...row.slice(3)];
      });
    r.semantics = [{ path: 'nitro', probe: "add('1', 2)", outcome: 'value 3' }];
  }
  assert.deepEqual(validate(set), []);
  assert.deepEqual(
    summarize(set.runs).map((w) => w.workload),
    subset,
  );
  // A listed workload must be complete, and recorded semantics must be identical across runs.
  set.runs[0].report.rows = set.runs[0].report.rows.filter((row) => row[3] !== 'add');
  set.runs[1].report.semantics = [{ path: 'nitro', probe: "add('1', 2)", outcome: 'value 12' }];
  const problems = validate(set);
  assert.ok(problems.some((p) => p.startsWith('run 1: missing sample 0|0|add|')));
  assert.ok(problems.some((p) => p.includes('recorded semantics differ from run 1')));
});

test('every run must record its out-of-contract semantics', () => {
  const set = fakeSet(flat);
  delete set.runs[1].report.semantics;
  assert.ok(validate(set).some((p) => p.includes('run 2: no recorded semantics')));
});
