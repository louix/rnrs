// iOS device test of the clean consumer app (scripts/consumer/ios-app.sh builds it,
// scripts/consumer/ios-device-test.mjs runs it). Uses only the installed packages: their
// public APIs, their test-hook modules (create<X>ModuleForTesting) and @rnrs/runtime/testing.
//
// One process spans several JS runtimes. Each runtime finds its phase from the process-wide
// count of runtimes that installed the framework bindings (it survives reloads; the count of
// invalidations would not do: on iOS the next runtime starts before the old one is
// invalidated), runs it, reports, and reloads through React Native's own reload path (`__rnrRuntime.reloadForTesting()`, iOS test hook:
// release builds have no JS-reachable reload). Reports go to console.error, which a release
// build forwards to os_log; the runner launches the app with OS_ACTIVITY_DT_MODE so os_log is
// mirrored to the console it captures.
import { RnrError } from '@rnrs/runtime';
import { registeredModuleCount, runtimeBindings } from '@rnrs/runtime/testing';
import {
  CounterModule,
  counterModule,
  createCounterModuleForTesting,
  type Counter,
} from '@rnrs/example-counter';
import { valuesModule } from '@rnrs/labs-values';
import { runSmoke } from './smoke';
import { runConformance } from './suites/conformance';
import { runMeterSuite } from './suites/meter-suite';
import { runValuesSuite } from './suites/values-suite';
import { runBlake3Suite } from './suites/blake3-suite';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const busyWait = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* hold the JS thread */
  }
};
const global = globalThis as any;
// Kept alive so wrappers are not finalized mid-phase.
const retained: object[] = [];

/** Repeated reloads with uncancellable jobs: phases 1..CHURN_CYCLES each start CHURN_JOBS. */
const CHURN_CYCLES = 4,
  CHURN_JOBS = 12,
  CHURN_MS = 15000;
const FINAL_PHASE = CHURN_CYCLES + 1;

let sequence = 0;
/** One report as console.error lines of at most 700 characters (os_log truncates long ones). */
function report(record: object) {
  const text = JSON.stringify(record);
  const id = `${Date.now()}-${sequence++}`;
  const parts = Math.ceil(text.length / 700) || 1;
  for (let i = 0; i < parts; i++)
    console.error(`RNR_IOS ${id} ${i + 1}/${parts} ${text.slice(i * 700, (i + 1) * 700)}`);
}

async function collectGarbage() {
  runtimeBindings().collectGarbageForTesting!();
  await sleep(0);
}

function snapshot(module: CounterModule) {
  return {
    stats: module.stats(),
    lifecycle: runtimeBindings().lifecycle(),
    registeredModules: registeredModuleCount(),
  };
}

async function waitForBudget(module: CounterModule, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (
    Date.now() < deadline &&
    ((module.stats().budgetRunning ?? 0) > 0 || (module.stats().budgetOrphaned ?? 0) > 0)
  )
    await sleep(100);
}

/** Starts `count` uncancellable jobs spread over `modules`; returns admission outcomes. */
async function startStubborn(modules: CounterModule[], count: number, ms: number) {
  const counters: Counter[] = modules.map((m) => m.create(0));
  retained.push(...counters);
  const outcomes = await Promise.all(
    Array.from({ length: count }, (_, i) => {
      const promise = counters[i % counters.length].addLater(1, ms, true);
      return Promise.race([
        promise.then(
          () => 'resolved',
          (e: any) => `${e.code}:${e.scope ?? ''}:${e.message}`,
        ),
        sleep(50).then(() => 'admitted'),
      ]);
    }),
  );
  const saturated = outcomes.filter((o) => o.startsWith('overloaded:executor'));
  return {
    admitted: outcomes.filter((o) => o === 'admitted').length,
    saturated: saturated.length,
    moduleOverloaded: outcomes.filter((o) => o.startsWith('overloaded:module')).length,
    other: outcomes.filter((o) => o !== 'admitted' && !o.startsWith('overloaded:')),
    message: saturated[0]?.split(':').slice(2).join(':') ?? '',
  };
}

function reload(main: CounterModule, tag: string) {
  report({
    type: 'reloading',
    tag,
    at: Date.now(),
    ...snapshot(main),
    generation: main.generation,
  });
  runtimeBindings().reloadForTesting!();
}

async function phaseSuites(main: CounterModule, update: (s: string) => void) {
  update('Smoke and suites…');
  const smoke = await runSmoke();
  report({ type: 'smoke', ...smoke });
  const checks = await runConformance({
    platform: 'ios',
    makeModule: createCounterModuleForTesting,
    runtimeModule: counterModule,
    collectGarbage,
    registeredModules: registeredModuleCount,
  });
  checks.push(...(await runMeterSuite({ platform: 'ios', collectGarbage })));
  checks.push(
    ...(await runValuesSuite({
      collectGarbage,
      forceBytesCopyOut: (force) => runtimeBindings().forceBytesCopyOutForTesting!(force),
    })),
  );
  checks.push(...(await runBlake3Suite()));
  // Report each check separately: the whole list is long.
  for (const c of checks) report({ type: 'check', ...c });
  report({
    type: 'suites',
    ok: checks.every((c) => c.ok),
    passed: checks.filter((c) => c.ok).length,
    total: checks.length,
  });
  update(
    `Suites: ${checks.filter((c) => c.ok).length}/${checks.length}; reloading with work in flight…`,
  );

  // Work in flight across runtime destruction: cooperative, non-cooperative, completions
  // spread over the reload, and Rust-owned ArrayBuffers alive when the runtime is destroyed.
  const counter = main.create(100);
  const racer = createCounterModuleForTesting(32).create(0); // torn down only by invalidation
  retained.push(
    counter,
    racer,
    ...Array.from({ length: 10 }, () => valuesModule().makeBytes(4096)),
  );
  const pending: Promise<number>[] = [
    counter.addLater(1, 4000, false),
    counter.addLater(1, 1500, true),
  ];
  for (let i = 0; i < 24; i++)
    pending.push(racer.addLater(1, Math.floor((i / 24) * 900), i % 2 === 0));
  pending.forEach((p) => p.catch(() => {}));
  await sleep(50);
  reload(main, 'with-work');
  // React Native runs the invalidation as a JS-thread block, so it waits for this task:
  // completions land while JS is busy and are still queued when the runtime is invalidated.
  for (let i = 0; i < 16; i++) racer.addLater(1, 600 + (i - 8) * 2, true).catch(() => {});
  busyWait(600);
}

async function phaseAfterReload(main: CounterModule, phase: number) {
  // The previous runtime's jobs may still run; once they exit nothing of it is left running.
  const first = snapshot(main);
  await waitForBudget(main, 8000);
  const drained = snapshot(main);
  const c = main.create(1);
  retained.push(c);
  let value: number | string;
  try {
    value = await c.addLater(1, 10, false);
  } catch (e: any) {
    value = `${e.code}: ${e.message}`;
  }
  report({
    type: 'after-reload',
    phase,
    first,
    drained,
    value,
    violations: main.violations,
    generation: main.generation,
  });
}

async function phaseChurn(main: CounterModule, cycle: number) {
  // The extra test-hook module is deliberately never torn down: invalidation must do it.
  const extra = createCounterModuleForTesting(8);
  const result = await startStubborn([main, extra], CHURN_JOBS, CHURN_MS);
  report({ type: 'churned', cycle, ...result, ...snapshot(main), generation: main.generation });
  reload(main, `churn-${cycle}`);
}

async function phaseFinal(main: CounterModule) {
  await waitForBudget(main, CHURN_MS + 10000);
  const drained = snapshot(main);
  const c = main.create(1);
  retained.push(c);
  let value: number | string;
  try {
    value = await c.addLater(1, 10, false);
  } catch (e: any) {
    value = `${e.code}: ${e.message}`;
  }
  await collectGarbage();
  report({
    type: 'drained',
    ...drained,
    after: snapshot(main),
    value,
    violations: main.violations,
    generation: main.generation,
  });

  // An adapter created after its scope was invalidated is refused at once, and its host is
  // freed before install throws (no destructor fallback).
  const before = main.stats();
  runtimeBindings().invalidateForTesting!();
  let error = '';
  try {
    runtimeBindings().install(CounterModule.descriptor.name, CounterModule.descriptor.hash, 4);
  } catch (e) {
    error = String(e);
  }
  const after = main.stats();
  let mainAfter: string;
  try {
    main.create(0);
    mainAfter = 'usable';
  } catch (e) {
    mainAfter = e instanceof RnrError ? `${e.code}: ${e.message}` : String(e);
  }
  report({
    type: 'refused',
    error,
    before,
    after,
    mainAfter,
    lifecycle: runtimeBindings().lifecycle(),
  });
}

export async function runIosDeviceTest(update: (s: string) => void) {
  // One run per runtime; a remounted surface reuses it.
  if (global.__rnrIosRun) return;
  global.__rnrIosRun = true;
  const main = counterModule();
  const phase = runtimeBindings().lifecycle().bindingsInstalled - 1;
  report({
    type: 'runtime',
    phase,
    scopeId: runtimeBindings().scopeId,
    platform: runtimeBindings().platform,
    testHooks: runtimeBindings().testHooks,
    ...snapshot(main),
    generation: main.generation,
    env: { build: __DEV__ ? 'debug' : 'release', hermes: !!global.HermesInternal },
  });
  try {
    if (!runtimeBindings().testHooks) {
      // The default package (no RNR_TEST_HOOKS): only the public-API smoke, no lifecycle phases.
      update('Default build (no test hooks): smoke only…');
      report({ type: 'smoke', ...(await runSmoke()) });
      report({
        type: 'done',
        defaultBuild: true,
        hooksExposed: [
          'invalidateForTesting',
          'forceBytesCopyOutForTesting',
          'collectGarbageForTesting',
          'reloadForTesting',
        ].filter((name) => typeof (runtimeBindings() as any)[name] === 'function'),
      });
      update('Default build: smoke finished.');
      return;
    }
    if (phase === 0) {
      await phaseSuites(main, update);
    } else if (phase <= CHURN_CYCLES) {
      update(`Phase ${phase}: reload checks and churn…`);
      if (phase === 1) await phaseAfterReload(main, phase);
      await phaseChurn(main, phase);
    } else if (phase === FINAL_PHASE) {
      update('Final phase: waiting for old work to exit…');
      await phaseFinal(main);
      report({ type: 'done' });
      update('Device checks finished.');
    } else {
      update('Device checks finished.');
    }
  } catch (error) {
    report({ type: 'error', phase, error: String((error as Error)?.stack ?? error) });
    update(`Error: ${error}`);
  }
}
