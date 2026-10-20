// Summaries of the paddle-game contention pilot (docs/research/js-contention-plan.md) from the
// per-run JSON written by scripts/consumer/contention-device-test.mjs. Pure functions; the CLI
// re-summarizes a run directory: node scripts/contention-summarize.mjs <run-dir>
//
// Limits kept explicit in the output:
// - present records are present-call returns, not display refresh;
// - intervals are computed only between records whose sequence numbers are contiguous;
// - JS↔monotonic mapping comes from drain bracketing; values carry its error bound;
// - anything not captured is "unavailable", never 0.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STEP_MS = 1000 / 120;
/** Ring kinds; 3 is any unsuccessful present call (skipped, revoked, surface/device lost, failed). */
const KIND = { submit: 1, present: 2, unsuccessful: 3 };

export function dist(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0 };
  const q = (p) => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)];
  const r = (x) => Math.round(x * 1000) / 1000;
  return {
    n: v.length,
    p50: r(q(0.5)),
    p90: r(q(0.9)),
    p99: r(q(0.99)),
    max: r(v[v.length - 1]),
    min: r(v[0]),
  };
}

/** JS performance.now (ms) → CLOCK_MONOTONIC (ms): least-squares offset and drift over the
 *  drains, each bracketed by performance.now; the bound is the widest half-bracket plus the
 *  largest fit residual. */
export function calibrate(drains) {
  const pts = drains.map((d) => ({
    x: (d.jsBefore + d.jsAfter) / 2,
    y: d.nowNs / 1e6 - (d.jsBefore + d.jsAfter) / 2,
    half: (d.jsAfter - d.jsBefore) / 2,
  }));
  if (pts.length === 0) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const slope = n > 1 && sxx > 0 ? pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / sxx : 0;
  const offsetAt = (x) => my + slope * (x - mx);
  const residual = Math.max(...pts.map((p) => Math.abs(p.y - offsetAt(p.x))));
  const half = Math.max(...pts.map((p) => p.half));
  return {
    points: n,
    offsetMs: my,
    driftPpm: slope * 1e6,
    maxHalfBracketMs: half,
    maxResidualMs: residual,
    boundMs: half + residual,
    toMono: (x) => x + offsetAt(x),
  };
}

/** Ring records of all drains in order, with sequence gaps (dropped or missing) marked. */
export function ringRecords(drains) {
  const recs = drains.flatMap((d) =>
    d.records.map(([tNs, seq, frame, attachment, kind]) => ({
      t: tNs / 1e6,
      seq,
      frame,
      attachment,
      kind,
    })),
  );
  let gaps = 0;
  for (let i = 1; i < recs.length; i++) {
    recs[i].contiguous = recs[i].seq === (recs[i - 1].seq + 1) >>> 0;
    if (!recs[i].contiguous) gaps++;
  }
  if (recs.length) recs[0].contiguous = false;
  return {
    recs,
    gaps,
    dropped: drains.length ? drains[drains.length - 1].dropped : null,
    highWater: drains.length ? Math.max(...drains.map((d) => d.highWater)) : null,
  };
}

/** Intervals between consecutive present returns, only across contiguous sequence numbers,
 *  and only those lying entirely within [from, to]; `crossing` counts those that straddle a
 *  boundary (excluded, not clipped). */
export function presentGaps(recs, from = -Infinity, to = Infinity) {
  const gaps = [];
  let crossing = 0;
  let prev = null;
  for (const r of recs) {
    if (!r.contiguous) prev = null;
    if (r.kind !== KIND.present) continue;
    if (prev) {
      if (prev.t >= from && r.t <= to)
        gaps.push({ from: prev.t, to: r.t, ms: r.t - prev.t, frame: r.frame });
      else if (prev.t < to && r.t > from) crossing++;
    }
    prev = r;
  }
  gaps.crossing = crossing;
  return gaps;
}

/** Frame correlation by time, not set membership: for each JS tick that submitted frame f, the
 *  ring's submit record for f must lie between that tick's top and the next tick's top (or the
 *  "done" phase start), both mapped to CLOCK_MONOTONIC, widened by the calibration bound. A
 *  constant frame-ID offset puts the submit one tick away and fails this. */
export function correlateFrames(ticks, phases, recs, cal) {
  const submitAt = new Map();
  let duplicates = 0;
  for (const r of recs) {
    if (r.kind !== KIND.submit) continue;
    if (submitAt.has(r.frame)) duplicates++;
    submitAt.set(r.frame, r.t);
  }
  const doneAt = phases.find((p) => p.phase === 'done')?.perf;
  const b = cal.boundMs;
  let jsSubmits = 0,
    missing = 0,
    unbounded = 0;
  const outside = [];
  ticks.forEach((t, i) => {
    if (t[3] === 0) return;
    jsSubmits++;
    const at = submitAt.get(t[3]);
    if (at === undefined) return void missing++;
    const nextTop = i + 1 < ticks.length ? ticks[i + 1][0] : doneAt;
    if (nextTop === undefined) unbounded++;
    const lo = cal.toMono(t[0]) - b,
      hi = nextTop === undefined ? Infinity : cal.toMono(nextTop) + b;
    if (at < lo || at > hi)
      outside.push({
        frame: t[3],
        fromTickTopMs: round(at - cal.toMono(t[0])),
        tickMs: nextTop === undefined ? null : round(nextTop - t[0]),
      });
  });
  return {
    jsSubmits,
    missingInRing: missing,
    outsideTheirTick: outside.length,
    examples: outside.slice(0, 5),
    duplicateRingIds: duplicates,
    withoutUpperBound: unbounded,
    boundMs: round(b),
    ok: jsSubmits > 0 && missing === 0 && outside.length === 0 && duplicates === 0,
  };
}

/** SurfaceFlinger `--latency <layer>`: refresh period, then rows [desiredPresent, actualPresent,
 *  frameReady] in ns (CLOCK_MONOTONIC), oldest first. Rows with 0 or INT64_MAX are pending or
 *  empty: they break the sequence, so no interval bridges them (nor a non-increasing row).
 *  Intervals are differences within one clock and need no calibration; only aligning them
 *  with the app's phases does. */
export function parseSfLatency(text) {
  const lines = text
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0 || !/^\d+$/.test(lines[0]))
    return { available: false, reason: lines[0] ?? 'empty' };
  const MAX = 9223372036854775807n;
  const rows = lines
    .slice(1)
    .map((l) => l.split(/\s+/).map(BigInt))
    .filter((r) => r.length === 3);
  const intervals = [];
  const actual = [];
  let prev = null,
    breaks = 0;
  for (const r of rows) {
    if (!r.every((x) => x !== 0n && x !== MAX)) {
      if (prev !== null) breaks++;
      prev = null;
      continue;
    }
    const t = Number(r[1]) / 1e6;
    actual.push(t);
    if (prev !== null && t > prev) intervals.push({ from: prev, to: t, ms: t - prev });
    else if (prev !== null) breaks++;
    prev = t;
  }
  return {
    available: actual.length > 0,
    refreshPeriodMs: Number(lines[0]) / 1e6,
    rows: rows.length,
    valid: actual.length,
    segmentBreaks: breaks,
    windowMs: actual.length ? [Math.min(...actual), Math.max(...actual)] : null,
    actualPresentIntervalMs: dist(intervals.map((i) => i.ms)),
    intervals,
    actualPresent: actual,
  };
}

/** Per-tick Hermes samples (`hermes=tick`): counter changes are associated with the interval
 *  between two consecutive samples (tBefore to tBefore), never with a single collection. Counter
 *  units and collector interpretation are unverified (see the trial plan). */
export const MIN_CLASS_EVENTS = 10;
export function sampleIntervals(hs) {
  const col = Object.fromEntries(hs.columns.map((c, i) => [c, i]));
  const rows = hs.rows;
  const cumulative = ['js_numGCs', 'js_gcTime', 'js_gcCPUTime', 'js_totalAllocatedBytes'];
  // NaN is not monotonic: a missing value cannot show the counter did not go down.
  const monotonic = Object.fromEntries(
    cumulative.map((c) => [
      c,
      rows.every(
        (r, i) => !Number.isNaN(r[col[c]]) && (i === 0 || r[col[c]] >= rows[i - 1][col[c]]),
      ),
    ]),
  );
  const counters = [...cumulative, 'js_allocatedBytes'];
  const nan = rows.filter((r) => counters.some((c) => Number.isNaN(r[col[c]]))).length;
  const intervals = rows.slice(1).map((r, i) => {
    const p = rows[i];
    return {
      ms: r[col.tBefore] - p[col.tBefore],
      dGCs: r[col.js_numGCs] - p[col.js_numGCs],
      dGcTime: r[col.js_gcTime] - p[col.js_gcTime],
      dGcCpu: r[col.js_gcCPUTime] - p[col.js_gcCPUTime],
      dAlloc: r[col.js_totalAllocatedBytes] - p[col.js_totalAllocatedBytes],
    };
  });
  // An interval with a NaN delta or a decreasing cumulative counter is not classified: it is
  // counted as unclassified, so the classes plus unclassified always add up to all intervals.
  const sane = (x) =>
    [x.dGCs, x.dGcTime, x.dGcCpu, x.dAlloc].every((v) => Number.isFinite(v) && v >= 0);
  const ok = intervals.filter(sane);
  const cls = {
    noCounterChange: ok.filter((x) => x.dGCs === 0 && x.dGcTime === 0 && x.dGcCpu === 0),
    oneCountChange: ok.filter((x) => x.dGCs === 1),
    multiCountChange: ok.filter((x) => x.dGCs > 1),
    timeWithoutCount: ok.filter((x) => x.dGCs === 0 && (x.dGcTime > 0 || x.dGcCpu > 0)),
  };
  const unclassified = intervals.length - ok.length;
  const classified = Object.values(cls).reduce((n, v) => n + v.length, 0);
  const describe = (xs) =>
    xs.length >= MIN_CLASS_EVENTS
      ? { n: xs.length, intervalMs: dist(xs.map((x) => x.ms)) }
      : { n: xs.length, intervalMs: `insufficient events (< ${MIN_CLASS_EVENTS})` };
  const first = rows[0],
    last = rows[rows.length - 1];
  const spanMs = rows.length > 1 ? last[col.tBefore] - first[col.tBefore] : null;
  return {
    note: 'changes belong to the interval between two consecutive bracketed samples (tBefore to tBefore), not to a rAF tick; js_numGCs counts recorded GC events, not collections; units and collector interpretation unverified; descriptive, not causal',
    intervals: intervals.length,
    unclassified,
    exhaustive: classified + unclassified === intervals.length,
    samples: hs.count,
    overflow: hs.overflow,
    missing: hs.missing,
    missingCounters: hs.missingCounters ?? 'not recorded (older fixture)',
    nanRows: nan,
    monotonic,
    allMonotonic: Object.values(monotonic).every(Boolean),
    callMs: dist(rows.map((r) => r[col.tAfter] - r[col.tBefore])),
    classes: Object.fromEntries(Object.entries(cls).map(([k, v]) => [k, describe(v)])),
    rawDeltas:
      rows.length > 1
        ? {
            numGCs: last[col.js_numGCs] - first[col.js_numGCs],
            gcTime: last[col.js_gcTime] - first[col.js_gcTime],
            gcCPUTime: last[col.js_gcCPUTime] - first[col.js_gcCPUTime],
            totalAllocatedBytes:
              last[col.js_totalAllocatedBytes] - first[col.js_totalAllocatedBytes],
            spanMs: round(spanMs),
          }
        : null,
  };
}

export function parseMeminfo(text) {
  const pick = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : 'unavailable';
  };
  return {
    totalPssKb: pick(/TOTAL(?: PSS)?:?\s+(\d+)/),
    nativeHeapKb: pick(/Native Heap:\s+(\d+)/),
    graphicsKb: pick(/Graphics:\s+(\d+)/),
  };
}

export function parseThermal(text) {
  const m = text.match(/Thermal Status:\s*(\d+)/);
  return m ? Number(m[1]) : 'unavailable';
}

export function parseGfxinfo(text) {
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : 'unavailable';
  };
  return {
    note: 'app window (React Native views) render pipeline only; not SurfaceView, compositor or display timing',
    totalFrames: num(/Total frames rendered:\s*(\d+)/),
    jankyFrames: num(/Janky frames:\s*(\d+)/),
    p50Ms: num(/50th percentile:\s*(\d+)ms/),
    p99Ms: num(/99th percentile:\s*(\d+)ms/),
  };
}

/** One run's summary. `run` is the per-run JSON (config, data from the app, captures). */
export function summarizeRun(run) {
  const out = { id: run.id, config: run.config, valid: true, notes: [] };
  if (!run.data) return { ...out, valid: false, notes: ['no app data'] };
  // Keys whose log chunks were not all captured are absent: their metrics become unavailable.
  const d = {
    phases: [],
    ticks: [],
    stalls: [],
    touches: [],
    drains: [],
    snapshots: [],
    pausedDuring: [],
    ...run.data,
  };
  if (run.incomplete?.length) {
    out.valid = false;
    out.notes.push(`incomplete data (log lines lost): ${run.incomplete.join(', ')}`);
  }
  if (d.pausedDuring?.length) {
    out.valid = false;
    out.notes.push(`lifecycle pause during a measured phase: ${JSON.stringify(d.pausedDuring)}`);
  }
  const phaseStart = Object.fromEntries(d.phases.map((p) => [p.phase, p.perf]));
  const measured = d.phases
    .filter((p) => p.phase === 'throughput' || p.phase === 'touch')
    .map((p) => p.phase);
  const end = (ph) => d.phases[d.phases.findIndex((p) => p.phase === ph) + 1]?.perf;
  const missing = run.config?.instrumented
    ? 'unavailable (ring data not captured)'
    : 'unavailable (uninstrumented)';
  const cal = calibrate(d.drains);
  out.calibration = cal
    ? {
        points: cal.points,
        offsetMs: round(cal.offsetMs),
        driftPpm: round(cal.driftPpm),
        boundMs: round(cal.boundMs),
        maxHalfBracketMs: round(cal.maxHalfBracketMs),
      }
    : missing;
  const ring = d.drains.length ? ringRecords(d.drains) : null;
  out.ring = ring
    ? {
        records: ring.recs.length,
        sequenceGaps: ring.gaps,
        dropped: ring.dropped,
        highWater: ring.highWater,
      }
    : missing;
  // Frame correlation: each JS submit's ring record lies inside its JS tick (mapped clock).
  if (ring && cal) {
    const c = correlateFrames(d.ticks, d.phases, ring.recs, cal);
    out.frameCorrelation = { ...c, ok: c.ok && ring.gaps === 0 };
  }
  out.phases = {};
  for (const ph of measured) {
    const ticks = d.ticks.filter((t) => t[5] === (ph === 'throughput' ? 1 : 2));
    const durMs = end(ph) - phaseStart[ph];
    const raf = ticks.slice(1).map((t, i) => t[1] - ticks[i][1]);
    const top = ticks.slice(1).map((t, i) => t[0] - ticks[i][0]);
    const steps = ticks.reduce((s, t) => s + t[2], 0);
    const stalls = d.stalls.filter((s) => s.phase === ph);
    const ran = stalls.filter((s) => !s.skipped);
    const p = {
      wallMs: round(durMs),
      ticks: ticks.length,
      rafIntervalMs: dist(raf),
      tickTopIntervalMs: dist(top),
      stepsPerTick: dist(ticks.map((t) => t[2])),
      simulatedMs: round(steps * STEP_MS),
      simulatedOverWall: round((steps * STEP_MS) / durMs),
      droppedMs: ticks.length ? round(ticks[ticks.length - 1][4] - ticks[0][4]) : 0,
      submits: ticks.filter((t) => t[3] > 0).length,
      stalls: {
        planned: stalls.length,
        ran: ran.length,
        skipped: stalls.length - ran.length,
        actualMs: dist(ran.map((s) => s.actualEnd - s.actualStart)),
        startLateMs: dist(ran.map((s) => s.actualStart - s.plannedStart)),
      },
    };
    const snaps = d.snapshots.filter((s) => s.phase === ph);
    if (snaps.length > 1) {
      const a = snaps[0],
        b = snaps[snaps.length - 1];
      p.presentedPerS = round(
        (b.stats.framesPresented - a.stats.framesPresented) / ((b.perf - a.perf) / 1000),
      );
      p.snapshotLastRasterMs = dist(snaps.map((s) => s.stats.lastRasterMs));
      p.snapshotLastPresentMs = dist(snaps.map((s) => s.stats.lastPresentMs));
    }
    if (ring && cal) {
      const from = cal.toMono(phaseStart[ph]),
        to = cal.toMono(end(ph));
      const gaps = presentGaps(ring.recs, from, to);
      p.presentReturnGapMs = {
        ...dist(gaps.map((g) => g.ms)),
        crossingPhaseBoundaryExcluded: gaps.crossing,
        note: 'present-call returns, not display refresh; gaps entirely within the phase',
      };
      // Per stall that ran: the longest present gap overlapping it.
      const stallMono = (s) => [
        cal.toMono(phaseStart[ph] + s.actualStart),
        cal.toMono(phaseStart[ph] + s.actualEnd),
      ];
      const perStall = ran.map((s) => {
        const [a, b] = stallMono(s);
        return Math.max(0, ...gaps.filter((g) => g.from < b && g.to > a).map((g) => g.ms));
      });
      if (ran.length)
        p.longestPresentGapPerStallMs = {
          ...dist(perStall),
          stallsWithoutOverlappingGap: perStall.filter((x) => x === 0).length,
        };
      // The longest gaps, with the stalls (mapped to monotonic) that overlap them.
      p.longestPresentGaps = gaps
        .sort((x, y) => y.ms - x.ms)
        .slice(0, 5)
        .map((g) => ({
          ms: round(g.ms),
          startInPhaseMs: round(g.from - from),
          overlappingStalls: ran
            .filter((s) => {
              const [a, b] = stallMono(s);
              return a < g.to && b > g.from;
            })
            .map((s) => s.index),
        }));
      // Submit → first present return of the same frame, for frames submitted in this phase
      // (the present may fall after the phase end); frames replaced before presenting.
      const submitAt = new Map(),
        presentAt = new Map();
      for (const r of ring.recs) {
        if (r.kind === KIND.submit && r.t >= from && r.t <= to) submitAt.set(r.frame, r.t);
        else if (r.kind === KIND.present && !presentAt.has(r.frame)) presentAt.set(r.frame, r.t);
      }
      const lat = [...submitAt]
        .filter(([f]) => presentAt.has(f))
        .map(([f, t]) => presentAt.get(f) - t);
      p.submitToPresentReturnMs = dist(lat);
      p.framesNeverPresented = [...submitAt.keys()].filter((f) => !presentAt.has(f)).length;
      p.presentUnsuccessful = ring.recs.filter(
        (r) => r.kind === KIND.unsuccessful && r.t >= from && r.t <= to,
      ).length;
    }
    out.phases[ph] = p;
  }
  // Touch chains (touch phase), only for touches a step used; absolute native→JS only within the bound.
  if (d.touches?.length) {
    const used = d.touches.filter((t) => !t.superseded && t.usedAtTick !== null);
    const t = {
      note: 'JS-visible touch events only: events React Native coalesced before JS are invisible here',
      events: d.touches.length,
      superseded: d.touches.filter((x) => x.superseded).length,
      used: used.length,
      carriedByFrame: used.filter((x) => x.frame !== null).length,
      handlerToStepMs: dist(used.map((x) => x.usedAtJs - x.jsNow)),
    };
    if (cal && ring) {
      const submitAt = new Map(
        ring.recs.filter((r) => r.kind === KIND.submit).map((r) => [r.frame, r.t]),
      );
      const presentAt = new Map();
      for (const r of ring.recs)
        if (r.kind === KIND.present && !presentAt.has(r.frame)) presentAt.set(r.frame, r.t);
      const nativeToHandler = d.touches.map((x) => cal.toMono(x.jsNow) - x.nativeTs);
      t.nativeTimestampClock = {
        note: 'nativeEvent.timestamp compared with the handler time mapped to CLOCK_MONOTONIC (ms); negative beyond the bound would refute the uptime/monotonic assumption',
        nativeToHandlerMs: dist(nativeToHandler),
        boundMs: round(cal.boundMs),
        consistent: nativeToHandler.every((v) => v >= -cal.boundMs && v < 5000),
      };
      if (t.nativeTimestampClock.consistent)
        t.nativeToHandlerMs = {
          ...dist(used.map((x) => cal.toMono(x.jsNow) - x.nativeTs)),
          note: 'touch clock not calibrated (consistent only, 1 ms resolution); spans input dispatch, RN coalescing and dispatch, JS scheduling; not a queueing delay',
        };
      t.stepToSubmitMs = dist(
        used
          .filter((x) => submitAt.has(x.frame))
          .map((x) => submitAt.get(x.frame) - cal.toMono(x.usedAtJs)),
      );
      t.submitToPresentReturnMs = dist(
        used
          .filter((x) => submitAt.has(x.frame) && presentAt.has(x.frame))
          .map((x) => presentAt.get(x.frame) - submitAt.get(x.frame)),
      );
      t.framesCarryingTouchNeverPresented = used.filter(
        (x) => x.frame !== null && !presentAt.has(x.frame),
      ).length;
    }
    out.touch = t;
  }
  if (run.data.hermesSamples) out.hermesSamples = sampleIntervals(run.data.hermesSamples);
  // Boundary allocation rate (all arms, sampled or not): js_totalAllocatedBytes at the
  // throughput start and at "done", over that wall time. A total measured value.
  const hb = (ph) => run.data.hermes?.find((h) => h.phase === ph);
  const h0 = hb('throughput'),
    h1 = hb('done');
  if (h0 && h1 && typeof h0.stats === 'object' && typeof h1.stats === 'object') {
    out.boundaryAllocation = {
      bytes: h1.stats.js_totalAllocatedBytes - h0.stats.js_totalAllocatedBytes,
      numGCs: h1.stats.js_numGCs - h0.stats.js_numGCs,
      wallMs: round(h1.perf - h0.perf),
      bytesPerS: round(
        (h1.stats.js_totalAllocatedBytes - h0.stats.js_totalAllocatedBytes) /
          ((h1.perf - h0.perf) / 1000),
      ),
    };
  }
  if (run.data.churn) {
    const c = run.data.churn,
      wall = h0 && h1 ? (h1.perf - h0.perf) / 1000 : null;
    out.churn = {
      ...c,
      achievedNominalBytesPerS: wall ? round((c.ticks * c.nominalBytesPerTick) / wall) : null,
      roundedPayloadBytesPerS: wall ? round((c.arrays * c.nominalArrayBytes) / wall) : null,
      achievedTicksPerS: wall ? round(c.ticks / wall) : null,
      note: 'achievedNominal = configured setting (bytes per tick) x churned ticks; roundedPayload = whole arrays x nominal array bytes; actual heap allocation only from Hermes counters',
    };
  }
  if (run.data.runtime) out.hermesRuntimeProperties = run.data.runtime.hermesRuntimeProperties;
  out.hermes = run.data.hermes
    ? {
        note: 'HermesInternal.getInstrumentedStats at phase boundaries; js_heapSize is likely heap capacity, not live bytes; js_gcTime in Hermes-reported units (not verified)',
        samples: run.data.hermes.map((h) => ({ phase: h.phase, stats: h.stats })),
      }
    : 'unavailable';
  out.captures = run.captures
    ? {
        thermalBefore: parseThermal(run.captures.thermalBefore ?? ''),
        thermalAfter: parseThermal(run.captures.thermalAfter ?? ''),
        meminfoBefore: run.captures.meminfoBefore
          ? parseMeminfo(run.captures.meminfoBefore)
          : 'unavailable',
        meminfoAfter: run.captures.meminfoAfter
          ? parseMeminfo(run.captures.meminfoAfter)
          : 'unavailable',
        gfxinfo: run.captures.gfxinfo ? parseGfxinfo(run.captures.gfxinfo) : 'unavailable',
        surfaceFlinger: (run.captures.surfaceFlinger ?? []).map((c) => {
          const sf = parseSfLatency(c.text);
          const phStartMono =
            cal && phaseStart[c.phase] !== undefined ? cal.toMono(phaseStart[c.phase]) : null;
          const inPhase = (x) =>
            phStartMono === null ? 'no calibration (uninstrumented)' : round(x - phStartMono);
          return {
            phase: c.phase,
            layer: c.layer,
            atPhaseMs: c.atPhaseMs,
            available: sf.available,
            refreshPeriodMs: sf.refreshPeriodMs,
            valid: sf.valid,
            segmentBreaks: sf.segmentBreaks,
            windowInPhaseMs: sf.windowMs ? sf.windowMs.map(inPhase) : null,
            actualPresentIntervalMs: sf.actualPresentIntervalMs,
            // Durations need no calibration; only their start within the phase does.
            longestActualPresentGaps: (sf.intervals ?? [])
              .slice()
              .sort((x, y) => y.ms - x.ms)
              .slice(0, 3)
              .map((i) => ({ ms: round(i.ms), startInPhaseMs: inPhase(i.from) })),
          };
        }),
      }
    : 'unavailable';
  return out;
}

const round = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);

/** The pilot table: per run and phase, the headline distributions side by side. */
export function table(summaries) {
  const rows = [];
  for (const s of summaries) {
    for (const [ph, p] of Object.entries(s.phases ?? {})) {
      rows.push({
        run: s.id,
        profile: s.config.profile,
        instrumented: s.config.instrumented,
        phase: ph,
        valid: s.valid,
        rafP50: p.rafIntervalMs.p50,
        rafP99: p.rafIntervalMs.p99,
        rafMax: p.rafIntervalMs.max,
        simOverWall: p.simulatedOverWall,
        droppedMs: p.droppedMs,
        stallsRanSkipped: `${p.stalls.ran}/${p.stalls.skipped}`,
        presentedPerS: p.presentedPerS ?? 'unavailable',
        presentGapP99: p.presentReturnGapMs?.p99 ?? 'unavailable',
        presentGapMax: p.presentReturnGapMs?.max ?? 'unavailable',
        submitToPresentP50: p.submitToPresentReturnMs?.p50 ?? 'unavailable',
      });
    }
  }
  return rows;
}

const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length
    ? v.length % 2
      ? v[(v.length - 1) / 2]
      : (v[v.length / 2 - 1] + v[v.length / 2]) / 2
    : null;
};
const span = (xs) => (xs.length ? round(Math.max(...xs) - Math.min(...xs)) : null);
const thermalFlag = (s) =>
  s.captures && typeof s.captures === 'object'
    ? {
        before: s.captures.thermalBefore,
        after: s.captures.thermalAfter,
        rose:
          s.captures.thermalAfter !== 'unavailable' &&
          s.captures.thermalAfter > (s.captures.thermalBefore || 0),
      }
    : 'unavailable';
const captured = (r) =>
  r && r.errors?.length === 0 && r.data && r.incomplete?.length === 0 && !r.crashed;
/** The Hermes artifact the plan identified; feasibility checks the build resolves the same. */
export const EXPECTED_HERMES = {
  version: '0.14.0',
  aarSha256: '2f991a74fa9e2827e037fb51d605293e1ccf9380a2711d8ab9d93b410f07bd78',
  libhermesvmSha256: '904a21ebd278d67ac8203cdb075828261e868fd190b18256fdb65a01dc3f2df7',
};

/** Trial-level evaluation, exactly as written in docs/research/js-contention-trial2-plan.md. */
export function evaluateTrial(trial, runs, summaries, identity) {
  const byId = new Map(summaries.map((s) => [s.id, s]));
  const arm = (a) =>
    runs.filter((r) => r.config.arm === a).map((r) => ({ run: r, s: byId.get(r.id) }));
  if (trial === 'feasibility') {
    const all = runs.map((r) => ({
      id: r.id,
      arm: r.config.arm,
      captured: captured(r),
      frameCorrelation: byId.get(r.id)?.frameCorrelation?.ok ?? false,
    }));
    const c1 = all.every((x) => x.captured && x.frameCorrelation);
    const props = runs.map((r) => byId.get(r.id)?.hermesRuntimeProperties);
    const c2 =
      props.every((p) => p && p !== 'unavailable') &&
      identity?.selectedVersion === EXPECTED_HERMES.version &&
      identity?.aarSha256 === EXPECTED_HERMES.aarSha256 &&
      identity?.apkLibhermesvmSha256 === EXPECTED_HERMES.libhermesvmSha256;
    const sampled = [...arm('S'), ...arm('H')].map((x) => x.s?.hermesSamples);
    const c3 =
      sampled.length === 2 &&
      sampled.every(
        (h) => h && h.allMonotonic && h.overflow === 0 && h.missing === 0 && h.nanRows === 0,
      );
    const u = arm('U')[0]?.s?.phases?.throughput,
      sS = arm('S')[0]?.s;
    const observer = {
      U: u ? { rafP50: u.rafIntervalMs.p50, rafP99: u.rafIntervalMs.p99 } : null,
      S: sS?.phases?.throughput
        ? {
            rafP50: sS.phases.throughput.rafIntervalMs.p50,
            rafP99: sS.phases.throughput.rafIntervalMs.p99,
          }
        : null,
      sampleCallMs: sS?.hermesSamples?.callMs ?? null,
      note: 'reported, no threshold',
    };
    const t = arm('T')[0]?.s?.phases?.throughput;
    const tStalls = arm('T')[0]?.run.data?.stalls ?? [];
    const c5 =
      !!t &&
      t.stalls.ran > 0 &&
      t.stalls.skipped === 0 &&
      tStalls.every((x) => x.placement === 'task') &&
      t.stalls.actualMs.min >= 99 &&
      t.stalls.actualMs.max <= 101;
    const h = arm('H')[0]?.s;
    return {
      conditions: {
        1: { met: c1, what: 'all runs captured, frame correlation holds, no ring gaps', runs: all },
        2: {
          met: c2,
          what: 'runtime properties logged; Hermes resolution and hashes equal the plan',
          identity,
          runtimeProperties: props,
        },
        3: {
          met: c3,
          what: 'S and H: cumulative counters monotonic; no overflow, missing or NaN samples',
          sampled,
        },
        4: { met: null, what: 'observer cost reported (no threshold)', observer },
        5: {
          met: c5,
          what: 'T: task-placement stalls ran at ~100 ms, none skipped',
          stalls: t?.stalls ?? null,
        },
        6: {
          met: null,
          what: 'H achieved churn reported',
          churn: h?.churn ?? null,
          boundaryAllocation: h?.boundaryAllocation ?? null,
        },
      },
      proceed: c1 && c2 && c3 && c5,
    };
  }
  if (trial === 'A') {
    const row = ({ run, s }) => {
      const p = s?.phases?.throughput;
      return {
        id: run.id,
        block: run.config.block,
        arm: run.config.arm,
        attempt: run.attempt ?? 1,
        perStallGapMedian: p?.longestPresentGapPerStallMs?.p50 ?? null,
        perStallGapMax: p?.longestPresentGapPerStallMs?.max ?? null,
        stallStartLateP50: p?.stalls?.startLateMs?.p50 ?? null,
        simOverWall: p?.simulatedOverWall,
        droppedMs: p?.droppedMs,
        rafP50: p?.rafIntervalMs?.p50,
        rafP99: p?.rafIntervalMs?.p99,
        ringGapP99: p?.presentReturnGapMs?.p99 ?? null,
        sfMaxGap:
          s?.captures?.surfaceFlinger?.find((c) => c.available)?.longestActualPresentGaps?.[0]
            ?.ms ?? null,
        frameCorrelation: s?.frameCorrelation?.ok ?? null,
        thermal: s ? thermalFlag(s) : null,
      };
    };
    const rows = runs.map((r) => row({ run: r, s: byId.get(r.id) }));
    const of = (a) => rows.filter((r) => r.arm === a);
    const crit = (a) => {
      const m = of(a)
        .map((r) => r.perStallGapMedian)
        .filter(Number.isFinite);
      return { medians: m, span: span(m), target: 10, met: m.length === 3 && span(m) <= 10 };
    };
    const c = of('C')
      .map((r) => r.ringGapP99)
      .filter(Number.isFinite);
    const R = of('R')
        .map((r) => r.perStallGapMedian)
        .filter(Number.isFinite),
      T = of('T')
        .map((r) => r.perStallGapMedian)
        .filter(Number.isFinite);
    const separated =
      R.length && T.length && (Math.min(...R) > Math.max(...T) || Math.min(...T) > Math.max(...R));
    return {
      rows,
      repeatability: {
        note: 'engineering targets set in advance; not statistics',
        R: crit('R'),
        T: crit('T'),
        C: { ringGapP99: c, span: span(c), target: 5, met: c.length === 3 && span(c) <= 5 },
      },
      placement: {
        RminusT: R.length && T.length ? round(median(R) - median(T)) : null,
        R: { median: median(R), range: R.length ? [Math.min(...R), Math.max(...R)] : null },
        T: { median: median(T), range: T.length ? [Math.min(...T), Math.max(...T)] : null },
        observedSeparation: !!separated,
        note: 'non-overlapping 3-run ranges are an observed descriptive separation in these runs, not an inferred placement difference',
      },
    };
  }
  if (trial === 'B') {
    const rows = runs.map((r) => {
      const s = byId.get(r.id),
        p = s?.phases?.throughput,
        h = s?.hermesSamples;
      return {
        id: r.id,
        block: r.config.block,
        arm: r.config.arm,
        attempt: r.attempt ?? 1,
        rafP50: p?.rafIntervalMs?.p50,
        rafP99: p?.rafIntervalMs?.p99,
        boundaryAllocBytesPerS: s?.boundaryAllocation?.bytesPerS ?? null,
        boundaryNumGCs: s?.boundaryAllocation?.numGCs ?? null,
        achievedChurnNominalBytesPerS: s?.churn?.achievedNominalBytesPerS ?? null,
        sampleCallMsP50: h?.callMs?.p50 ?? null,
        sampleCallMsMax: h?.callMs?.max ?? null,
        classes: h
          ? {
              ...Object.fromEntries(Object.entries(h.classes).map(([k, v]) => [k, v.n])),
              unclassified: h.unclassified,
            }
          : 'unsampled',
        monotonic: h ? h.allMonotonic : null,
        thermal: s ? thermalFlag(s) : null,
      };
    });
    // Total measured difference against the sampled control of the same block (not pure churn bytes).
    for (const r of rows) {
      const S = rows.find((x) => x.block === r.block && x.arm === 'S');
      r.totalMeasuredDifferenceVsS =
        S &&
        r.arm !== 'S' &&
        Number.isFinite(r.boundaryAllocBytesPerS) &&
        Number.isFinite(S.boundaryAllocBytesPerS)
          ? round(r.boundaryAllocBytesPerS - S.boundaryAllocBytesPerS)
          : null;
    }
    return {
      rows,
      note: 'reversed-order paired pilot (not a full counterbalance); n = 2 per arm; exploratory and descriptive; no GC-visibility verdict; differences vs S include observer, game and GC behaviour, not only churn bytes',
    };
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir || !existsSync(dir)) throw new Error('usage: contention-summarize.mjs <run-dir>');
  const runs = readdirSync(dir)
    .filter((f) => /^run-\d+\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
  const summaries = runs.map(summarizeRun);
  // A regenerated, derived summary: the raw run-*.json and the run-time summary.json are not
  // touched, and nothing was re-run on a device.
  const self = fileURLToPath(import.meta.url);
  const git = (...a) =>
    execFileSync('git', ['-C', path.dirname(self), ...a], { encoding: 'utf8' }).trim();
  const provenance = {
    derivedFrom: 'raw run-*.json in this directory (unchanged)',
    deviceRerun: false,
    runTimeSummary: 'summary.json (written by the driver at run time; kept)',
    summarizer: path.relative(path.resolve(path.dirname(self), '..'), self),
    summarizerSha256: createHash('sha256').update(readFileSync(self)).digest('hex'),
    head: git('rev-parse', 'HEAD'),
    statusPorcelain: git('status', '--porcelain=v1').split('\n').filter(Boolean),
  };
  const manifest = existsSync(path.join(dir, 'manifest.json'))
    ? JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    : {};
  const evaluation = manifest.trial
    ? evaluateTrial(manifest.trial, runs, summaries, manifest.hermesIdentity)
    : null;
  writeFileSync(
    path.join(dir, 'summary-regenerated.json'),
    JSON.stringify({ provenance, summaries, table: table(summaries), evaluation }, null, 2) + '\n',
  );
  console.table(table(summaries));
}
