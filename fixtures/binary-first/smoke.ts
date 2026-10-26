// Binary-first consumer smoke (scripts/consumer/binary-first.sh): two independently built module
// binaries (counter, meter) in one React Native app. Only public module APIs and the documented
// test hooks (createXForTesting, stats, and the reload hook when compiled in).
import { counterModule, createCounterModuleForTesting } from '@rnrs/example-counter';
import { meterModule } from '@rnrs/labs-meter';
import { RnrsError } from '@rnrs/runtime';
import { runtimeBindings } from '@rnrs/runtime/testing';

export interface SmokeResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  /** Set when this run started a React Native reload (the next run reports the result). */
  reloading?: boolean;
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

  // A real React Native reload with work in flight in both binaries (test-hook builds only).
  // Each binary keeps its own process-wide counters across reloads, so the first run (this
  // binary's first host) starts the work and reloads; the next run checks how both binaries
  // tore their old generation down.
  const bindings = runtimeBindings();
  if (bindings.testHooks && bindings.reloadForTesting) {
    // No lifecycle teardown yet in this process: the first run.
    if (counter.stats().tornDownLifecycle === 0 && meter.stats().tornDownLifecycle === 0) {
      const c = counter.create(0);
      void c.addLater(1, 400, true).catch(() => {}); // non-cooperative: still running at teardown
      void c.addLater(1, 60_000, false).catch(() => {}); // cooperative: cancelled by teardown
      void meter.settleAfter(1, 9_000).catch(() => {}); // meter accepts at most 10 s
      await sleep(20);
      bindings.reloadForTesting();
      return { ok: true, checks: [], reloading: true };
    }
    await check('React Native reload with in-flight async in both binaries', async () => {
      await sleep(600); // the non-cooperative counter work exits meanwhile
      const cs = counter.stats();
      const ms = meter.stats();
      // Teardown statistics are per binary. Separate binaries (prebuilt): counter had 2
      // operations in flight (both cancelled; neither had exited at that instant), meter 1. One
      // shared source bundle reports the sum for both modules.
      const shared =
        cs.hostsCreated === ms.hostsCreated && cs.teardownCancelled === ms.teardownCancelled;
      const want = shared
        ? { counter: [2, 3, 3], meter: [2, 3, 3] }
        : { counter: [1, 2, 2], meter: [1, 1, 1] };
      for (const [name, s, [lifecycle, cancelled, stillRunning]] of [
        ['counter', cs, want.counter],
        ['meter', ms, want.meter],
      ] as const) {
        eq(`${name} torn down by lifecycle`, s.tornDownLifecycle, lifecycle);
        eq(`${name} cancelled at teardown`, s.teardownCancelled, cancelled);
        eq(`${name} still running at teardown`, s.teardownStillRunning, stillRunning);
        eq(`${name} budget released once the work exited`, s.budgetRunning, 0);
        eq(`${name}'s new generation saw no stray results`, s.delivered + s.discarded, 0);
      }
      return JSON.stringify({
        binaries: shared ? 'one shared' : 'separate',
        counter: {
          gen: cs.generation,
          lifecycle: cs.tornDownLifecycle,
          cancelled: cs.teardownCancelled,
          stillRunning: cs.teardownStillRunning,
          budgetRunning: cs.budgetRunning,
        },
        meter: {
          gen: ms.generation,
          lifecycle: ms.tornDownLifecycle,
          cancelled: ms.teardownCancelled,
          stillRunning: ms.teardownStillRunning,
        },
      });
    });
  }

  await check('scalar fast path and generic calls in both binaries', () => {
    eq('hypot', meter.hypot(3, 4), 5);
    eq('isNegativeZero(-0)', meter.isNegativeZero(-0), true);
    eq('isNegativeZero(0)', meter.isNegativeZero(0), false);
    const c = counter.create(5);
    eq('add', c.add(2), 7);
    eq('increment', c.increment(), 8);
    eq('value', c.value(), 8);
    eq('NaN add', Number.isNaN(counter.create(NaN).add(1)), true);
    return `meter.calls=${meter.calls()}`;
  });

  await check('native objects within a binary', () => {
    const a = meter.gauge(3);
    const b = meter.gauge(10);
    eq('maxWith', a.maxWith(b).get(), 10);
    eq('combine (sum)', meter.combine(a, a).get(), 6);
    a.set(11);
    eq('isAbove', a.isAbove(10), true);
  });

  await check("another binary's object is refused as a TypeError before reaching Rust", () => {
    const g = meter.gauge(1);
    const c = counter.create(1);
    let error: unknown;
    try {
      meter.combine(g, c as never);
    } catch (e) {
      error = e;
    }
    if (!(error instanceof TypeError)) fail(`combine(gauge, counter) threw ${String(error)}`);
    eq('gauge still usable', g.get(), 1);
    eq('counter still usable', c.value(), 1);
    return String((error as Error).message);
  });

  await check('module generations are unique across binaries', () => {
    const gens = [counter.generation, meter.generation];
    if (gens[0] === gens[1]) fail(`both modules have generation ${gens[0]}`);
    return `counter ${gens[0]}, meter ${gens[1]}`;
  });

  await check('concurrent async results reach the right promises in both binaries', async () => {
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
    await meter.checkLater(1);
    const c = counter.create(0);
    const ac = new AbortController();
    const p = c.addLater(5, 5000, false, { signal: ac.signal });
    ac.abort();
    await rejects('aborted addLater', p, 'cancelled');
    await sleep(50);
    eq('value after cancel', c.value(), 0);
  });

  await check(
    'teardown with in-flight work: rejected, no late settle, other modules unaffected',
    async () => {
      const extra = createCounterModuleForTesting(4);
      if ([counter.generation, meter.generation].includes(extra.generation))
        fail('extra generation collides');
      const c = extra.create(0);
      const inFlight = c.addLater(5, 150, true); // non-cooperative: keeps running after teardown
      const meterPending = meter.settleAfter(9, 250); // settles after counter's late result
      extra.teardown();
      await rejects('in-flight after teardown', inFlight, 'closed');
      eq('meter result after counter teardown', await meterPending, 9);
      let closed = '';
      try {
        c.value();
      } catch (e) {
        closed = String(e);
      }
      if (!closed) fail('a torn-down module still answered');
      eq('runtime counter still works', counter.create(1).add(1), 2);
      return closed;
    },
  );

  await check('native objects are released through their own binary (dispose)', () => {
    const before = meter.stats().native.Gauge;
    const gauges = Array.from({ length: 20 }, (_, i) => meter.gauge(i));
    for (const g of gauges) g.dispose();
    const after = meter.stats().native.Gauge;
    eq('created', after.created - before.created, 20);
    eq('dropped', after.dropped - before.dropped, 20);
    const cs = counter.stats();
    const ms = meter.stats();
    // Per-binary runtime state: each binary counts only its own hosts and has its own budget.
    return `counter hostsCreated=${cs.hostsCreated} budgetLimit=${cs.budgetLimit}; meter hostsCreated=${ms.hostsCreated} budgetLimit=${ms.budgetLimit}`;
  });

  await check('scalar call rate (sanity only)', () => {
    const n = 200_000;
    let x = 0;
    const t0 = Date.now();
    for (let i = 0; i < n; i++) x += meter.hypot(i, 1);
    const ms = Date.now() - t0;
    if (!Number.isFinite(x)) fail('non-finite');
    return `${n} hypot calls in ${ms} ms (${((ms * 1e6) / n).toFixed(0)} ns/call)`;
  });

  return { ok: checks.every((c) => c.ok), checks };
}
