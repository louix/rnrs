import test from 'node:test';
import assert from 'node:assert/strict';
import { PARTIAL_CONTROLS, percentile, summarize } from './pilot-summarize.mjs';

test('nearest-rank percentiles', () => {
  const v = Array.from({ length: 16 }, (_, i) => i + 1);
  assert.equal(percentile(v, 0.5), 8);
  assert.equal(percentile(v, 0.1), 2);
  assert.equal(percentile(v, 0.9), 15);
  assert.equal(percentile([], 0.5), null);
});

test('summaries pool rounds across runs and withhold p99 below 1000 samples', () => {
  const run = (n, base) => ({
    n,
    raw: { seed: n },
    pilot: {
      controlNotes: {},
      throughput: {
        cases: [
          {
            id: 'scalar',
            group: 'scalar',
            iterations: 10 * n,
            impls: [{ kind: 'generated' }, { kind: 'matched' }],
          },
          {
            id: 'cell-call',
            group: 'native object',
            iterations: 5,
            impls: [{ kind: 'generated' }, { kind: 'matched' }],
          },
        ],
        samples: Array.from({ length: 8 }, (_, round) => [
          {
            round,
            case: 'scalar',
            impl: 'generated',
            iterations: 10,
            ms: 1,
            usPerCall: base + round,
          },
          {
            round,
            case: 'scalar',
            impl: 'matched',
            iterations: 10,
            ms: 1,
            usPerCall: (base + round) / 2,
          },
          { round, case: 'cell-call', impl: 'generated', iterations: 5, ms: 1, usPerCall: 1 },
          { round, case: 'cell-call', impl: 'matched', iterations: 5, ms: 1, usPerCall: 0.006 },
        ]).flat(),
      },
      asyncLatency: {
        generated: [...Array(9).fill(0.01), 0.06],
        jsPromise: Array(10).fill(0.001),
        jsTimeout: Array(10).fill(4),
      },
      continuous: {
        lag: {
          samples: Array(500).fill(1),
          missedTicks: 0,
          pendingAtStopMs: 0,
          expectedTicks: 500,
          overflowed: false,
        },
        chunkMs: [4, 4],
        chunks: 2,
        calls: 10,
        asyncDone: 8,
        durationMs: 20000,
        memory: [{ atMs: 0, counters: { x: 1, y: null } }],
      },
      lifetime: {
        before: { stats: { native: { Cell: { created: 0, dropped: 0 } } }, counters: {} },
        holding: { stats: { native: { Cell: { created: 5, dropped: 0 } } }, counters: {} },
        after: {
          stats: { native: { Cell: { created: 5, dropped: n === 1 ? 5 : 3 } } },
          counters: {},
        },
        forcedGcRounds: 2,
      },
    },
  });
  const s = summarize('web', [run(1, 10), run(2, 20)]);
  const c = s.cases.find((x) => x.id === 'scalar');
  assert.equal(c.impls.generated.n, 16);
  assert.equal(c.impls.generated.medianUs, 17);
  assert.equal(c.generatedOverMatched, 2);
  // Per-run ratios, differences and call counts are reported, not only the pooled ratio.
  assert.deepEqual(c.generatedOverMatchedPerRun, [2, 2]);
  assert.deepEqual(c.generatedMinusMatchedUsPerRun, [6.5, 11.5]);
  assert.deepEqual(c.iterationsPerMeasurement, [10, 20]);
  assert.equal(c.matchedControl, 'matched');
  // Partial controls: no comparable ratio, absolutes kept.
  assert.ok(PARTIAL_CONTROLS.web.includes('cell-call'));
  const cell = s.cases.find((x) => x.id === 'cell-call');
  assert.equal(cell.matchedControl, 'partial');
  assert.equal(cell.generatedOverMatched, null);
  assert.equal(cell.generatedOverMatchedPerRun, null);
  assert.equal(cell.generatedMinusMatchedUs, 0.994);
  assert.deepEqual(s.latency.generated.perRunOver50Us, [1, 1]);
  // Convergence comes from the counters, not the recorded round count.
  assert.deepEqual(
    s.lifetime.map((l) => l.converged),
    [true, false],
  );
  assert.equal(s.lifetime[0].forcedGcRoundsAsRecorded, 2);
  assert.equal(s.lifetime[0].adoptedBuffersLive.before, 'unavailable');
  assert.equal(s.lag[0].idle, null);
  assert.equal(s.lag[0].p99Ms, null);
  assert.equal(s.latency.generated.p99Us, null);
  assert.equal(s.memory[0].inProcess.y, 'unavailable');
});
