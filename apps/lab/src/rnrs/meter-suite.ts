// Shared suite for the generated Meter module (packages/meter/meter.spec.ts), run unchanged
// on Android and in the browser. Meter is shaped differently from Counter: module-level
// sync, void and boolean methods, per-runtime module state, native objects as arguments,
// async methods on the module itself, an async result that is a native object, and an
// async error path.
import { RnrsError } from '../../../../packages/runtime/src/runtime';
import { counterModule } from '../../../../.generated/rnrs/counter';
import { Gauge, createMeterModuleForTesting, meterModule } from '../../../../.generated/rnrs/meter';
import type { CheckResult } from './conformance';

export interface MeterEnv {
  platform: string;
  collectGarbage(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
class CheckFailure extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailure(message);
}
function throws(fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
  } catch (error) {
    expect(pattern.test(String(error)), `wrong error: ${error}`);
    return;
  }
  throw new CheckFailure(`expected throw matching ${pattern}`);
}
async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new CheckFailure('expected rejection, got resolution');
}

export async function runMeterSuite(env: MeterEnv): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const meter = meterModule();
  async function check(name: string, body: () => Promise<string | void> | string | void) {
    const start = now();
    try {
      const detail = (await body()) ?? '';
      results.push({ name: `meter: ${name}`, ok: true, ms: now() - start, detail });
    } catch (error) {
      results.push({
        name: `meter: ${name}`,
        ok: false,
        ms: now() - start,
        detail: String(error instanceof Error ? error.message : error),
      });
    }
  }

  await check('module methods: f64, boolean and void results', () => {
    expect(meter.hypot(3, 4) === 5, 'hypot');
    expect(
      Number.isNaN(meter.hypot(NaN, 1)) && meter.hypot(Infinity, NaN) === Infinity,
      'IEEE hypot',
    );
    expect(
      meter.isNegativeZero(-0) === true && meter.isNegativeZero(0) === false,
      'negative zero reaches Rust',
    );
    expect(meter.reset() === undefined, 'void is undefined');
    throws(() => meter.hypot('3' as any, 4), /a must be a number, got a string/);
    throws(() => meter.hypot(3, undefined as any), /b must be a number, got undefined/);
  });

  await check('module state lives per adapter generation', () => {
    meter.reset();
    meter.hypot(1, 1);
    meter.hypot(1, 1);
    const extra = createMeterModuleForTesting(2);
    extra.hypot(1, 1);
    const counts = `${meter.calls()} / ${extra.calls()}`;
    expect(meter.calls() === 2 && extra.calls() === 1, `calls ${counts}`);
    extra.teardown();
    throws(() => extra.calls(), /closed/);
    return `calls ${counts}`;
  });

  await check('native objects as arguments and results', () => {
    const a = meter.gauge(2);
    const b = meter.gauge(5);
    expect(a instanceof Gauge, 'wrapper class');
    expect(meter.combine(a, a).get() === 4, 'the same object twice');
    expect(meter.combine(a, b).get() === 7, 'combine');
    expect(a.maxWith(b).get() === 5, 'object method taking its own type');
    expect(a.set(9) === undefined && a.isAbove(8) && !a.isAbove(9), 'set / isAbove');
    throws(() => meter.combine({} as any, b), /a must be a Gauge/);
    const counter = counterModule().create(1);
    throws(() => meter.combine(counter as any, b), /a must be a Gauge/);
    b.dispose();
    throws(() => meter.combine(a, b), /Gauge is disposed/);
  });

  await check('async module methods: results, native results, failures', async () => {
    expect((await meter.settleAfter(7, 5)) === 7, 'number result');
    const g = await meter.gaugeLater(3, 5);
    expect(g instanceof Gauge && g.get() === 3, 'native result is a live wrapper');
    const failed = await rejection(meter.checkLater(-1));
    expect(
      failed instanceof RnrsError &&
        failed.code === 'failed' &&
        failed.message === 'negative reading: -1',
      `got ${failed}`,
    );
    expect((await meter.checkLater(1)) === undefined, 'void async resolves undefined');
  });

  await check('async validation rejects before admission; cancellation; module bound', async () => {
    const admitted = meter.stats().admitted;
    expect(
      /ms must be between/.test(String(await rejection(meter.settleAfter(1, -1)))),
      'validation',
    );
    expect(meter.stats().admitted === admitted, 'rejected before admission');
    const controller = new AbortController();
    const pending = meter.settleAfter(1, 5000, { signal: controller.signal });
    controller.abort();
    expect((await rejection(pending)).name === 'AbortError', 'cancelled');
    // The aborted operation keeps its slot until its Rust work has exited; wait for that,
    // so the bound below is measured from zero slots.
    for (let i = 0; i < 200 && meter.stats().slots > 0; i++) await sleep(5);
    expect(meter.stats().slots === 0, `${meter.stats().slots} slots still held after the abort`);
    const four = Array.from({ length: 4 }, () => meter.settleAfter(1, 50));
    const fifth = await rejection(meter.settleAfter(1, 50));
    expect(
      fifth.code === 'overloaded' && fifth.scope === 'module',
      `got ${fifth.code}/${fifth.scope}: ${fifth.message}`,
    );
    await Promise.all(four);
    return `5th concurrent call: ${fifth.message}`;
  });

  await check('unreferenced gauges are finalized', async () => {
    const before = meter.stats().native.Gauge.dropped;
    const make = (n: number) => {
      for (let i = 0; i < n; i++) meter.gauge(i);
    };
    make(20);
    make(0);
    const deadline = now() + 5000;
    while (meter.stats().native.Gauge.dropped < before + 20) {
      if (now() > deadline)
        throw new CheckFailure(
          `only ${meter.stats().native.Gauge.dropped - before} of 20 finalized`,
        );
      await env.collectGarbage();
      await sleep(10);
    }
    return `${meter.stats().native.Gauge.dropped - before} dropped`;
  });

  await check('no settlement violations', () => {
    expect(meter.violations.length === 0, meter.violations.join('; '));
  });
  return results;
}
