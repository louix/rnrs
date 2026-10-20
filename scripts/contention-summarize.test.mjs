// The contention pilot's summaries (scripts/contention-summarize.mjs): calibration, ring gaps,
// present gaps only across contiguous sequence numbers, SurfaceFlinger parsing, and a run.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EXPECTED_HERMES, calibrate, correlateFrames, dist, evaluateTrial, parseMeminfo, parseSfLatency, parseThermal, presentGaps, ringRecords, sampleIntervals, summarizeRun} from './contention-summarize.mjs';

test('dist: nearest-rank percentiles; empty input has no zeros', () => {
  assert.deepEqual(dist([]), {n: 0});
  const d = dist([...Array(100).keys()].map(i => i + 1));
  assert.deepEqual([d.p50, d.p90, d.p99, d.max], [50, 90, 99, 100]);
});

test('calibration: offset and drift from bracketed drains, with the bound', () => {
  // mono = js + 1000 + 50e-6·js (50 ppm), brackets of ±0.1 ms.
  const drains = [0, 1000, 2000, 3000].map(js => ({jsBefore: js - 0.1, jsAfter: js + 0.1, nowNs: (js + 1000 + 50e-6 * js) * 1e6}));
  const c = calibrate(drains);
  assert.ok(Math.abs(c.driftPpm - 50) < 0.5, String(c.driftPpm));
  assert.ok(Math.abs(c.toMono(1500) - (1500 + 1000 + 0.075)) < 1e-6);
  assert.ok(c.boundMs >= 0.1 && c.boundMs < 0.11);
  assert.equal(calibrate([]), null);
});

test('ring: sequence gaps are counted and no present interval spans one', () => {
  const rec = (t, seq, frame, kind) => [t * 1e6, seq, frame, 1, kind];
  const drains = [
    {dropped: 0, highWater: 4, records: [rec(0, 0, 1, 1), rec(5, 1, 1, 2), rec(16, 2, 2, 1), rec(21, 3, 2, 2)]},
    {dropped: 2, highWater: 6, records: [rec(100, 6, 5, 2), rec(116, 7, 6, 1), rec(121, 8, 6, 2)]},
  ];
  const r = ringRecords(drains);
  assert.equal(r.gaps, 1);
  assert.equal(r.dropped, 2);
  assert.equal(r.highWater, 6);
  assert.deepEqual(presentGaps(r.recs).map(g => g.ms), [16, 21], 'the 21→100 interval crosses the gap and is not reported');
});

test('SurfaceFlinger latency: period, valid rows, pending rows excluded; unavailable output says so', () => {
  const sf = parseSfLatency('16666666\n0\t0\t0\n1000000000\t1016666666\t1000000000\n1016666666\t1033333333\t1016666666\n9223372036854775807\t9223372036854775807\t9223372036854775807\n');
  assert.equal(sf.available, true);
  assert.equal(sf.valid, 2);
  assert.ok(Math.abs(sf.refreshPeriodMs - 16.666666) < 1e-6);
  assert.ok(Math.abs(sf.actualPresentIntervalMs.max - 16.666667) < 1e-3);
  assert.equal(parseSfLatency('').available, false);
  assert.equal(parseThermal('Thermal Status: 0\n'), 0);
  assert.equal(parseThermal(''), 'unavailable');
  assert.deepEqual(parseMeminfo('Native Heap:    12000\n Graphics:   3000\n TOTAL PSS:   90000 TOTAL RSS: 1'), {totalPssKb: 90000, nativeHeapKb: 12000, graphicsKb: 3000});
});

test('a run: phases, stalls, frame correlation and touch chains within the calibration', () => {
  const off = 5000; // mono = perf + 5000
  const ticks = [], recs = [];
  let seq = 0;
  for (let i = 0; i < 120; i++) {
    const t = 1000 + i * 16;
    const frame = i + 1;
    ticks.push([t, t, 2, frame, 0, i < 60 ? 1 : 2]);
    recs.push([(t + 1 + off) * 1e6, seq++, frame, 0, 1], [(t + 6 + off) * 1e6, seq++, frame, 1, 2]);
  }
  const data = {
    phases: [{phase: 'warmup', perf: 0}, {phase: 'throughput', perf: 1000}, {phase: 'touch', perf: 1960}, {phase: 'done', perf: 2920}],
    ticks, stalls: [{index: 0, phase: 'throughput', plannedStart: 100, durationMs: 100, actualStart: 101, actualEnd: 201, skipped: false}],
    touches: [{seq: 1, phase: 'touch', nativeTs: 2000 + off - 4, jsNow: 2000, x: 1, usedAtTick: 10, usedAtJs: 2010, frame: 63, superseded: false},
      {seq: 2, phase: 'touch', nativeTs: 2020 + off, jsNow: 2021, x: 2, usedAtTick: null, usedAtJs: null, frame: null, superseded: true}],
    drains: [500, 3000].map(js => ({jsBefore: js, jsAfter: js, nowNs: (js + off) * 1e6, dropped: 0, highWater: 240, records: []})),
    snapshots: [], hermes: [{phase: 'throughput', stats: 'unavailable'}], pausedDuring: [],
  };
  data.drains[1].records = recs;
  const s = summarizeRun({id: 1, config: {profile: 'periodic-100', instrumented: true}, data});
  assert.equal(s.valid, true);
  assert.equal(s.frameCorrelation.ok, true);
  assert.deepEqual([s.frameCorrelation.jsSubmits, s.frameCorrelation.outsideTheirTick], [120, 0]);
  assert.equal(s.phases.throughput.stalls.ran, 1);
  assert.equal(s.phases.throughput.submitToPresentReturnMs.p50, 5);
  assert.equal(s.phases.throughput.presentReturnGapMs.max, 16);
  assert.deepEqual([s.touch.events, s.touch.superseded, s.touch.used], [2, 1, 1]);
  assert.equal(s.touch.nativeTimestampClock.consistent, true);
  assert.equal(s.touch.nativeToHandlerMs.p50, 4);
  assert.equal(s.hermes.samples[0].stats, 'unavailable');
  assert.match(s.hermes.note, /capacity/);
  const lost = summarizeRun({id: 2, config: {profile: 'control', instrumented: true}, data: (({drains, ...rest}) => rest)(data), incomplete: ['drains']});
  assert.equal(lost.valid, false);
  assert.equal(lost.ring, 'unavailable (ring data not captured)');
  assert.deepEqual(lost.notes, ['incomplete data (log lines lost): drains']);
});

/** Ticks every 16 ms from 1000 (perf = mono), one submit per tick at +1 ms; warm-up submits
 *  before the measured ticks are in the ring too, as on the device. */
const tickRun = (idOffset) => {
  const ticks = [], recs = [];
  for (let w = 1; w <= 5 + Math.min(0, idOffset); w++) recs.push({t: 900 + w, seq: 0, frame: w, kind: 1});
  for (let i = 0; i < 50; i++) {
    const top = 1000 + i * 16, frame = 6 + i;
    ticks.push([top, top, 2, frame, 0, 1]);
    recs.push({t: top + 1, seq: 0, frame: frame + idOffset, kind: 1});
  }
  return {ticks, recs, phases: [{phase: 'throughput', perf: 1000}, {phase: 'done', perf: 1800}]};
};
const identity = {boundMs: 0.1, toMono: x => x};

test('frame correlation is by time inside the JS tick: a constant frame-ID offset fails it', () => {
  const ok = tickRun(0);
  assert.equal(correlateFrames(ok.ticks, ok.phases, ok.recs, identity).ok, true);
  // Off by one: every ID is still "in the ring" (warm-up submits fill the low IDs)...
  const off = tickRun(-1);
  const ids = new Set(off.recs.map(r => r.frame));
  assert.ok(off.ticks.slice(0, -1).every(t => ids.has(t[3])), 'set membership would pass for all but the last');
  // ...but each frame's ring submit time lies one tick before its JS tick.
  const c = correlateFrames(off.ticks, off.phases, off.recs, identity);
  assert.equal(c.ok, false);
  assert.ok(c.outsideTheirTick >= 48, JSON.stringify(c));
});

test('present gaps: only gaps entirely inside the window; boundary-crossing ones are counted, not clipped', () => {
  const recs = [10, 30, 50, 70, 90].map((t, i) => ({t, seq: i, frame: i + 1, kind: 2, contiguous: i > 0}));
  const g = presentGaps(recs, 40, 80);
  assert.deepEqual(g.map(x => [x.from, x.to]), [[50, 70]]);
  assert.equal(g.crossing, 2, '30→50 and 70→90 straddle the window');
});

test('SurfaceFlinger: an empty/pending row breaks the sequence; no false gap is bridged across it', () => {
  const ms = x => String(BigInt(Math.round(x * 1e6)));
  const row = t => `${ms(t)}\t${ms(t + 30)}\t${ms(t)}`;
  const text = ['16666666', row(1000), row(1016.7), '0\t0\t0', row(1500), row(1516.7)].join('\n');
  const sf = parseSfLatency(text);
  assert.equal(sf.segmentBreaks, 1);
  assert.ok(sf.actualPresentIntervalMs.max < 17, 'the 1016.7 → 1500 jump spans the empty row and is not an interval');
  assert.equal(sf.actualPresentIntervalMs.n, 2);
});

const columns = ['tBefore', 'tAfter', 'js_numGCs', 'js_gcTime', 'js_gcCPUTime', 'js_allocatedBytes', 'js_totalAllocatedBytes'];
/** Samples every 16 ms; collections counted in given intervals, GC time also without a count. */
const samples = (n, {gcAt = [], multiAt = [], timeOnlyAt = []} = {}) => {
  const rows = [];
  let gcs = 0, gcTime = 0, total = 0;
  for (let i = 0; i < n; i++) {
    if (gcAt.includes(i)) { gcs += 1; gcTime += 0.001; }
    if (multiAt.includes(i)) { gcs += 2; gcTime += 0.002; }
    if (timeOnlyAt.includes(i)) gcTime += 0.0005;
    total += 10000;
    rows.push([i * 16, i * 16 + 0.05, gcs, gcTime, gcTime, 5000, total]);
  }
  return {columns, rows, count: n, overflow: 0, missing: 0};
};

test('sample intervals: changes belong to the interval before the sample; multi-count and time-without-count kept apart; small classes marked', () => {
  const h = sampleIntervals(samples(100, {gcAt: [10, 20], multiAt: [30], timeOnlyAt: [40]}));
  assert.equal(h.allMonotonic, true);
  assert.deepEqual([h.classes.oneCountChange.n, h.classes.multiCountChange.n, h.classes.timeWithoutCount.n, h.classes.noCounterChange.n], [2, 1, 1, 95]);
  assert.match(h.classes.oneCountChange.intervalMs, /insufficient events/);
  assert.equal(h.classes.noCounterChange.intervalMs.p50, 16);
  assert.equal(h.rawDeltas.numGCs, 4);
  assert.equal(h.callMs.p50, 0.05);
  const bad = samples(5);
  bad.rows[3][6] = 0; // a cumulative counter going down
  assert.equal(sampleIntervals(bad).allMonotonic, false);
});

test('trial evaluation: feasibility conditions and A repeatability targets as written in the plan', () => {
  const run = (id, arm, extra = {}) => ({id, config: {arm, block: 1}, errors: [], data: {stalls: extra.stalls ?? []}, incomplete: [], crashed: false});
  const sum = (id, extra) => ({id, frameCorrelation: {ok: true}, hermesRuntimeProperties: {'OSS Release Version': '0.14.0'}, ...extra});
  const phase = (p50, stalls) => ({throughput: {rafIntervalMs: {p50, p99: 20}, stalls}});
  const hs = sampleIntervals(samples(50));
  const runs = [run(1, 'U'), run(2, 'S'), run(3, 'H'), run(4, 'T', {stalls: [{placement: 'task'}]})];
  const summaries = [sum(1, {phases: phase(16.6)}), sum(2, {phases: phase(16.7), hermesSamples: hs}), sum(3, {hermesSamples: hs, churn: {achievedNominalBytesPerS: 2e6}}),
    sum(4, {phases: phase(16.6, {ran: 19, skipped: 0, actualMs: {min: 100.0, max: 100.01}})})];
  const identity = {selectedVersion: '0.14.0', aarSha256: EXPECTED_HERMES.aarSha256, apkLibhermesvmSha256: EXPECTED_HERMES.libhermesvmSha256};
  const ok = evaluateTrial('feasibility', runs, summaries, identity);
  assert.equal(ok.proceed, true, JSON.stringify(Object.fromEntries(Object.entries(ok.conditions).map(([k, v]) => [k, v.met]))));
  assert.equal(evaluateTrial('feasibility', runs, summaries, {...identity, apkLibhermesvmSha256: 'other'}).proceed, false, 'a different Hermes binary stops the trial');
  // A: three R medians spanning 12 ms miss the 10 ms target; separation is only descriptive.
  const aRuns = ['C', 'R', 'T', 'R', 'T', 'C', 'T', 'C', 'R'].map((a, i) => run(i + 1, a));
  const gap = {R: [120, 125, 132], T: [100, 101, 103]}, idx = {R: 0, T: 0};
  const aSums = aRuns.map(r => sum(r.id, {phases: {throughput: {rafIntervalMs: {p50: 16.6, p99: 20}, stalls: {startLateMs: {p50: 5}}, presentReturnGapMs: {p99: 22},
    longestPresentGapPerStallMs: r.config.arm === 'C' ? undefined : {p50: gap[r.config.arm][idx[r.config.arm]++], max: 140}}}}));
  const a = evaluateTrial('A', aRuns, aSums, null);
  assert.deepEqual([a.repeatability.R.met, a.repeatability.T.met, a.repeatability.C.met], [false, true, true]);
  assert.equal(a.placement.observedSeparation, true);
  assert.equal(a.placement.RminusT, 24);
});

test('sample intervals: a missing (NaN) counter or a decrease is unclassified, never dropped silently', () => {
  const h = samples(20, {gcAt: [5]});
  h.rows[10][3] = NaN; // js_gcTime missing in one sample: its two intervals are unclassified
  h.rows[15][6] = h.rows[14][6] - 1; // totalAllocatedBytes going down
  h.rows[18][5] = NaN; // js_allocatedBytes missing: counted in nanRows
  const r = sampleIntervals(h);
  assert.equal(r.intervals, 19);
  assert.equal(r.unclassified, 3);
  assert.equal(r.exhaustive, true);
  const counted = Object.values(r.classes).reduce((n, c) => n + c.n, 0);
  assert.equal(counted + r.unclassified, r.intervals);
  assert.equal(r.nanRows, 2);
  assert.equal(r.allMonotonic, false);
});
