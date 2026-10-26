// Binary-first web smoke (scripts/consumer/binary-first.sh web): counter and meter as independent Wasm instances (or, mixed,
// counter in the source bundle). Public module APIs plus documented test hooks (stats,
// createXForTesting); `host.dispose` is the runtime-internal path NativeObjectBase.dispose uses.
import { counterModule, createCounterModuleForTesting } from '@rnrs/example-counter';
import { meterModule } from '@rnrs/labs-meter';
import { RnrsError } from '@rnrs/runtime';

export interface SmokeResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(): Promise<SmokeResult> {
  const checks: SmokeResult['checks'] = [];
  async function check(name: string, body: () => Promise<string | void> | string | void) {
    try {
      checks.push({ name, ok: true, detail: (await body()) ?? '' });
    } catch (error) {
      checks.push({ name, ok: false, detail: String((error as Error)?.stack ?? error) });
    }
  }
  const fail = (m: string): never => {
    throw new Error(m);
  };
  const eq = (what: string, got: unknown, want: unknown) => {
    if (!Object.is(got, want)) fail(`${what}: got ${String(got)}, want ${String(want)}`);
  };
  const rejects = async (what: string, p: Promise<unknown>, code: string) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof RnrsError && e.code === code) return;
      fail(`${what}: rejected with ${String(e)} (code ${(e as RnrsError)?.code}), want ${code}`);
    }
    fail(`${what}: resolved, want rejection ${code}`);
  };
  const counter = counterModule();
  const meter = meterModule();
  const live = () => ({
    gauge: meter.stats().native.Gauge,
    counter: counter.stats().native.Counter,
  });

  await check('scalar fast path and generic calls in both instances', () => {
    eq('hypot', meter.hypot(3, 4), 5);
    eq('isNegativeZero(-0)', meter.isNegativeZero(-0), true);
    const c = counter.create(5);
    eq('add', c.add(2), 7);
    eq('increment', c.increment(), 8);
    eq('value', c.value(), 8);
  });

  await check('native objects within an instance', () => {
    const a = meter.gauge(3);
    const b = meter.gauge(10);
    eq('maxWith', a.maxWith(b).get(), 10);
    eq('combine (sum)', meter.combine(a, a).get(), 6);
  });

  await check("another instance's object as an argument is a TypeError; both stay usable", () => {
    const g = meter.gauge(1);
    const c = counter.create(1);
    let error: unknown;
    try {
      meter.combine(g, c as never);
    } catch (e) {
      error = e;
    }
    if (!(error instanceof TypeError)) fail(`combine(gauge, counter) threw ${String(error)}`);
    eq('gauge', g.get(), 1);
    eq('counter', c.value(), 1);
    return String((error as Error).message);
  });

  await check(
    "dispose of another instance's object is a no-op; owner and unrelated objects stay usable",
    () => {
      const g = meter.gauge(4);
      const other = meter.gauge(5); // an unrelated object that could share a slot number
      const c = counter.create(6);
      const before = live();
      (g as any).host.dispose((c as any).handle); // meter's host, counter's wrapper
      (c as any).host.dispose((g as any).handle); // counter's host, meter's wrapper
      eq('counter value', c.value(), 6);
      eq('gauge value', g.get(), 4);
      eq('other gauge value', other.get(), 5);
      const after = live();
      eq('gauges dropped', after.gauge.dropped - before.gauge.dropped, 0);
      eq('counters dropped', after.counter.dropped - before.counter.dropped, 0);
      g.dispose();
      eq('own dispose drops exactly one gauge', live().gauge.dropped - before.gauge.dropped, 1);
    },
  );

  await check('collected wrappers are released by their own instance only', async () => {
    const gc = (globalThis as any).gc as (() => void) | undefined;
    if (!gc) return 'skipped: no gc() (Chromium without --js-flags=--expose-gc)';
    // First let garbage of earlier checks be collected and released, until the counts are stable.
    for (let i = 0, last = ''; i < 50; i++) {
      gc();
      await sleep(20);
      const now = JSON.stringify(live());
      if (now === last) break;
      last = now;
    }
    const before = live();
    (() => {
      for (let i = 0; i < 10; i++) meter.gauge(i);
    })();
    for (let i = 0; i < 50 && live().gauge.dropped - before.gauge.dropped < 10; i++) {
      gc();
      await sleep(20);
    }
    const mid = live();
    eq('gauges released', mid.gauge.dropped - before.gauge.dropped, 10);
    eq('counters untouched', mid.counter.dropped - before.counter.dropped, 0);
    (() => {
      for (let i = 0; i < 7; i++) counter.create(i);
    })();
    for (let i = 0; i < 50 && live().counter.dropped - mid.counter.dropped < 7; i++) {
      gc();
      await sleep(20);
    }
    const end = live();
    eq('counters released', end.counter.dropped - mid.counter.dropped, 7);
    eq('gauges untouched', end.gauge.dropped - mid.gauge.dropped, 0);
    return `gauge ${JSON.stringify(end.gauge)}, counter ${JSON.stringify(end.counter)}`;
  });

  await check('concurrent async results reach the right promises in both instances', async () => {
    const c1 = counter.create(0);
    const c2 = counter.create(1000);
    const results = await Promise.all([
      c1.addLater(1, 40, false),
      meter.settleAfter(42, 25),
      c2.addLater(5, 10, false),
      meter.gaugeLater(7, 15).then((g) => g.get()),
      meter.settleAfter(-3.5, 5),
      c1.addLater(2, 60, false),
    ]);
    eq('results', JSON.stringify(results), JSON.stringify([1, 42, 1005, 7, -3.5, 3]));
    return JSON.stringify(results);
  });

  await check('async rejection and cancellation', async () => {
    await rejects('checkLater(-1)', meter.checkLater(-1), 'failed');
    const c = counter.create(0);
    const ac = new AbortController();
    const p = c.addLater(5, 5000, false, { signal: ac.signal });
    ac.abort();
    await rejects('aborted addLater', p, 'cancelled');
    await sleep(50);
    eq('value after cancel', c.value(), 0);
  });

  await check('teardown with in-flight work: rejected, other module unaffected', async () => {
    const extra = createCounterModuleForTesting(4);
    const c = extra.create(0);
    const inFlight = c.addLater(5, 150, true);
    const meterPending = meter.settleAfter(9, 250);
    extra.teardown();
    await rejects('in-flight after teardown', inFlight, 'closed');
    eq('meter result after counter teardown', await meterPending, 9);
    eq('runtime counter still works', counter.create(1).add(1), 2);
  });

  await check('scalar call rate (sanity only)', () => {
    const n = 200_000;
    let x = 0;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) x += meter.hypot(i, 1);
    const ms = performance.now() - t0;
    if (!Number.isFinite(x)) fail('non-finite');
    return `${n} hypot calls in ${ms.toFixed(0)} ms (${((ms * 1e6) / n).toFixed(0)} ns/call)`;
  });

  return { ok: checks.every((c) => c.ok), checks };
}
