// The comparison harness (benchmarks/turbo-compare; protocol in the shared notes). One run per
// process: correctness checks, calibration, warmup rounds, then measured rounds. Each round
// shuffles the workload order and, per workload, the path order (seeded); a workload's paths run
// back to back, one paired sample each. No GC, idle or busy phase is forced before samples, and
// nothing is logged until the last sample: the whole report is emitted at the end.
import { Linking, Platform } from 'react-native';
import { runtimeBindings } from '@rnrs/runtime/testing';
import { turboCompareModule } from '@rnrs/labs-turbo-compare';
import RnrsCmpCxx from '@rnrs-bench/cmp-cxx';
import { makeCases } from './cases.generated';
import { makeFixtures, nested, point, utf8Length } from './fixtures';
import type { Case, CmpApi, JsiControl, Receivers } from './types';

export interface Config {
  runId: string;
  seed: number;
  mode: 'smoke' | 'timed';
  rounds: number;
  warmupRounds: number;
  targetMs: number;
  settleMs: number;
  /** Iterations per sample by workload, fixed for every path and process of a run set (from the
   *  pilot; see the notes). Absent: calibrate in-process (pilot only). */
  fixedN?: Record<string, number>;
}

const DEFAULTS: Omit<Config, 'runId' | 'seed'> = {
  mode: 'smoke',
  rounds: 2,
  warmupRounds: 1,
  targetMs: 10,
  settleMs: 1500,
};
const MAX_N = 1_000_000;
const global = globalThis as any;

const now: () => number =
  typeof global.performance?.now === 'function' ? () => global.performance.now() : Date.now;

function gcCount(): number | null {
  const stats = global.HermesInternal?.getInstrumentedStats?.();
  return typeof stats?.js_numGCs === 'number' ? stats.js_numGCs : null;
}

/** mulberry32 */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], random: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The run config: the iOS launch environment (RNRSCMP_CONFIG) or the Android launch URL
 *  (rnrscmp://run?config=<URI-encoded JSON>). */
async function readConfig(jsi: JsiControl): Promise<Config> {
  let text = Platform.OS === 'ios' ? jsi.env('RNRSCMP_CONFIG') : null;
  if (!text) {
    const url = await Linking.getInitialURL();
    const m = url?.match(/[?&]config=([^&]+)/);
    if (m) text = decodeURIComponent(m[1]);
  }
  if (!text) throw new Error('no run config (RNRSCMP_CONFIG or rnrscmp://run?config=...)');
  const c = { ...DEFAULTS, ...JSON.parse(text) };
  if (typeof c.runId !== 'string' || !Number.isInteger(c.seed))
    throw new Error('config needs runId and an integer seed');
  return c;
}

/** FNV-1a (32-bit) over UTF-16 code units, hex; runner-lib.mjs checks it. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** One report as console.error lines of at most 700 report characters (os_log truncates long
 *  lines); release builds forward them to logcat (ReactNativeJS) and os_log. Each line ends with
 *  a '|' sentinel (the iOS console path trims trailing whitespace) and carries the whole report's
 *  length and hash, which the runner verifies. */
function emit(runId: string, report: object) {
  const text = JSON.stringify(report);
  const parts = Math.ceil(text.length / 700) || 1;
  const check = `${text.length}:${fnv1a(text)}`;
  for (let i = 0; i < parts; i++)
    console.error(
      `RNRSCMP2 ${runId} ${i + 1}/${parts} ${check} ${text.slice(i * 700, (i + 1) * 700)}|`,
    );
}

interface Check {
  path: string;
  name: string;
  ok: boolean;
  detail?: string;
}

// rnrs's calling shape around the guarded C++ leaves (measurement controls only): a
// generated-style prototype method reads this.host.callN, an own property of a host
// instance, and calls it with (index, undefined receiver, ...arguments).
type Entry = (...args: unknown[]) => unknown;
class ShapedHost {
  readonly call0: Entry;
  readonly call1: Entry;
  readonly call2: Entry;
  constructor(entry: Entry) {
    this.call0 = entry;
    this.call1 = entry;
    this.call2 = entry;
  }
}
class ShapedModule {
  constructor(readonly host: ShapedHost) {}
  nop(): void {
    this.host.call0(0, undefined);
  }
  add(a: number, b: number): number {
    return this.host.call2(1, undefined, a, b) as number;
  }
  flip(b: boolean): boolean {
    return this.host.call1(2, undefined, b) as boolean;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function correctness(r: Receivers): Check[] {
  const fx = makeFixtures();
  const checks: Check[] = [];
  const check = (path: string, name: string, body: () => boolean | string) => {
    try {
      const v = body();
      checks.push({ path, name, ok: v === true, detail: v === true ? undefined : String(v) });
    } catch (e) {
      checks.push({ path, name, ok: false, detail: `threw ${String((e as Error)?.message ?? e)}` });
    }
  };
  const throws = (f: () => unknown) => {
    try {
      f();
      return 'did not throw';
    } catch {
      return true;
    }
  };
  const scalar = (path: string, m: Pick<CmpApi, 'nop' | 'add' | 'flip'>) => {
    check(path, 'nop() is undefined', () => m.nop() === undefined);
    check(path, 'add(-1.25, 3.5) = 2.25', () => m.add(-1.25, 3.5) === 2.25);
    check(path, 'add(NaN, 1) is NaN', () => Number.isNaN(m.add(NaN, 1)));
    check(path, 'add(1e308, 1e308) = Infinity', () => m.add(1e308, 1e308) === Infinity);
    check(path, 'add(-0, -0) is -0', () => Object.is(m.add(-0, -0), -0));
    check(
      path,
      'flip(true) = false, flip(false) = true',
      () => m.flip(true) === false && m.flip(false) === true,
    );
    check(path, "add('1', 2) throws", () => throws(() => m.add('1' as any, 2)));
    check(path, 'flip(1) throws', () => throws(() => m.flip(1 as any)));
  };
  scalar('jsi', r.jsi);
  scalar('jsi-guarded', r.guarded);
  scalar('jsi-wrapped', r.wrapped);
  scalar('jsi-shaped', r.shaped);
  scalar('jsi-shaped-this', r.shapedThis);
  scalar('jsi-shaped-unbound', r.shapedUnbound);
  // rnrs and the handwritten control promise ordinary reads; codegen's indexed
  // reader has different proxy/length semantics and is intentionally excluded here.
  for (const path of ['rnrs', 'jsi'] as const) {
    const m = r[path];
    check(
      path,
      'array fixtures and growth',
      () =>
        [16, 256, 1024].every((n) => m.arrSum(fx.arrays[n]) === fx.arrayTotals[n]) &&
        m.arrSum(Array.from({ length: 8193 }, () => 1)) === 8193,
    );
    check(
      path,
      'array IEEE values',
      () =>
        Number.isNaN(m.arrSum([NaN])) &&
        m.arrSum([Infinity]) === Infinity &&
        m.arrSum([-Infinity]) === -Infinity &&
        Object.is(m.arrSum([-0]), 0),
    );
    check(path, 'array wrong type stops before next getter', () => {
      let next = false;
      const xs = [1, 'bad', 3] as any;
      Object.defineProperty(xs, 2, {
        get() {
          next = true;
          return 3;
        },
      });
      return throws(() => m.arrSum(xs)) === true && !next;
    });
    check(path, 'array exception identity', () => {
      const sentinel = {};
      const xs = [1, 2];
      Object.defineProperty(xs, 1, {
        get() {
          throw sentinel;
        },
      });
      try {
        m.arrSum(xs);
        return false;
      } catch (e) {
        return e === sentinel;
      }
    });
    check(path, 'array inherited hole', () => {
      const xs = [1, , 3];
      Object.setPrototypeOf(xs, Object.assign(Object.create(Array.prototype), { 1: 2 }));
      return m.arrSum(xs as number[]) === 6;
    });
    check(path, 'array uncovered hole throws', () => throws(() => m.arrSum([1, , 3] as number[])));
    check(path, 'array proxy reads one length in order', () => {
      const keys: string[] = [];
      const xs = new Proxy([1, 2, 3], {
        get(target, key, receiver) {
          keys.push(String(key));
          return Reflect.get(target, key, receiver);
        },
      });
      return m.arrSum(xs) === 6 && same(keys, ['length', '0', '1', '2']);
    });
    check(path, 'array length mutation reads original extent', () => {
      const xs = [1, 2, 3];
      Object.setPrototypeOf(xs, Object.assign(Object.create(Array.prototype), { 1: 2, 2: 3 }));
      Object.defineProperty(xs, 0, {
        get() {
          xs.length = 1;
          return 1;
        },
      });
      return m.arrSum(xs) === 6;
    });
    check(path, 'array reentrant getter', () => {
      const xs = [1, 2];
      Object.defineProperty(xs, 0, {
        get() {
          return m.arrSum([4, 5]);
        },
      });
      return m.arrSum(xs) === 11;
    });
    check(path, 'array huge declared length fails immediately', () => {
      let reads = 0;
      const xs = new Proxy([], {
        get(_target, key) {
          if (key === 'length') return 0xffffffff;
          reads++;
          return undefined;
        },
      });
      return throws(() => m.arrSum(xs)) === true && reads === 1;
    });
  }
  for (const path of ['rnrs', 'tm'] as const) {
    const m = r[path];
    scalar(path, m);
    fx.strings.forEach((s, id) => {
      check(
        path,
        `strLen(fixture ${id}) = ${fx.stringBytes[id]}`,
        () => m.strLen(s) === fx.stringBytes[id] || `${m.strLen(s)}`,
      );
      check(path, `strGet(${id}) equals fixture ${id}`, () => m.strGet(id) === s);
    });
    check(path, "strLen('') = 0", () => m.strLen('') === 0);
    check(
      path,
      "strLen('a\\ud800b') = 5 (lone surrogate -> U+FFFD)",
      () => m.strLen('a\ud800b') === 5 || `${m.strLen('a\ud800b')}`,
    );
    check(path, 'strLen(1) throws', () => throws(() => m.strLen(1 as any)));
    check(
      path,
      'strGet(6) and strGet(1.5) throw',
      () => throws(() => m.strGet(6)) === true && throws(() => m.strGet(1.5)),
    );
    check(path, `pointSum = ${fx.pointTotal}`, () => m.pointSum(fx.point) === fx.pointTotal);
    check(
      path,
      'pointMake(2) equals fixture',
      () => same(m.pointMake(2), point(2)) || JSON.stringify(m.pointMake(2)),
    );
    check(path, 'pointSum with a string field throws', () =>
      throws(() => m.pointSum({ ...fx.point, c: 'x' as any })),
    );
    check(path, `nestedSum = ${fx.nestedTotal}`, () => m.nestedSum(fx.nested) === fx.nestedTotal);
    check(
      path,
      'nestedMake(3) equals fixture',
      () => same(m.nestedMake(3), nested(3)) || JSON.stringify(m.nestedMake(3)),
    );
    for (const len of [16, 256, 1024])
      check(
        path,
        `arrSum(${len}) = ${fx.arrayTotals[len]}`,
        () => m.arrSum(fx.arrays[len]) === fx.arrayTotals[len],
      );
    check(path, 'arrSum([1, "2"]) throws', () => throws(() => m.arrSum([1, '2' as any])));
    check(path, 'arrMake(3, 5) = [5, 6, 7]', () => same(m.arrMake(3, 5), [5, 6, 7]));
    check(path, 'arrMake(1024, 2) is 2..1025', () =>
      same(
        m.arrMake(1024, 2),
        Array.from({ length: 1024 }, (_, i) => i + 2),
      ),
    );
    check(path, 'arrMake(-1, 0) throws', () => throws(() => m.arrMake(-1, 0)));
    check(
      path,
      `pointSumBatch(64) = ${fx.points64Total}`,
      () => m.pointSumBatch(fx.points64) === fx.points64Total,
    );
  }
  check(
    'js',
    'fixture UTF-8 sizes',
    () => same(fx.stringBytes, [16, 1024, 65536, 16, 1024, 65536]) || `${fx.stringBytes}`,
  );
  check('js', 'utf8Length of the lone surrogate fixture', () => utf8Length('a\ud800b') === 5);
  return checks;
}

function runChecked(c: Case, n: number): number {
  const t0 = now();
  const result = c.run(n);
  const ms = now() - t0;
  const expected = c.expect(n);
  if (result !== expected)
    throw new Error(`${c.workload}/${c.path}: checksum ${result}, expected ${expected} (n=${n})`);
  return ms;
}

/** One n per workload (the same for its paths): the slowest path takes about targetMs. */
function calibrate(byWorkload: Map<string, Case[]>, targetMs: number) {
  const out: Record<string, { n: number; probeN: number; probeMs: Record<string, number> }> = {};
  for (const [w, cases] of byWorkload) {
    let n = 1;
    let probe: Record<string, number> = {};
    for (;;) {
      probe = {};
      for (const c of cases) probe[c.path] = runChecked(c, n);
      const slowest = Math.max(...Object.values(probe));
      if (slowest >= targetMs / 4 || n >= MAX_N) break;
      n = Math.min(MAX_N, n * 4);
    }
    const slowest = Math.max(...Object.values(probe));
    out[w] = {
      n: Math.max(1, Math.min(MAX_N, Math.round((n * targetMs) / slowest))),
      probeN: n,
      probeMs: probe,
    };
  }
  return out;
}

/** The smallest positive difference between successive timer reads (ms), over 20000 reads. */
function timerResolutionMs(): number {
  let min = Infinity;
  let last = now();
  for (let i = 0; i < 20000; i++) {
    const t = now();
    if (t > last && t - last < min) min = t - last;
    last = t;
  }
  return min;
}

function environment(jsi: JsiControl) {
  const bindings = runtimeBindings();
  const lifecycle = bindings.lifecycle() as unknown as Record<string, number>;
  return {
    platform: Platform.OS,
    platformVersion: Platform.Version,
    reactNative: (Platform.constants as any)?.reactNativeVersion,
    dev: __DEV__,
    hermes: global.HermesInternal?.getRuntimeProperties?.() ?? null,
    timer: now === Date.now ? 'Date.now' : 'performance.now',
    timerResolutionMs: timerResolutionMs(),
    gcCountAvailable: gcCount() !== null,
    cxxBuild: jsi.build,
    rnrsTestHooks: bindings.testHooks,
    rnrsDiagnosticsKeys: Object.keys(lifecycle).filter((k) => k.startsWith('diag')),
    thermalStateStart: jsi.thermalState(),
  };
}

export async function runHarness(status: (text: string) => void): Promise<void> {
  const tm = RnrsCmpCxx;
  if (!tm.installHarness()) throw new Error('installHarness failed');
  const jsi = global.__rnrsCmpJsi as JsiControl;
  let config: Config | null = null;
  const started = now();
  try {
    config = await readConfig(jsi);
    status(`run ${config.runId}: settling ${config.settleMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, config!.settleMs));
    const env = environment(jsi);
    if (env.dev) throw new Error('__DEV__ build: refusing to measure');
    if (env.rnrsDiagnosticsKeys.length)
      throw new Error('rnrs diagnostics build: refusing to measure');
    // Isolates one dynamic-receiver JS wrapper frame; does not model rnrs's
    // bound helper/index arguments, which remain part of its measured overhead.
    const wrapped = {
      host: jsi.guarded,
      nop() {
        this.host.nop();
      },
      add(a: number, b: number) {
        return this.host.add(a, b);
      },
      flip(b: boolean) {
        return this.host.flip(b);
      },
    };
    // callp: bound to (object, helpers), rnrs's positional shape before 840d332; callpThis:
    // helpers as `this` (callh since 840d332); unbound: the host function called directly
    // with the host instance as `this` (the shape of protocol 3 prepared scalar entries).
    const helpers = {};
    const g = jsi.guarded;
    const receivers: Receivers = {
      rnrs: turboCompareModule(),
      tm: tm as unknown as CmpApi,
      jsi,
      guarded: g,
      wrapped,
      shaped: new ShapedModule(new ShapedHost(g.callp.bind(g, helpers))),
      shapedThis: new ShapedModule(new ShapedHost(g.callpThis.bind(helpers))),
      shapedUnbound: new ShapedModule(new ShapedHost(g.callpThis)),
    };
    const checks = correctness(receivers);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length)
      throw Object.assign(new Error(`${failed.length} correctness checks failed`), { checks });

    // From here to the report the JS thread never yields: no rendering between samples.
    status(`run ${config.runId}: measuring`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cases = makeCases(receivers, makeFixtures());
    const byWorkload = new Map<string, Case[]>();
    for (const c of cases) byWorkload.set(c.workload, [...(byWorkload.get(c.workload) ?? []), c]);
    let calib: Record<string, { n: number; probeN?: number; probeMs?: Record<string, number> }>;
    if (config.fixedN) {
      const fixed = config.fixedN;
      const keys = [...byWorkload.keys()];
      const bad = keys.filter(
        (w) => !(Number.isInteger(fixed[w]) && fixed[w] >= 1 && fixed[w] <= MAX_N),
      );
      const extra = Object.keys(fixed).filter((w) => !byWorkload.has(w));
      if (bad.length || extra.length)
        throw new Error(`fixedN: invalid ${bad.join(',')} unknown ${extra.join(',')}`);
      calib = Object.fromEntries(keys.map((w) => [w, { n: fixed[w] }]));
    } else calib = calibrate(byWorkload, config.targetMs);

    // Samples: [phase (0 warmup, 1 measured), round, position in round, workload, path, n, ms, GCs].
    const rows: (string | number | null)[][] = [];
    const random = prng(config.seed);
    const total = config.warmupRounds + config.rounds;
    for (let round = 0; round < total; round++) {
      const phase = round < config.warmupRounds ? 0 : 1;
      let pos = 0;
      for (const w of shuffle([...byWorkload.keys()], random)) {
        const n = calib[w].n;
        for (const c of shuffle(byWorkload.get(w)!, random)) {
          const gc0 = gcCount();
          const t0 = now();
          const result = c.run(n);
          const ms = now() - t0;
          const gc1 = gcCount();
          if (result !== c.expect(n))
            throw new Error(`${w}/${c.path}: checksum ${result}, expected ${c.expect(n)} (n=${n})`);
          rows.push([
            phase,
            round - (phase ? config.warmupRounds : 0),
            pos++,
            w,
            c.path,
            n,
            ms,
            gc0 === null || gc1 === null ? null : gc1 - gc0,
          ]);
        }
      }
    }
    emit(config.runId, {
      type: 'report',
      runId: config.runId,
      seed: config.seed,
      config,
      env,
      checks,
      calib,
      columns: ['phase', 'round', 'pos', 'workload', 'path', 'n', 'ms', 'gcs'],
      rows,
      thermalStateEnd: jsi.thermalState(),
      totalMs: now() - started,
    });
    emit(config.runId, { type: 'done', runId: config.runId, samples: rows.length });
    status(`run ${config.runId}: done, ${rows.length} samples`);
  } catch (e) {
    const err = e as Error & { checks?: Check[] };
    const runId = config?.runId ?? 'unknown';
    emit(runId, {
      type: 'error',
      runId,
      message: String(err?.message ?? e),
      stack: err?.stack,
      checks: err?.checks,
    });
    status(`run ${runId}: ERROR ${String(err?.message ?? e)}`);
  }
}
