// One Counter/async contract suite, run unchanged against each backend, over the
// generated Counter module (packages/counter/counter.spec.ts).
import { RnrsError, type AdapterStats } from '../../packages/runtime/src/runtime';
import { Counter, type CounterModule } from '../../.generated/rnrs/counter';

export interface ConformanceEnv {
  platform: string;
  /** Test hook: an extra adapter generation that the suite tears down itself. */
  makeModule(maxInFlight: number): CounterModule;
  /** The runtime's framework-owned module, as applications get it. */
  runtimeModule(): CounterModule;
  /** Best-effort forced GC plus a turn for finalizers. */
  collectGarbage(): Promise<void>;
  /** Open modules in the global settle registry, if the backend uses one (native). */
  registeredModules?(): number;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

class CheckFailure extends Error {}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailure(message);
}

async function waitFor(
  what: string,
  condition: () => boolean,
  timeoutMs = 3000,
  poll?: () => Promise<void>,
) {
  const deadline = now() + timeoutMs;
  while (!condition()) {
    if (now() > deadline) throw new CheckFailure(`timed out waiting for ${what}`);
    if (poll) await poll();
    await sleep(10);
  }
}

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new CheckFailure('expected rejection, got resolution');
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

function busyWait(ms: number) {
  const end = now() + ms;
  while (now() < end) {
    /* hold the JS thread */
  }
}

export async function runConformance(env: ConformanceEnv): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const main = env.makeModule(8);
  const stats = (): AdapterStats => main.stats();
  // Live Rust Counter objects (framework counts per native type).
  const dropped = (s: AdapterStats = stats()) => s.native.Counter.dropped;
  const live = () => {
    const s = stats();
    return s.native.Counter.created - s.native.Counter.dropped;
  };
  // Counters stay referenced until the suite ends, so drop counts change only where a
  // check releases a counter on purpose.
  const retained: object[] = [];
  const keep = <T extends object>(value: T): T => {
    retained.push(value);
    return value;
  };
  const make = (initial: number) => keep(main.create(initial));

  async function check(name: string, body: () => Promise<string | void> | string | void) {
    const start = now();
    try {
      const detail = (await body()) ?? '';
      results.push({ name, ok: true, ms: now() - start, detail });
    } catch (error) {
      results.push({
        name,
        ok: false,
        ms: now() - start,
        detail: String(error instanceof Error ? error.message : error),
      });
    }
  }

  await check('sync numeric methods use f64 semantics', () => {
    const c = make(1.5);
    expect(c.increment() === 2.5, 'increment');
    expect(c.add(-0.25) === 2.25, 'add');
    expect(c.value() === 2.25, 'value');
    expect(Number.isNaN(make(NaN).increment()), 'NaN propagates');
    expect(Object.is(make(-0).add(-0), -0), 'negative zero preserved');
    expect(make(Infinity).add(1) === Infinity, 'infinity');
    throws(() => c.add('1' as any), /number/);
    // A forged receiver: a wrapper-shaped object whose handle is not a native wrapper.
    throws(
      () =>
        Counter.prototype.add.call(
          { host: (main as any).host, handle: {} } as unknown as Counter,
          1,
        ),
      /Counter|expected|invalid/i,
    );
  });

  await check('async method resolves with the Rust result', async () => {
    const c = make(2.25);
    const started = now();
    const promise = c.addLater(2, 30, false);
    expect(c.value() === 2.25, 'value unchanged before completion');
    const result = await promise;
    expect(result === 4.25, `result ${result}`);
    expect(c.value() === 4.25, 'side effect visible');
    return `${(now() - started).toFixed(1)} ms for a 30 ms timer`;
  });

  await check('in-flight operation retains a disposed receiver', async () => {
    const before = dropped();
    let c: ReturnType<typeof main.create> | null = main.create(10);
    const promise = c.addLater(5, 300, false);
    c.dispose();
    throws(() => c!.value(), /disposed/);
    c = null;
    await env.collectGarbage();
    expect(dropped() === before, 'receiver destroyed while its task was running');
    expect((await promise) === 15, 'task used the live receiver');
    await waitFor('receiver release after task exit', () => dropped() === before + 1);
  });

  await check('GC finalization releases wrapper handles', async () => {
    const before = dropped();
    const createUnreferenced = (n: number) => {
      for (let i = 0; i < n; i++) main.create(i);
    };
    createUnreferenced(20);
    createUnreferenced(0);
    const trace: number[] = [];
    try {
      await waitFor(
        '20 finalized counters',
        () => dropped() >= before + 20,
        5000,
        async () => {
          await env.collectGarbage();
          if (trace.length < 5) trace.push(dropped() - before);
        },
      );
    } catch (error) {
      throw new CheckFailure(
        `${(error as Error).message}; dropped after successive GCs: ${trace.join(', ')}`,
      );
    }
    const s = stats();
    const threads =
      s.nativeFinalizers === undefined
        ? ''
        : `; native finalizers ${s.nativeFinalizers}, off JS thread ${s.nativeFinalizersOffJsThread}`;
    return `${dropped() - before} dropped; after successive GCs: ${trace.join(', ')}${threads}`;
  });

  await check('cooperative cancellation rejects promptly and stops work', async () => {
    const c = make(0);
    const controller = new AbortController();
    const promise = c.addLater(1, 10_000, false, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const started = now();
    const error = await rejection(promise);
    expect(
      error instanceof RnrsError && error.code === 'cancelled' && error.name === 'AbortError',
      `got ${error}`,
    );
    const elapsed = now() - started;
    expect(elapsed < 1000, `took ${elapsed} ms`);
    await waitFor('work exit', () => stats().inFlight === 0, 1000);
    expect(c.value() === 0, 'cancelled work had no side effect');
    return `rejected after ${elapsed.toFixed(1)} ms`;
  });

  await check('pre-aborted signal is rejected without admission', async () => {
    const admitted = stats().admitted;
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(make(0).addLater(1, 10, false, { signal: controller.signal }));
    expect(error.code === 'cancelled', `got ${error}`);
    expect(stats().admitted === admitted, 'operation was admitted');
  });

  await check('abort after completion has no effect', async () => {
    const delivered = stats().delivered;
    const controller = new AbortController();
    const value = await make(1).addLater(1, 5, false, { signal: controller.signal });
    controller.abort();
    await sleep(20);
    expect(value === 2, 'result');
    expect(stats().delivered === delivered + 1, 'exactly one outcome delivered');
  });

  await check('cancellation does not free memory in use by non-cooperative work', async () => {
    const before = stats();
    const disposed = make(0);
    const kept = make(0);
    const controller = new AbortController();
    const a = disposed.addLater(5, 400, true, { signal: controller.signal });
    const b = kept.addLater(5, 400, true, { signal: controller.signal });
    disposed.dispose();
    await sleep(30);
    controller.abort();
    const started = now();
    expect(
      (await rejection(a)).code === 'cancelled' && (await rejection(b)).code === 'cancelled',
      'cancel rejections',
    );
    expect(now() - started < 300, 'rejection was not prompt');
    const during = stats();
    expect(dropped(during) === dropped(before), 'receiver freed while work still runs');
    expect(during.inFlight === 2, `inFlight ${during.inFlight}`);
    await waitFor('non-cooperative work exit', () => stats().inFlight === 0, 2000);
    const after = stats();
    expect(dropped(after) === dropped(before) + 1, 'disposed receiver released after exit');
    expect(after.discarded === before.discarded + 2, 'late results discarded');
    expect(kept.value() === 5, 'rejection is not rollback: side effect happened');
  });

  await check('admission is bounded by running work', async () => {
    const module = env.makeModule(2);
    const c = keep(module.create(0));
    const controller = new AbortController();
    const running = [
      c.addLater(1, 10_000, false, { signal: controller.signal }),
      c.addLater(1, 10_000, false, { signal: controller.signal }),
    ];
    const error = await rejection(c.addLater(1, 1, false));
    expect(error.code === 'overloaded', `got ${error}`);
    // The native refusal's own message and scope reach JS unchanged.
    expect(
      error.scope === 'module' && error.message === 'too many operations in flight on this module',
      `got ${error.scope}: ${error.message}`,
    );
    controller.abort();
    await Promise.allSettled(running);
    await waitFor('slots freed', () => module.stats().slots === 0, 1000);
    expect((await c.addLater(1, 1, false)) === 1, 'admitted after slots freed');
    module.teardown();
  });

  await check('undrained outcomes hold admission slots', async () => {
    const module = env.makeModule(2);
    const c = keep(module.create(0));
    const done = [c.addLater(1, 0, false), c.addLater(1, 0, false)];
    busyWait(100); // native workers finish; their outcomes wait for this JS thread
    const s = module.stats();
    const error = await rejection(c.addLater(1, 0, false));
    expect(error.code === 'overloaded', `got ${error}`);
    if (env.platform === 'android' || env.platform === 'ios') {
      expect(
        s.inFlight === 0 && s.queued === 2 && s.slots === 2,
        `expected finished work with queued outcomes: ${JSON.stringify(s)}`,
      );
    }
    await Promise.all(done);
    expect(module.stats().slots === 0, 'slots released after delivery');
    expect((await c.addLater(1, 0, false)) === 3, 'admitted after drain');
    module.teardown();
    return `at rejection: inFlight ${s.inFlight}, queued ${s.queued}, slots ${s.slots}`;
  });

  await check('malformed operation ids never cancel valid work', async () => {
    const module = env.makeModule(2);
    const c = keep(module.create(0));
    const controller = new AbortController();
    const promise = c.addLater(1, 10_000, false, { signal: controller.signal });
    expect(module.stats().admitted === 1, 'fresh adapter: this operation has id 1');
    const malformed = [
      1.5,
      1 + 1e-12,
      0.999999,
      0,
      -0,
      -1,
      -0.5,
      NaN,
      Infinity,
      -Infinity,
      2 ** 53,
      2 ** 64,
      1e300,
    ];
    for (const id of malformed)
      expect((module as any).host.cancel(id) === false, `cancel(${id}) returned true`);
    const s = module.stats();
    expect(s.pending === 1 && s.inFlight === 1, `valid operation disturbed: ${JSON.stringify(s)}`);
    controller.abort(); // cancel(1) through the wrapper
    expect((await rejection(promise)).code === 'cancelled', 'valid id still cancels');
    module.teardown();
    return `${malformed.length} malformed ids rejected`;
  });

  await check('torn-down modules leave the settle registry and become collectible', async () => {
    const registered = env.registeredModules?.();
    const freedBefore = stats().hostsFreed;
    let closedGeneration = 0;
    const openAndClose = (n: number) => {
      for (let i = 0; i < n; i++) {
        const module = env.makeModule(1);
        closedGeneration = module.generation;
        if (i === 0)
          void module
            .create(0)
            .addLater(1, 0, false)
            .catch(() => {}); // pending at teardown
        module.teardown();
      }
    };
    openAndClose(20);
    openAndClose(0);
    if (registered !== undefined) {
      expect(
        env.registeredModules!() === registered,
        `registry ${env.registeredModules!()} != baseline ${registered}`,
      );
      (globalThis as any).__rnrsSettle(closedGeneration, 1, 0, 0, ''); // closed generation: silently ignored
    }
    await waitFor(
      '20 freed adapters',
      () => stats().hostsFreed >= freedBefore + 20,
      5000,
      env.collectGarbage,
    );
    return (
      `registry ${registered === undefined ? 'not used on this backend' : `back to ${registered}`}; ` +
      `${stats().hostsFreed - freedBefore} adapters freed after GC`
    );
  });

  await check('racing completion and cancellation settle exactly once', async () => {
    // 25 at a time: within the Android executor budget (32) as well as the module's slots.
    const module = env.makeModule(32);
    const c = keep(module.create(0));
    let resolved = 0,
      cancelled = 0,
      settledTwice = 0;
    for (let batch = 0; batch < 8; batch++) {
      const operations = Array.from({ length: 25 }, (_, i) => {
        const controller = new AbortController();
        const delay = (i * 7 + batch) % 15;
        setTimeout(() => controller.abort(), (i * 11 + batch * 3) % 15);
        let settlements = 0;
        return c
          .addLater(1, delay, false, { signal: controller.signal })
          .then(
            () => {
              settlements++;
              resolved++;
            },
            (error) => {
              settlements++;
              if (error.code === 'cancelled') cancelled++;
              else throw error;
            },
          )
          .finally(() => {
            if (settlements !== 1) settledTwice++;
          });
      });
      await Promise.all(operations);
    }
    const s = module.stats();
    await waitFor('all work exited', () => module.stats().inFlight === 0, 2000);
    expect(
      resolved + cancelled === 200 && settledTwice === 0,
      `resolved ${resolved} cancelled ${cancelled}`,
    );
    expect(s.delivered === 200 && s.admitted === 200, `delivered ${s.delivered}`);
    expect(c.value() >= resolved && c.value() <= 200, `value ${c.value()}`);
    expect(module.violations.length === 0, module.violations.join('; '));
    module.teardown();
    return `${resolved} resolved, ${cancelled} cancelled`;
  });

  await check('teardown with queued and running work, then a new generation', async () => {
    const module = env.makeModule(8);
    const c = keep(module.create(0));
    const queued = c.addLater(1, 0, false);
    busyWait(50); // native workers can finish and queue an outcome meanwhile
    const running = c.addLater(1, 200, false);
    const stubborn = c.addLater(1, 200, true);
    module.teardown();
    for (const p of [queued, running, stubborn]) {
      const error = await rejection(p);
      expect(error.code === 'closed', `got ${error}`);
    }
    throws(() => c.value(), /closed/);
    throws(() => module.create(0), /closed/);
    expect(
      (await rejection(c.addLater(1, 1, false))).toString().match(/closed/),
      'admission after teardown',
    );
    await waitFor('old generation work drained', () => module.stats().inFlight === 0, 2000);
    await sleep(50);
    const s = module.stats();
    expect(
      module.violations.length === 0,
      `late settlement reached JS: ${module.violations.join('; ')}`,
    );
    expect(s.open === 0, 'host still open');
    const next = env.makeModule(8);
    expect(next.generation !== module.generation, 'generation reused');
    expect((await keep(next.create(1)).addLater(1, 5, false)) === 2, 'new generation works');
    next.teardown();
    return `discarded ${s.discarded} late/queued results`;
  });

  await check('the runtime-scoped module is a framework-owned singleton', async () => {
    const module = env.runtimeModule();
    expect(env.runtimeModule() === module, 'same instance for the whole runtime');
    expect(module.runtimeOwned, 'marked runtime-owned');
    throws(() => module.teardown(), /framework/);
    const c = module.create(1);
    expect((await c.addLater(1, 1, false)) === 2, 'usable');
    c.dispose(); // object disposal is per object, independent of module ownership
    throws(() => c.value(), /disposed/);
    expect(module.stats().open === 1, 'still open after the attempted teardown');
    expect(module.violations.length === 0, module.violations.join('; '));
    return `generation ${module.generation}`;
  });

  await check('invalid async arguments are rejected before admission', async () => {
    const c = make(0);
    const admitted = stats().admitted;
    for (const delay of [NaN, -1, Infinity, 1e9]) {
      const error = await rejection(c.addLater(1, delay, false));
      expect(/delayMs/.test(String(error)), `got ${error}`);
    }
    expect(stats().admitted === admitted, 'invalid operation admitted');
  });

  await check('no settlement violations on the main module', () => {
    expect(main.violations.length === 0, main.violations.join('; '));
    expect(live() >= 0, 'counts');
  });
  main.teardown();
  return results;
}
