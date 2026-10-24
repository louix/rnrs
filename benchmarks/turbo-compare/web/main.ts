// Browser page of the comparison harness (informational). Same protocol as app/harness.ts: one
// literal loop per (workload, path) (cases.generated.ts), fixed n per workload, warmup + measured
// rounds with seeded shuffles of workloads and paths, every checksum checked after timing. Paths:
// the rnrs module on the Wasm backend, plain JS, the minimal direct wasm-bindgen crate (web/direct,
// no strict validation) and that crate behind thin strict JS checks. Run by scripts/web-test.mjs
// (RNRS_WEB_ROOT=benchmarks/turbo-compare/web, RNRS_WEB_QUERY=config=<URI-encoded JSON>).
import * as bundle from './rnrs/pkg/rnrs_bundle.js';
import initDirect, * as direct from './direct-pkg/cmp_wasm_direct.js';
import { initRnrs } from '@rnrs/runtime/web';
import { turboCompareModule } from '../rnrs-module/rnrs/index';
import { makeFixtures } from '../app/fixtures';
import { makeCases } from './cases.generated';
import type { Case, Ops, Receivers } from './types';

interface Config {
  runId: string;
  seed: number;
  rounds: number;
  warmupRounds: number;
  fixedN: Record<string, number>;
}

const now = () => performance.now();

/** mulberry32, as app/harness.ts. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(items: T[], random: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
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

// Plain JS with the strict contract of the other paths (typeof checks, ordinary element reads).
function strictNumber(x: unknown, name: string): number {
  if (typeof x !== 'number') throw new TypeError(`${name} must be a number`);
  return x;
}
function strictArray(xs: unknown): number[] {
  if (!Array.isArray(xs)) throw new TypeError('xs must be an array');
  for (let i = 0; i < xs.length; i++) strictNumber(xs[i], `xs[${i}]`);
  return xs;
}
const js: Ops = {
  nop() {},
  add(a: number, b: number) {
    return strictNumber(a, 'a') + strictNumber(b, 'b');
  },
  flip(b: boolean) {
    if (typeof b !== 'boolean') throw new TypeError('b must be a boolean');
    return !b;
  },
  arrSum(xs: number[]) {
    strictArray(xs);
    let sum = 0;
    for (let i = 0; i < xs.length; i++) sum += xs[i];
    return sum;
  },
};

// The direct crate as wasm-bindgen exports it: f64 via ToNumber, bool via truthiness, &[f64] copied
// with Float64Array.set (ToNumber per element) into linear memory, then freed.
const wasm: Ops = {
  nop: () => direct.nop(),
  add: (a, b) => direct.add(a, b),
  flip: (b) => direct.flip(b),
  arrSum: (xs) => direct.arrSum(xs as unknown as Float64Array),
};
// The same crate behind the strict checks (one extra validation pass over the array before the
// glue's own copy).
const wasmChecked: Ops = {
  nop: () => direct.nop(),
  add: (a, b) => direct.add(strictNumber(a, 'a'), strictNumber(b, 'b')),
  flip(b) {
    if (typeof b !== 'boolean') throw new TypeError('b must be a boolean');
    return direct.flip(b);
  },
  arrSum: (xs) => direct.arrSum(strictArray(xs) as unknown as Float64Array),
};

interface Check {
  path: string;
  name: string;
  ok: boolean;
  detail?: string;
}

function correctness(r: Receivers): Check[] {
  const fx = makeFixtures();
  const checks: Check[] = [];
  const check = (path: string, name: string, body: () => boolean) => {
    try {
      checks.push({ path, name, ok: body() });
    } catch (e) {
      checks.push({ path, name, ok: false, detail: String((e as Error)?.message ?? e) });
    }
  };
  for (const [path, m] of Object.entries(r) as [string, Ops][]) {
    check(path, 'nop() is undefined', () => m.nop() === undefined);
    check(path, 'add(-1.25, 3.5) = 2.25', () => m.add(-1.25, 3.5) === 2.25);
    check(path, 'add(NaN, 1) is NaN', () => Number.isNaN(m.add(NaN, 1)));
    check(path, 'add(-0, -0) is -0', () => Object.is(m.add(-0, -0), -0));
    check(path, 'flip(true/false)', () => m.flip(true) === false && m.flip(false) === true);
    for (const len of [16, 256, 1024])
      check(path, `arrSum of the four rotated ${len}-element arrays`, () =>
        [0, 1, 2, 3].every(
          (k) =>
            m.arrSum(fx.rotArrays[len][k]) ===
            fx.rotatedTotal(len, k + 1) - fx.rotatedTotal(len, k),
        ),
      );
  }
  return checks;
}

/** Out-of-contract behaviour per path, recorded (not required to agree). */
function semantics(r: Receivers) {
  const out: { path: string; probe: string; outcome: string }[] = [];
  const observe = (path: string, probe: string, f: () => unknown) => {
    let outcome: string;
    try {
      const v = f();
      outcome = `value ${Object.is(v, -0) ? '-0' : typeof v === 'number' && !Number.isFinite(v) ? String(v) : JSON.stringify(v)}`;
    } catch (e) {
      const err = e as Error;
      outcome = `throws ${err?.name ?? typeof e}: ${String(err?.message ?? e)
        .split('\n')[0]
        .slice(0, 160)}`;
    }
    out.push({ path, probe, outcome });
  };
  for (const [path, m] of Object.entries(r) as [string, Ops][]) {
    observe(path, "add('1', 2)", () => m.add('1' as any, 2));
    observe(path, 'add(1) (missing argument)', () => (m.add as any)(1));
    observe(path, 'flip(1)', () => m.flip(1 as any));
    observe(path, "arrSum([1, '2'])", () => m.arrSum([1, '2' as any]));
    const holed = [1];
    holed[2] = 3;
    observe(path, 'arrSum([1, , 3]) (hole)', () => m.arrSum(holed));
    observe(path, 'arrSum({length: 2, 0: 1, 1: 2}) (array-like)', () =>
      m.arrSum({ length: 2, 0: 1, 1: 2 } as any),
    );
  }
  return out;
}

async function main() {
  const text = new URLSearchParams(location.search).get('config');
  if (!text) throw new Error('no config query parameter');
  const config = JSON.parse(text) as Config;
  // URLs relative to the bundled dist/main.js.
  await initRnrs(bundle as any, new URL('../rnrs/pkg/rnrs_bundle_bg.wasm', import.meta.url));
  await initDirect({
    module_or_path: new URL('../direct-pkg/cmp_wasm_direct_bg.wasm', import.meta.url),
  });
  const receivers: Receivers = { rnrs: turboCompareModule(), js, wasm, wasmChecked };
  const checks = correctness(receivers);
  const observed = semantics(receivers);
  if (checks.some((c) => !c.ok))
    throw Object.assign(new Error('correctness checks failed'), { checks });
  const env = {
    userAgent: navigator.userAgent,
    crossOriginIsolated: (globalThis as any).crossOriginIsolated === true,
    timerResolutionMs: timerResolutionMs(),
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
  const byWorkload = new Map<string, Case[]>();
  for (const c of makeCases(receivers, makeFixtures()))
    if (c.workload in config.fixedN)
      byWorkload.set(c.workload, [...(byWorkload.get(c.workload) ?? []), c]);
  const rows: (string | number)[][] = [];
  const random = prng(config.seed);
  const total = config.warmupRounds + config.rounds;
  for (let round = 0; round < total; round++) {
    const phase = round < config.warmupRounds ? 0 : 1;
    let pos = 0;
    for (const w of shuffle([...byWorkload.keys()], random)) {
      const n = config.fixedN[w];
      for (const c of shuffle(byWorkload.get(w)!, random)) {
        const t0 = now();
        const result = c.run(n);
        const ms = now() - t0;
        if (result !== c.expect(n))
          throw new Error(`${w}/${c.path}: checksum ${result}, expected ${c.expect(n)} (n=${n})`);
        rows.push([phase, round - (phase ? config.warmupRounds : 0), pos++, w, c.path, n, ms]);
      }
    }
  }
  return {
    ok: true,
    checks: checks.map((c) => ({ name: `${c.path}: ${c.name}`, ok: c.ok, detail: c.detail ?? '' })),
    report: {
      config,
      env,
      semantics: observed,
      columns: ['phase', 'round', 'pos', 'workload', 'path', 'n', 'ms'],
      rows,
    },
  };
}

const out = document.getElementById('out')!;
main().then(
  (result) => {
    out.textContent = `done: ${result.report.rows.length} samples`;
    (globalThis as any).__rnrsResult = result;
  },
  (error) => {
    out.textContent = `ERROR ${error}`;
    (globalThis as any).__rnrsResult = {
      ok: false,
      error: String(error?.message ?? error),
      checks: (error?.checks ?? []).map((c: Check) => ({
        name: `${c.path}: ${c.name}`,
        ok: c.ok,
        detail: c.detail ?? '',
      })),
    };
  },
);
