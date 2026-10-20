// JS-thread contention pilot (docs/research/js-contention-plan.md). Active only when the app is
// started with a data URI rnrgame://contention?profile=…&placement=…&instrumented=0|1&touch=0|1&run=…
// (read with Linking.getInitialURL; no native code). Without it the game is unchanged.
//
// Only the stall *schedule* is deterministic; actual stall timing depends on the device. Stalls
// use absolute deadlines from the phase start; a deadline already overtaken by the next one is
// logged as skipped, never run late (no backlog).

/** performance.now() (monotonic ms; present in React Native, not declared by its types). */
export const perfNow = (): number => (globalThis as unknown as {performance: {now(): number}}).performance.now();

export type Profile = 'control' | 'periodic-100' | 'burst-500';
export type Placement = 'raf' | 'task';

export interface Config {
  run: string;
  profile: Profile;
  placement: Placement;
  instrumented: boolean;
  touch: boolean;
  /** Nominal extra bytes allocated (short-lived) per measured tick; 0 = none. */
  churn: number;
  /** Hermes counters at phase boundaries only, or also at the top of every measured tick. */
  hermes: 'phase' | 'tick';
}

export function parseConfig(url: string | null): Config | null {
  if (!url || !url.startsWith('rnrgame://contention')) return null;
  const q = new Map<string, string>();
  const i = url.indexOf('?');
  if (i >= 0) {
    for (const part of url.slice(i + 1).split('&')) {
      const [k, v = ''] = part.split('=');
      q.set(decodeURIComponent(k), decodeURIComponent(v));
    }
  }
  const profile = q.get('profile') as Profile;
  const placement = (q.get('placement') ?? 'raf') as Placement;
  if (!['control', 'periodic-100', 'burst-500'].includes(profile)) throw new Error(`unknown profile ${profile}`);
  if (!['raf', 'task'].includes(placement)) throw new Error(`unknown placement ${placement}`);
  const churnText = q.get('churn') ?? '0';
  const churn = churnText.trim() === '' ? NaN : Number(churnText);
  if (!Number.isInteger(churn) || churn < 0 || churn > 4_000_000) throw new Error(`churn must be an integer from 0 to 4000000 bytes per tick, got ${q.get('churn')}`);
  const hermes = (q.get('hermes') ?? 'phase') as Config['hermes'];
  if (!['phase', 'tick'].includes(hermes)) throw new Error(`unknown hermes sampling ${hermes}`);
  return {run: q.get('run') ?? 'run', profile, placement, instrumented: q.get('instrumented') !== '0', touch: q.get('touch') === '1', churn, hermes};
}

export interface PlannedStall {
  /** Deadline relative to the phase start (ms). */
  at: number;
  durationMs: number;
}

/** The planned stalls of one phase. */
export function schedule(profile: Profile, phaseMs: number): PlannedStall[] {
  switch (profile) {
    case 'control':
      return [];
    case 'periodic-100':
      return Array.from({length: Math.floor((phaseMs - 1) / 1000)}, (_, k) => ({at: 1000 * (k + 1), durationMs: 100}));
    case 'burst-500':
      return phaseMs > 8000 ? [{at: 8000, durationMs: 500}] : [];
  }
}

export interface StallRecord {
  index: number;
  phase: string;
  placement: Placement;
  plannedStart: number;
  durationMs: number;
  actualStart: number | null;
  actualEnd: number | null;
  skipped: boolean;
}

/** Busy-waits `ms` on the JS thread (no allocation inside the loop). */
export function busyWait(ms: number, now: () => number): number {
  const end = now() + ms;
  let t = now();
  while (t < end) t = now();
  return t;
}

/** Runs one phase's stalls at absolute deadlines. `poll` runs a due stall (the rAF placement
 *  calls it at the top of each tick; the task placement arms one timer for the next deadline). */
export class StallRunner {
  records: StallRecord[] = [];
  private next = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private plan: PlannedStall[];
  private phase: string;
  private start: number;
  private placement: Placement;
  private now: () => number;

  constructor(plan: PlannedStall[], phase: string, startMs: number, placement: Placement, now: () => number) {
    this.plan = plan;
    this.phase = phase;
    this.start = startMs;
    this.placement = placement;
    this.now = now;
    if (placement === 'task') this.arm();
  }

  poll(): void {
    const t = this.now() - this.start;
    while (this.next < this.plan.length && this.plan[this.next].at <= t) {
      const i = this.next++;
      const p = this.plan[i];
      const overtaken = this.next < this.plan.length && this.plan[this.next].at <= t;
      const rec: StallRecord = {index: i, phase: this.phase, placement: this.placement, plannedStart: p.at, durationMs: p.durationMs, actualStart: null, actualEnd: null, skipped: overtaken};
      if (!overtaken) {
        rec.actualStart = this.now() - this.start;
        rec.actualEnd = busyWait(p.durationMs, this.now) - this.start;
      }
      this.records.push(rec);
    }
  }

  private arm(): void {
    if (this.next >= this.plan.length) return;
    const delay = Math.max(0, this.start + this.plan[this.next].at - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.poll();
      this.arm();
    }, delay);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Deadlines never reached before the phase ended.
    for (; this.next < this.plan.length; this.next++) {
      const p = this.plan[this.next];
      this.records.push({index: this.next, phase: this.phase, placement: this.placement, plannedStart: p.at, durationMs: p.durationMs, actualStart: null, actualEnd: null, skipped: true});
    }
  }
}

export interface TouchRecord {
  seq: number;
  phase: string;
  /** React Native's nativeEvent.timestamp (expected: Android event time, uptime ms). */
  nativeTs: number;
  jsNow: number;
  x: number;
  /** The game tick of the first step that used this touch, or null if superseded. */
  usedAtTick: number | null;
  usedAtJs: number | null;
  /** The renderer frame ID of the first submitted frame drawn after that step. */
  frame: number | null;
  superseded: boolean;
}

/** Touch sequence numbers, the step that first used each, and the frame that carried it. */
export class TouchLog {
  records: TouchRecord[] = [];
  latest: TouchRecord | null = null;
  private awaitingFrame: TouchRecord[] = [];

  add(phase: string, nativeTs: number, jsNow: number, x: number): void {
    // A touch not yet used by any step is superseded by this one (latest wins).
    if (this.latest && this.latest.usedAtTick === null) this.latest.superseded = true;
    const rec: TouchRecord = {seq: this.records.length + 1, phase, nativeTs, jsNow, x, usedAtTick: null, usedAtJs: null, frame: null, superseded: false};
    this.records.push(rec);
    this.latest = rec;
  }

  /** Called before a step that reads the latest touch. */
  use(tick: number, jsNow: number): void {
    const t = this.latest;
    if (t && t.usedAtTick === null) {
      t.usedAtTick = tick;
      t.usedAtJs = jsNow;
      this.awaitingFrame.push(t);
    }
  }

  /** Called after an accepted submit with the renderer's frame ID. */
  submitted(frame: number): void {
    for (const t of this.awaitingFrame) t.frame = frame;
    this.awaitingFrame = [];
  }
}

/** One drain of the renderer's event ring, decoded, with the JS clock bracketing the call. */
export interface Drain {
  jsBefore: number;
  jsAfter: number;
  nowNs: number;
  count: number;
  dropped: number;
  highWater: number;
  capacity: number;
  /** [tNs, seq, frame, attachment, kind] per record; tNs as a JS number (ns, < 2^53 for ~104 days of uptime). */
  records: number[][];
}

export function decodeDrain(buf: ArrayBuffer, jsBefore: number, jsAfter: number): Drain | null {
  if (buf.byteLength === 0) return null;
  const v = new DataView(buf);
  const u64 = (o: number) => v.getUint32(o, true) + v.getUint32(o + 4, true) * 4294967296;
  const count = v.getUint32(8, true);
  const records: number[][] = [];
  for (let i = 0; i < count; i++) {
    const o = 40 + i * 24;
    records.push([u64(o), v.getUint32(o + 8, true), v.getUint32(o + 12, true), v.getUint32(o + 16, true), v.getUint16(o + 20, true)]);
  }
  return {jsBefore, jsAfter, nowNs: u64(24), count, dropped: u64(16), highWater: v.getUint32(12, true), capacity: v.getUint32(32, true), records};
}

/** Hermes heap/GC counters if this build exposes them; otherwise an explicit "unavailable". */
export function hermesStats(): unknown {
  const h = (globalThis as {HermesInternal?: {getInstrumentedStats?: () => unknown}}).HermesInternal;
  return h?.getInstrumentedStats ? h.getInstrumentedStats() : 'unavailable';
}

/** A large value as numbered log lines (logcat truncates lines near 4 KB). */
export function chunkLines(tag: string, run: string, key: string, value: unknown): string[] {
  const text = JSON.stringify(value);
  const size = 1800; // a logcat line holds ~4 KB; escaping at most doubles a chunk
  const parts = Math.max(1, Math.ceil(text.length / size));
  const lines: string[] = [];
  for (let p = 0; p < parts; p++) lines.push(`${tag} ` + JSON.stringify({run, key, part: p, parts, data: text.slice(p * size, (p + 1) * size)}));
  return lines;
}

/** Emits lines a few at a time: logd drops lines from a burst of hundreds (pilot
 *  20261020T045331Z lost 6 of 81 chunks), so the dump is spread over time. */
export function pacedLog(lines: string[], log: (line: string) => void, perBatch = 8, intervalMs = 50): void {
  let i = 0;
  const timer = setInterval(() => {
    for (const end = Math.min(lines.length, i + perBatch); i < end; i++) log(lines[i]);
    if (i >= lines.length) clearInterval(timer);
  }, intervalMs);
}

/** The Hermes counters sampled per tick, in this order after [tBefore, tAfter]. */
export const SAMPLED_COUNTERS = ['js_numGCs', 'js_gcTime', 'js_gcCPUTime', 'js_allocatedBytes', 'js_totalAllocatedBytes'] as const;
const SAMPLE_WIDTH = 2 + SAMPLED_COUNTERS.length;

/** Per-tick Hermes counter samples in a preallocated Float64Array: [tBefore, tAfter, ...counters]
 *  per sample, timestamps bracketing the getInstrumentedStats call (whose result object is the
 *  only allocation per sample). Bounded: samples beyond capacity are counted, not stored. */
export class HermesSampler {
  readonly capacity: number;
  count = 0;
  overflow = 0;
  /** Samples whose call returned no stats object (all counters NaN). */
  missing = 0;
  /** Samples with a stats object lacking one or more counters (those are NaN). */
  missingCounters = 0;
  private data: Float64Array;
  private read: () => Record<string, unknown> | null;
  private now: () => number;

  constructor(capacity: number, now: () => number, read: () => Record<string, unknown> | null = readHermesStats) {
    this.capacity = capacity;
    this.data = new Float64Array(capacity * SAMPLE_WIDTH);
    this.now = now;
    this.read = read;
  }

  sample(): void {
    if (this.count >= this.capacity) {
      this.overflow++;
      return;
    }
    const o = this.count * SAMPLE_WIDTH;
    this.data[o] = this.now();
    const stats = this.read();
    this.data[o + 1] = this.now();
    if (!stats) this.missing++;
    let lacking = false;
    for (let k = 0; k < SAMPLED_COUNTERS.length; k++) {
      const v = stats?.[SAMPLED_COUNTERS[k]];
      if (typeof v !== 'number') lacking = true;
      this.data[o + 2 + k] = typeof v === 'number' ? v : NaN;
    }
    if (stats && lacking) this.missingCounters++;
    this.count++;
  }

  /** Plain arrays for logging (at the phase end only). */
  rows(): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < this.count; i++) out.push(Array.from(this.data.subarray(i * SAMPLE_WIDTH, (i + 1) * SAMPLE_WIDTH)));
    return out;
  }
}

function readHermesStats(): Record<string, unknown> | null {
  const h = (globalThis as {HermesInternal?: {getInstrumentedStats?: () => Record<string, unknown>}}).HermesInternal;
  return h?.getInstrumentedStats ? h.getInstrumentedStats() : null;
}

/** Hermes runtime properties (release version, GC kind, ...) if exposed; otherwise "unavailable". */
export function hermesRuntimeProperties(): unknown {
  const h = (globalThis as {HermesInternal?: {getRuntimeProperties?: () => unknown}}).HermesInternal;
  return h?.getRuntimeProperties ? h.getRuntimeProperties() : 'unavailable';
}

/** Elements per churn array: 128 non-integer numbers; nominal 1 KiB (128 × 8 bytes). The engine's
 *  representation decides the real cost: with 32-bit value slots (compressed pointers) each
 *  non-integer number is a separate boxed heap cell; actual bytes only from Hermes counters. */
export const CHURN_ARRAY_ELEMENTS = 128;
export const CHURN_ARRAY_NOMINAL_BYTES = CHURN_ARRAY_ELEMENTS * 8;
let churnSink: number[] | null = null;

/** Allocates short-lived arrays for about `bytes` nominal bytes, dropping each at once; returns the
 *  number of arrays. The actual allocated bytes are only known from Hermes counters. */
export function churn(bytes: number): number {
  const n = Math.ceil(bytes / CHURN_ARRAY_NOMINAL_BYTES);
  for (let i = 0; i < n; i++) {
    const a = new Array<number>(CHURN_ARRAY_ELEMENTS);
    for (let j = 0; j < CHURN_ARRAY_ELEMENTS; j++) a[j] = j + 0.5;
    churnSink = a;
  }
  churnSink = null;
  return n;
}

export const WARMUP_MS = 5000;
export const THROUGHPUT_MS = 20000;
export const TOUCH_MS = 15000;
export const TIMING_RECORDS = 8192;
/** Per-tick Hermes samples kept (about 68 s at 60 ticks/s; 7 doubles each). */
export const SAMPLE_CAPACITY = 4096;
export type Phase = 'pending' | 'warmup' | 'throughput' | 'touch' | 'done';

/** One contention run: phases by wall time (performance.now), stalls, per-tick, touch, ring and
 *  stats records. The app calls it from its rAF tick, touch handler and a 1 s timer; it logs
 *  RNR_CONTENTION lines (phase events, then chunked data, then "done" last). */
export class Session {
  cfg: Config;
  phase: Phase = 'pending';
  phaseStart = 0;
  /** Accepted submits since the renderer was created: equals the renderer's frame ID. */
  frame = 0;
  stalls: StallRecord[] = [];
  /** Per measured tick: [perfAtTop, rafNow, steps, frameId (0 = no submit), droppedMsTotal, phase (1 throughput, 2 touch)]. */
  ticks: number[][] = [];
  touches = new TouchLog();
  drains: Drain[] = [];
  snapshots: unknown[] = [];
  hermes: {phase: Phase; perf: number; stats: unknown}[] = [];
  phases: {phase: Phase; perf: number; date: number}[] = [];
  /** Lifecycle pauses during measured phases (the run is then invalid, not repaired). */
  pausedDuring: {phase: Phase; perf: number}[] = [];
  /** Per-tick Hermes samples (`hermes=tick` only). */
  sampler: HermesSampler | null;
  churnTicks = 0;
  churnArrays = 0;
  runtimeProperties: unknown;
  private runner: StallRunner | null = null;
  private finished = false;
  private now: () => number;
  private log: (line: string) => void;
  private emit: (lines: string[]) => void;

  constructor(cfg: Config, now: () => number = perfNow, log: (line: string) => void = l => console.log(l), emit?: (lines: string[]) => void) {
    this.cfg = cfg;
    this.now = now;
    this.log = log;
    this.emit = emit ?? (lines => pacedLog(lines, log));
    this.sampler = cfg.hermes === 'tick' ? new HermesSampler(SAMPLE_CAPACITY, now) : null;
    this.runtimeProperties = hermesRuntimeProperties();
  }

  get measuring(): boolean {
    return this.phase === 'throughput' || this.phase === 'touch';
  }
  /** The autopilot drives the paddle except in the touch phase. */
  get autopilot(): boolean {
    return this.phase !== 'touch';
  }

  /** Top of every rAF tick, before the lifecycle check and steps. `drain` is the final ring
   *  drain at the end of the run. */
  beginTick(running: boolean, drain: () => void): void {
    const t = this.now();
    if (!running) {
      if (this.measuring && (this.pausedDuring.length === 0 || this.pausedDuring[this.pausedDuring.length - 1].phase !== this.phase)) this.pausedDuring.push({phase: this.phase, perf: t});
      return;
    }
    const elapsed = t - this.phaseStart;
    if (this.phase === 'pending') this.enter('warmup', t);
    else if (this.phase === 'warmup' && elapsed >= WARMUP_MS) this.enter('throughput', t);
    else if (this.phase === 'throughput' && elapsed >= THROUGHPUT_MS) this.enter(this.cfg.touch ? 'touch' : 'done', t);
    else if (this.phase === 'touch' && elapsed >= TOUCH_MS) this.enter('done', t);
    if (this.phase === 'done' && !this.finished) {
      this.finished = true;
      drain();
      this.dump();
    }
    // Hermes counters before any stall or step of this tick: a change belongs to the interval
    // since the previous sample.
    if (this.measuring) this.sampler?.sample();
    if (this.cfg.placement === 'raf') this.runner?.poll();
  }

  /** After the tick's submit: the churn allocation (measured phases only). */
  afterSubmit(): void {
    if (this.measuring && this.cfg.churn > 0) {
      this.churnArrays += churn(this.cfg.churn);
      this.churnTicks++;
    }
  }

  private enter(phase: Phase, t: number): void {
    if (this.runner) {
      this.runner.stop();
      this.stalls.push(...this.runner.records);
      this.runner = null;
    }
    this.phase = phase;
    this.phaseStart = t;
    this.phases.push({phase, perf: t, date: Date.now()});
    this.hermes.push({phase, perf: t, stats: hermesStats()});
    this.log('RNR_CONTENTION ' + JSON.stringify({run: this.cfg.run, event: 'phase', phase, perf: t}));
    if (phase === 'throughput' || phase === 'touch') {
      const ms = phase === 'throughput' ? THROUGHPUT_MS : TOUCH_MS;
      this.runner = new StallRunner(schedule(this.cfg.profile, ms), phase, t, this.cfg.placement, this.now);
    }
  }

  /** A touch (only recorded in the touch phase). */
  touch(nativeTs: number, x: number): void {
    if (this.phase === 'touch') this.touches.add(this.phase, nativeTs, this.now(), x);
  }

  /** Before the tick's steps run (game tick before the first step). */
  beforeSteps(steps: number, gameTick: number): void {
    if (this.phase === 'touch' && steps > 0) this.touches.use(gameTick, this.now());
  }

  /** After the tick's (possible) submit. */
  endTick(tTop: number, rafNow: number, steps: number, submitted: boolean, droppedS: number): void {
    if (submitted) {
      this.frame++;
      if (this.phase === 'touch') this.touches.submitted(this.frame);
    }
    if (this.measuring) this.ticks.push([round3(tTop), round3(rafNow), steps, submitted ? this.frame : 0, round3(droppedS * 1000), this.phase === 'throughput' ? 1 : 2]);
  }

  /** The 1 s timer: a ring drain (instrumented runs) bracketed by performance.now. */
  drainFrom(read: () => ArrayBuffer): void {
    const before = this.now();
    const buf = read();
    const d = decodeDrain(buf, before, this.now());
    if (d) this.drains.push(d);
  }

  snapshot(stats: unknown): void {
    if (this.measuring) this.snapshots.push({perf: round3(this.now()), phase: this.phase, stats});
  }

  private dump(): void {
    const run = this.cfg.run;
    const tag = 'RNR_CONTENTION_DATA';
    const lines: string[] = [];
    lines.push(...chunkLines(tag, run, 'config', this.cfg));
    lines.push(...chunkLines(tag, run, 'phases', this.phases));
    lines.push(...chunkLines(tag, run, 'stalls', this.stalls));
    lines.push(...chunkLines(tag, run, 'ticks', this.ticks));
    lines.push(...chunkLines(tag, run, 'touches', this.touches.records));
    lines.push(...chunkLines(tag, run, 'drains', this.drains));
    lines.push(...chunkLines(tag, run, 'snapshots', this.snapshots));
    lines.push(...chunkLines(tag, run, 'hermes', this.hermes));
    lines.push(...chunkLines(tag, run, 'pausedDuring', this.pausedDuring));
    lines.push(...chunkLines(tag, run, 'runtime', {hermesRuntimeProperties: this.runtimeProperties}));
    lines.push(...chunkLines(tag, run, 'churn', {nominalBytesPerTick: this.cfg.churn, ticks: this.churnTicks, arrays: this.churnArrays, nominalArrayBytes: CHURN_ARRAY_NOMINAL_BYTES}));
    if (this.sampler) {
      lines.push(...chunkLines(tag, run, 'hermesSamples', {columns: ['tBefore', 'tAfter', ...SAMPLED_COUNTERS], capacity: this.sampler.capacity, count: this.sampler.count, overflow: this.sampler.overflow, missing: this.sampler.missing, missingCounters: this.sampler.missingCounters, rows: this.sampler.rows()}));
    }
    lines.push('RNR_CONTENTION ' + JSON.stringify({run, event: 'done', frames: this.frame, ticks: this.ticks.length, stalls: this.stalls.length, touches: this.touches.records.length, drains: this.drains.length, paused: this.pausedDuring.length}));
    this.emit(lines);
  }
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
