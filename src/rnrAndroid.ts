// Android harness for the ownership prototype (launch with `--es mode rnr`).
// scripts/rnr-device-test.mjs drives it: each JS runtime runs one step loop that asks the
// runner for the next step, runs it and reports. The runner performs the lifecycle actions
// in between (reload, ReactHost destroy, background/foreground, Activity destruction), so
// one loop can span several runtimes in the same process.
import NativeBench from '../specs/NativeBench';
import {
  checkNativeAdapter,
  installAndroidBackend,
  registeredModuleCount,
  runtimeBindings,
} from '../packages/rnr-runtime/src/jsi-backend';
import { runProtocolSuite } from './rnr/protocol-suite';
import {
  CounterModule,
  counterModule,
  createCounterModuleForTesting,
  type Counter,
} from '../.generated/rnr/counter';
import { runMeterSuite } from './rnr/meter-suite';
import { runValuesSuite } from './rnr/values-suite';
import { runBlake3Suite } from './rnr/blake3-suite';
import { valuesModule } from '../.generated/rnr/values';
import { httpModule } from '../.generated/rnr/rnr_http';
import { kvModule } from '../.generated/rnr/rnr_kv';

// The lab's own test databases (deleted by the runner's last step; nothing else is touched).
const KV_LIFECYCLE = 'rnr-lab-lifecycle';
const KV_PERSIST = 'rnr-lab-persist';
const KV_VALUE = 16 * 1024;
const kvValue = (i: number) => new Uint8Array(KV_VALUE).fill(i % 251).buffer;
/** Whether `b` is exactly the value written for `i` (never a partial write). */
const isKvValue = (b: ArrayBuffer, i: number) =>
  b.byteLength === KV_VALUE && new Uint8Array(b).every((x) => x === i % 251);
import { runConformance } from './rnr/conformance';

const COLLECTOR = 'http://127.0.0.1:8766/';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const busyWait = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* hold the JS thread */
  }
};

async function report(record: object) {
  try {
    const response = await fetch(COLLECTOR, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    if (!response.ok) throw new Error(`collector returned ${response.status}`);
  } catch (error) {
    // Logged so a lost report is distinguishable from a step that never finished (the
    // runner keeps logcat on failure).
    console.log(
      'RNR_REPORT_FAILED ' + JSON.stringify({ type: (record as any).type, error: String(error) }),
    );
    throw error;
  }
}

interface Step {
  step: string;
  [key: string]: any;
}

async function nextStep(query: Record<string, number>): Promise<Step> {
  const params = Object.entries(query)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const response = await fetch(`${COLLECTOR}next?${params}`);
  return response.json();
}

const global = globalThis as any;
// Kept alive across steps so wrappers are not finalized mid-test.
const retained: object[] = [];

function snapshot(module: CounterModule) {
  return {
    stats: module.stats(),
    lifecycle: runtimeBindings().lifecycle(),
    registeredModules: registeredModuleCount(),
  };
}

/** An HTTP response streaming from the runner's test server (port 8787 through adb
 *  reverse) that never ends: in flight when the runtime is destroyed. */
async function startEndlessHttp(tag: string) {
  const before = httpModule().diagnostics().bufferedBytes;
  httpModule()
    .fetch({ url: `http://127.0.0.1:8787/drip/forever?t=${tag}`, timeoutMs: 300000 })
    .catch(() => {});
  for (let i = 0; i < 100 && httpModule().diagnostics().bufferedBytes <= before; i++)
    await sleep(20);
}

/** Starts `count` uncancellable jobs spread over `modules`; returns admission outcomes. */
async function startStubborn(modules: CounterModule[], count: number, ms: number) {
  const counters: Counter[] = modules.map((m) => m.create(0));
  retained.push(...counters);
  const outcomes = await Promise.all(
    Array.from({ length: count }, (_, i) => {
      const promise = counters[i % counters.length].addLater(1, ms, true);
      // Admission failures reject synchronously-settled promises; admitted ones stay pending.
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

async function runStep(step: Step, update: (message: string) => void): Promise<boolean> {
  const main = counterModule();
  switch (step.step) {
    case 'idle':
      await sleep(200);
      return true;
    case 'conformance': {
      update('Conformance suite…');
      const checks = await runConformance({
        platform: 'android',
        makeModule: createCounterModuleForTesting,
        runtimeModule: counterModule,
        async collectGarbage() {
          global.__lab.collect();
          await sleep(0);
        },
        registeredModules: registeredModuleCount,
      });
      checks.push(
        ...(await runMeterSuite({
          platform: 'android',
          async collectGarbage() {
            global.__lab.collect();
            await sleep(0);
          },
        })),
      );
      checks.push(
        ...(await runValuesSuite({
          async collectGarbage() {
            global.__lab.collect();
            await sleep(0);
          },
          forceBytesCopyOut: (force) => runtimeBindings().forceBytesCopyOutForTesting!(force),
        })),
      );
      checks.push(...(await runBlake3Suite()));
      const f = () => {};
      checks.push(
        ...runProtocolSuite(
          'native',
          checkNativeAdapter,
          { call: f, callp: f },
          { call: f },
          'callp',
        ),
      );
      await report({ type: 'conformance', ok: checks.every((c) => c.ok), checks });
      update(`Conformance: ${checks.filter((c) => c.ok).length}/${checks.length}`);
      return true;
    }
    case 'snapshot':
      await report({
        type: step.tag,
        ...snapshot(main),
        generation: main.generation,
        mounts: global.__rnrMounts,
      });
      return true;
    case 'background': {
      // The runner backgrounds the app after `bg-armed` and foregrounds it later.
      const counter = main.create(0);
      retained.push(counter);
      const started = Date.now();
      const promise = counter.addLater(1, step.ms, false);
      // Bounded wait lines (15 s, 60 s; the runner foregrounds at ~6.5 s): if the operation
      // never settles, they show whether Rust work is pending (stats.pending), the outcome
      // is queued (stats.queued) with a drain outstanding or lost (lifecycle drain
      // counters), or nothing is logged because the JS thread is stuck.
      const waits = [15_000, 60_000].map((ms) =>
        setTimeout(
          () =>
            console.log(
              'RNR_BG_WAIT ' +
                JSON.stringify({ elapsedMs: Date.now() - started, ...snapshot(main) }),
            ),
          ms,
        ),
      );
      await report({ type: 'bg-armed', ...snapshot(main), generation: main.generation });
      let outcome: string;
      try {
        outcome = `resolved ${await promise}`;
      } catch (e: any) {
        outcome = `rejected ${e.code}`;
      } finally {
        waits.forEach(clearTimeout);
      }
      const result = {
        type: 'bg-result',
        outcome,
        elapsedMs: Date.now() - started,
        at: Date.now(),
        ...snapshot(main),
        generation: main.generation,
      };
      // In logcat before the report is sent while the app is backgrounded: if bg-result
      // never reaches the runner, this shows whether the operation settled.
      console.log('RNR_BG_RESULT ' + JSON.stringify(result));
      await report(result);
      return true;
    }
    case 'http-arm': {
      // An HTTP response streaming when the runtime is destroyed. Its promise never
      // settles here (late results are discarded with the runtime).
      await startEndlessHttp('http-arm');
      await report({
        type: 'http-armed',
        http: httpModule().diagnostics(),
        generation: main.generation,
      });
      return true;
    }
    case 'http-check': {
      // In the next runtime: the counters are process-wide, so they show whether the old
      // runtime's request future was dropped and its buffer released.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && httpModule().diagnostics().active > 0) await sleep(50);
      await report({ type: 'http-checked', http: httpModule().diagnostics() });
      return true;
    }
    case 'kv-arm': {
      // A database with writes in flight when the runtime is destroyed. The handle is not
      // closed: teardown releases it.
      const store = await kvModule().open(KV_LIFECYCLE);
      retained.push(store);
      await store.put(`marker/${step.tag}`, new Uint8Array([1, 2, 3]).buffer);
      await store.flush();
      for (let i = 0; i < step.writes; i++)
        store.put(`${step.tag}/${i}`, kvValue(i)).catch(() => {});
      await report({ type: 'kv-armed', kv: kvModule().diagnostics() });
      return true;
    }
    case 'kv-check': {
      // In the next runtime: the database opens (the old runtime's handles may still be
      // releasing) and every in-flight write was applied whole or not at all.
      const store = await kvModule().open(KV_LIFECYCLE);
      const marker = await store.get(`marker/${step.tag}`);
      let applied = 0,
        torn = 0;
      for (let i = 0; i < step.writes; i++) {
        const v = await store.get(`${step.tag}/${i}`);
        if (v === null) continue;
        if (isKvValue(v, i)) applied++;
        else torn++;
      }
      // Close vs in-flight operations on one handle: close waits, later calls reject. (24
      // writes plus close stay within the module's 32 admission slots.)
      const writes = Array.from({ length: 24 }, (_, i) =>
        store.put(`close/${step.tag}/${i}`, kvValue(i)).then(
          () => 'ok',
          (e) => String(e.message),
        ),
      );
      // Two concurrent closes: both resolve only after the in-flight writes (same outcome).
      await Promise.all([store.close(), store.close()]);
      const outcomes = await Promise.all(writes);
      let afterClose = '';
      try {
        await store.get('x');
      } catch (e: any) {
        afterClose = String(e.message);
      }
      const reopened = await kvModule().open(KV_LIFECYCLE);
      let closeApplied = 0;
      for (let i = 0; i < 24; i++) {
        const v = await reopened.get(`close/${step.tag}/${i}`);
        if (v && isKvValue(v, i)) closeApplied++;
      }
      await reopened.close();
      await report({
        type: 'kv-checked',
        marker: marker ? Array.from(new Uint8Array(marker)) : null,
        applied,
        torn,
        closeOk: outcomes.filter((o) => o === 'ok').length,
        closeRefused: outcomes.filter((o) => o.startsWith('closed')).length,
        closeApplied,
        afterClose,
        kv: kvModule().diagnostics(),
      });
      return true;
    }
    case 'kv-persist-write': {
      for (const name of [KV_LIFECYCLE, KV_PERSIST])
        await kvModule()
          .deleteDatabase(name)
          .catch(() => false);
      const store = await kvModule().open(KV_PERSIST);
      retained.push(store);
      await store.put(
        'token',
        new Uint8Array(Array.from(step.token as string, (c) => c.charCodeAt(0))).buffer,
      );
      const flushed = await store.flush();
      await report({ type: 'kv-persist-written', flushed });
      return true;
    }
    case 'kv-persist-read': {
      const store = await kvModule().open(KV_PERSIST);
      const v = await store.get('token');
      await store.close();
      retained.length = 0; // drop earlier handles so the databases can be deleted
      // Cleanup of the lab's own databases: true deleted, false already absent, or the error
      // (retried while a handle is still being released).
      const cleanup: Record<string, boolean | string> = {};
      for (const name of [KV_PERSIST, KV_LIFECYCLE]) {
        for (let i = 0; i < 50; i++) {
          try {
            cleanup[name] = await kvModule().deleteDatabase(name);
            break;
          } catch (e: any) {
            cleanup[name] = String(e.message);
            await sleep(50);
          }
        }
      }
      await report({
        type: 'kv-persist-read',
        token: v ? String.fromCharCode(...new Uint8Array(v)) : null,
        cleanup,
        kv: kvModule().diagnostics(),
      });
      return true;
    }
    case 'reload-arm':
    case 'destroy-arm': {
      // Work in flight across runtime destruction: cooperative, non-cooperative, and a
      // spread of completions racing the lifecycle hook. With `busyMs`, the JS thread is
      // held so that completions queue up undrained while React Native tears down.
      const counter = main.create(100);
      // Racing work uses an extra module with enough slots; invalidation tears it down too.
      const racer = createCounterModuleForTesting(32).create(0);
      retained.push(counter, racer);
      // ArrayBuffers backed by Rust storage, alive when the runtime is destroyed.
      retained.push(...Array.from({ length: 10 }, () => valuesModule().makeBytes(4096)));
      const pending: Promise<number>[] = [
        counter.addLater(1, 4000, false),
        counter.addLater(1, 1500, true),
      ];
      // Completion times spread over `spreadMs`, so some land while JS is busy, some while
      // React Native tears down, and some after invalidation.
      const racing = step.racing ?? 0;
      for (let i = 0; i < racing; i++)
        pending.push(
          racer.addLater(1, Math.floor((i / racing) * (step.spreadMs ?? 900)), i % 2 === 0),
        );
      pending.forEach((p) => p.catch(() => {}));
      await sleep(50);
      await report({ type: `${step.step}ed`, ...snapshot(main), generation: main.generation });
      if (step.busyMs) {
        // React Native's reload waits for this task; queued drains still run when it ends
        // (RuntimeScheduler drains its queue in the same Looper message). Completions that
        // land after that, but before invalidation, stay queued: cluster some around the
        // end of the busy period to probe that window.
        for (let i = 0; i < (step.cluster ?? 0); i++) {
          const p = racer.addLater(
            1,
            step.busyMs + (i - step.cluster / 2) * (step.clusterSpacingMs ?? 2),
            true,
          );
          p.catch(() => {});
        }
        const busyFrom = Date.now();
        void report({ type: 'go', busyFrom, busyMs: step.busyMs }).catch(() => {});
        console.log(`rnr: JS thread busy from ${busyFrom} for ${step.busyMs} ms`);
        busyWait(step.busyMs);
        console.log(`rnr: JS thread free at ${Date.now()}`);
      }
      return true;
    }
    case 'churn': {
      // Non-cooperative jobs left running across repeated reloads. The extra test-hook
      // module is deliberately not torn down: runtime invalidation must do it.
      const extra = createCounterModuleForTesting(8);
      const result = await startStubborn([main, extra], step.jobs, step.ms);
      await report({ type: 'churned', ...result, ...snapshot(main), generation: main.generation });
      return true;
    }
    case 'drain-check': {
      // Waits for every earlier generation's work to exit, then checks admission recovers.
      const deadline = Date.now() + step.timeoutMs;
      while (Date.now() < deadline && (main.stats().budgetRunning ?? 0) > 0) await sleep(100);
      const drained = snapshot(main);
      const counter = main.create(1);
      retained.push(counter);
      let value: number | string;
      try {
        value = await counter.addLater(1, 10, false);
      } catch (e: any) {
        value = `${e.code}: ${e.message}`;
      }
      global.__lab.collect();
      await sleep(0);
      await report({
        type: 'drained',
        ...drained,
        after: snapshot(main),
        value,
        violations: main.violations,
        generation: main.generation,
      });
      return true;
    }
    case 'refusal': {
      // Fix regression: an adapter created after its scope was invalidated is refused at
      // once, and its host is freed before installCounter throws (no destructor fallback).
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
        mainAfter = String(e);
      }
      await report({
        type: 'refused',
        error,
        before,
        after,
        mainAfter,
        lifecycle: runtimeBindings().lifecycle(),
      });
      return true;
    }
    case 'done':
      update('Device checks finished.');
      return false;
    default:
      throw new Error(`unknown step ${step.step}`);
  }
}

export async function runRnrPrototype(update: (message: string) => void) {
  global.__rnrMounts = (global.__rnrMounts ?? 0) + 1;
  // One loop per runtime; a remounted surface (new Activity) reuses it.
  if (global.__rnrLoop) {
    update(`Remounted (mount ${global.__rnrMounts}) in the same runtime`);
    return;
  }
  global.__rnrLoop = true;
  NativeBench.install();
  installAndroidBackend();
  const main = counterModule();
  await report({
    type: 'runtime',
    scopeId: runtimeBindings().scopeId,
    ...snapshot(main),
    generation: main.generation,
    env: { build: __DEV__ ? 'debug' : 'release', hermes: !!global.HermesInternal },
  });
  for (;;) {
    let step: Step;
    try {
      step = await nextStep({ scope: runtimeBindings().scopeId, mounts: global.__rnrMounts });
    } catch {
      await sleep(500); // collector not reachable yet
      continue;
    }
    try {
      if (!(await runStep(step, update))) return;
    } catch (error) {
      await report({
        type: 'error',
        step: step.step,
        error: String((error as Error)?.stack ?? error),
      }).catch(() => {});
    }
  }
}
