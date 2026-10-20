// The contention-run helpers (fixtures/paddle-game/contention.ts): run selection, the stall
// schedule and absolute-deadline runner (skips, no backlog), touch correlation, ring decoding
// and the session's phases. Node strips the TS types on import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHURN_ARRAY_NOMINAL_BYTES,
  HermesSampler,
  Session,
  StallRunner,
  TouchLog,
  THROUGHPUT_MS,
  TOUCH_MS,
  WARMUP_MS,
  churn,
  decodeDrain,
  pacedLog,
  parseConfig,
  schedule,
} from '../fixtures/paddle-game/contention.ts';

/** A fake monotonic clock that advances `tick` ms on every read (so busy waits terminate). */
const fakeClock = (tick = 0.25) => {
  const c = { t: 0, now: () => (c.t += tick) };
  return c;
};

test('run selection: only an rnrgame://contention URI selects a run; unknown values throw', () => {
  assert.equal(parseConfig(null), null);
  assert.equal(parseConfig('https://example.com'), null);
  assert.deepEqual(parseConfig('rnrgame://contention?profile=control&run=r1'), {
    run: 'r1',
    profile: 'control',
    placement: 'raf',
    instrumented: true,
    touch: false,
    churn: 0,
    hermes: 'phase',
  });
  assert.deepEqual(
    parseConfig(
      'rnrgame://contention?profile=burst-500&placement=task&instrumented=0&touch=1&run=x',
    ),
    {
      run: 'x',
      profile: 'burst-500',
      placement: 'task',
      instrumented: false,
      touch: true,
      churn: 0,
      hermes: 'phase',
    },
  );
  assert.throws(() => parseConfig('rnrgame://contention?profile=heavy'));
  assert.throws(() => parseConfig('rnrgame://contention?profile=control&placement=idle'));
});

test('schedule: periodic-100 every second inside the phase; burst-500 at 8 s; control none', () => {
  assert.deepEqual(schedule('control', THROUGHPUT_MS), []);
  const p = schedule('periodic-100', THROUGHPUT_MS);
  assert.equal(p.length, 19);
  assert.deepEqual(p[0], { at: 1000, durationMs: 100 });
  assert.equal(p.at(-1).at, 19000);
  assert.deepEqual(schedule('burst-500', TOUCH_MS), [{ at: 8000, durationMs: 500 }]);
});

test('stall runner: due deadlines run for their duration; overtaken ones are skipped, never run late', () => {
  const c = fakeClock();
  const plan = [
    { at: 100, durationMs: 50 },
    { at: 200, durationMs: 50 },
    { at: 300, durationMs: 50 },
    { at: 400, durationMs: 50 },
  ];
  const r = new StallRunner(plan, 'throughput', 0, 'raf', c.now);
  c.t = 99;
  r.poll();
  assert.equal(r.records.length, 0, 'not yet due');
  c.t = 105;
  r.poll();
  assert.equal(r.records.length, 1);
  const first = r.records[0];
  assert.equal(first.skipped, false);
  assert.ok(
    first.actualStart >= 105 && first.actualEnd - first.actualStart >= 50,
    JSON.stringify(first),
  );
  // The JS thread comes back after 310: deadline 200 was overtaken by 300, so only 300 runs.
  c.t = 310;
  r.poll();
  assert.deepEqual(
    r.records.slice(1).map((x) => [x.plannedStart, x.skipped]),
    [
      [200, true],
      [300, false],
    ],
  );
  assert.equal(r.records[1].actualStart, null);
  r.stop();
  assert.deepEqual(
    r.records.map((x) => [x.plannedStart, x.skipped]),
    [
      [100, false],
      [200, true],
      [300, false],
      [400, true],
    ],
    'unreached deadlines are skipped at stop',
  );
});

test('touch log: the first step using a touch and the frame carrying it; superseded touches have no latency', () => {
  const t = new TouchLog();
  t.add('touch', 1000, 1005, 10);
  t.add('touch', 1008, 1010, 20); // replaces #1 before any step used it
  t.use(50, 1012);
  t.use(51, 1013); // no new touch: nothing changes
  t.submitted(7);
  t.add('touch', 1020, 1022, 30);
  t.submitted(8); // no step used #3 yet: no frame
  t.use(60, 1030);
  t.submitted(9);
  assert.deepEqual(
    t.records.map((r) => [r.seq, r.superseded, r.usedAtTick, r.frame]),
    [
      [1, true, null, null],
      [2, false, 50, 7],
      [3, false, 60, 9],
    ],
  );
});

test('ring decoding: header and records as written by the renderer', () => {
  const buf = new ArrayBuffer(40 + 2 * 24);
  const v = new DataView(buf);
  const u64 = (o, n) => {
    v.setUint32(o, n % 4294967296, true);
    v.setUint32(o + 4, Math.floor(n / 4294967296), true);
  };
  v.setUint32(0, 0x544e5252, true);
  v.setUint32(4, 1, true);
  v.setUint32(8, 2, true);
  v.setUint32(12, 5, true);
  u64(16, 3);
  u64(24, 123456789012345);
  v.setUint32(32, 8192, true);
  u64(40, 123456789000000);
  v.setUint32(48, 9, true);
  v.setUint32(52, 4, true);
  v.setUint32(56, 0, true);
  v.setUint16(60, 1, true);
  u64(64, 123456789000500);
  v.setUint32(72, 10, true);
  v.setUint32(76, 4, true);
  v.setUint32(80, 2, true);
  v.setUint16(84, 2, true);
  const d = decodeDrain(buf, 1, 2);
  assert.deepEqual(
    { ...d, records: undefined },
    {
      jsBefore: 1,
      jsAfter: 2,
      nowNs: 123456789012345,
      count: 2,
      dropped: 3,
      highWater: 5,
      capacity: 8192,
      records: undefined,
    },
  );
  assert.deepEqual(d.records, [
    [123456789000000, 9, 4, 0, 1],
    [123456789000500, 10, 4, 2, 2],
  ]);
  assert.equal(decodeDrain(new ArrayBuffer(0), 0, 0), null, 'uninstrumented: nothing');
});

test('session: warm-up, throughput and touch phases by wall time, stalls only in measured phases, data then "done"', () => {
  const c = fakeClock(0.01);
  const lines = [];
  const s = new Session(
    parseConfig('rnrgame://contention?profile=periodic-100&touch=1&run=t'),
    c.now,
    (l) => lines.push(l),
    (ls) => lines.push(...ls),
  );
  {
    let drained = 0;
    for (let frame = 0; c.t < WARMUP_MS + THROUGHPUT_MS + TOUCH_MS + 100; frame++) {
      const tTop = c.now();
      s.beginTick(true, () => drained++);
      if (s.phase === 'touch' && frame % 30 === 0) s.touch(c.t - 3, frame);
      s.beforeSteps(2, frame * 2);
      s.endTick(tTop, tTop, 2, true, 0);
      c.t += 16.67;
    }
    assert.deepEqual(
      s.phases.map((p) => p.phase),
      ['warmup', 'throughput', 'touch', 'done'],
    );
    assert.equal(drained, 1, 'one final drain');
    assert.equal(s.stalls.length, 19 + 14);
    assert.ok(s.stalls.every((x) => x.skipped || x.actualEnd - x.actualStart >= 100));
    assert.ok(
      s.ticks.every((t) => t[5] === 1 || t[5] === 2),
      'no warm-up ticks recorded',
    );
    assert.ok(s.touches.records.length > 0 && s.touches.records.every((t) => t.frame !== null));
    assert.ok(
      lines.at(-1).startsWith('RNR_CONTENTION ') &&
        JSON.parse(lines.at(-1).slice(15)).event === 'done',
    );
    assert.ok(
      lines.filter((l) => l.startsWith('RNR_CONTENTION_DATA ')).every((l) => l.length < 4000),
    );
  }
});

test('paced log: every line, in order, a batch per interval', async () => {
  const out = [];
  pacedLog(
    Array.from({ length: 20 }, (_, i) => String(i)),
    (l) => out.push(l),
    8,
    5,
  );
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.ok(out.length < 20, 'not all at once');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(
    out,
    Array.from({ length: 20 }, (_, i) => String(i)),
  );
});

test('session: a throughput-only run ends after the throughput phase; pauses while measuring are recorded', () => {
  const c = fakeClock(0.01);
  const s = new Session(
    parseConfig('rnrgame://contention?profile=control&run=b'),
    c.now,
    () => {},
    () => {},
  );
  for (; c.t < WARMUP_MS + THROUGHPUT_MS + 100; c.t += 16.67)
    s.beginTick(!(c.t > 7000 && c.t < 7100), () => {});
  assert.deepEqual(
    s.phases.map((p) => p.phase),
    ['warmup', 'throughput', 'done'],
  );
  assert.equal(s.pausedDuring.length, 1);
});

test('config: churn and Hermes sampling options, validated', () => {
  const c = parseConfig('rnrgame://contention?profile=control&churn=33334&hermes=tick&run=b');
  assert.deepEqual([c.churn, c.hermes], [33334, 'tick']);
  assert.deepEqual(
    [
      parseConfig('rnrgame://contention?profile=control').churn,
      parseConfig('rnrgame://contention?profile=control').hermes,
    ],
    [0, 'phase'],
  );
  assert.throws(() => parseConfig('rnrgame://contention?profile=control&churn=1.5'));
  assert.throws(() => parseConfig('rnrgame://contention?profile=control&churn=-1'));
  assert.throws(() => parseConfig('rnrgame://contention?profile=control&hermes=always'));
});

test('Hermes sampler: bracketing timestamps, counters in order, bounded with overflow and missing counted', () => {
  let t = 0,
    gcs = 0;
  const s = new HermesSampler(
    2,
    () => (t += 1),
    () => ({
      js_numGCs: ++gcs,
      js_gcTime: 0.5,
      js_gcCPUTime: 0.25,
      js_allocatedBytes: 100,
      js_totalAllocatedBytes: 1000 * gcs,
    }),
  );
  s.sample();
  s.sample();
  s.sample();
  assert.deepEqual(s.rows(), [
    [1, 2, 1, 0.5, 0.25, 100, 1000],
    [3, 4, 2, 0.5, 0.25, 100, 2000],
  ]);
  assert.deepEqual([s.count, s.overflow, s.missing], [2, 1, 0]);
  const partial = new HermesSampler(
    1,
    () => 0,
    () => ({ js_numGCs: 1 }),
  );
  partial.sample();
  assert.deepEqual(
    [partial.missing, partial.missingCounters],
    [0, 1],
    'a stats object lacking counters is counted',
  );
  const none = new HermesSampler(
    1,
    () => 0,
    () => null,
  );
  none.sample();
  assert.equal(none.missing, 1);
  assert.ok(none.rows()[0].slice(2).every(Number.isNaN), 'unavailable counters are NaN, never 0');
});

test('churn: whole nominal arrays per call; session churns only in measured phases and samples before stalls', () => {
  assert.equal(churn(0), 0);
  assert.equal(churn(CHURN_ARRAY_NOMINAL_BYTES * 3 + 1), 4);
  const c = fakeClock(0.01);
  const lines = [];
  const s = new Session(
    parseConfig('rnrgame://contention?profile=periodic-100&churn=2048&hermes=tick&run=g'),
    c.now,
    (l) => lines.push(l),
    (ls) => lines.push(...ls),
  );
  for (; c.t < WARMUP_MS + THROUGHPUT_MS + 100; c.t += 16.67) {
    s.beginTick(true, () => {});
    s.afterSubmit();
  }
  assert.ok(s.churnTicks > 1000 && s.churnTicks < 1250, String(s.churnTicks)); // fewer ticks: the stalls
  assert.equal(s.churnArrays, s.churnTicks * 2);
  assert.equal(s.sampler.count, s.churnTicks, 'one sample per measured tick');
  // A sample taken on a stall tick precedes the stall: its tAfter is at or before the stall start.
  const start = s.phases.find((p) => p.phase === 'throughput').perf;
  const rows = s.sampler.rows();
  for (const st of s.stalls.filter((x) => !x.skipped)) {
    const before = rows.filter((r) => r[1] <= start + st.actualStart);
    assert.ok(before.length > 0);
  }
  const data = lines
    .filter((l) => l.startsWith('RNR_CONTENTION_DATA '))
    .map((l) => JSON.parse(l.slice(20)).key);
  assert.ok(['runtime', 'churn', 'hermesSamples'].every((k) => data.includes(k)));
});

test('config: an empty churn value is rejected, not read as 0', () => {
  assert.throws(() => parseConfig('rnrgame://contention?profile=control&churn='));
  assert.throws(() => parseConfig('rnrgame://contention?profile=control&churn=%20'));
  assert.throws(() => parseConfig('rnrgame://contention?profile=control&hermes='));
});
