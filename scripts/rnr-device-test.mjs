// Runs the ownership prototype on a connected device and drives its lifecycle:
// conformance suite; background/foreground; Activity destruction without runtime
// destruction; RN reload with in-flight and queued work; repeated reloads with
// non-cooperative work; ReactHost.destroy() and recreation. The app's step loop
// (src/rnrAndroid.ts) asks this runner for each step.
// Usage (inside `nix develop`, release APK installed): node scripts/rnr-device-test.mjs [out.json]
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const PACKAGE = 'dev.rustjsilab';
const ACTIVITY = `${PACKAGE}/com.helloworld.MainActivity`;
const BUDGET = 32; // default executor budget in rust/rnr-core
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', timeout: 20000 }).trim();
const pid = () => {
  try {
    return adb('shell', 'pidof', PACKAGE);
  } catch {
    return '';
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const resumedActivity = () =>
  adb('shell', 'dumpsys', 'activity', 'activities')
    .split('\n')
    .find((line) => /mResumedActivity|topResumedActivity/.test(line))
    ?.trim() ?? '';
const t0 = Date.now();
const log = (message) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${message}`);

const records = [];
let waiters = [];
let served = null; // {step, scope, minMounts}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/next') {
    const scope = Number(url.searchParams.get('scope'));
    const mounts = Number(url.searchParams.get('mounts'));
    let step = { step: 'idle' };
    if (
      served &&
      (served.scope === undefined || served.scope === scope) &&
      mounts >= (served.minMounts ?? 0)
    ) {
      step = served.step;
      served = null;
    }
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(step));
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    const record = { ...JSON.parse(Buffer.concat(chunks).toString()), receivedAt: Date.now() };
    records.push(record);
    if (record.type === 'error') log(`app error in ${record.step}: ${record.error}`);
    res.writeHead(200).end('{}');
    waiters = waiters.filter((w) => !w());
  } catch (error) {
    res.writeHead(400).end(String(error));
  }
});
await new Promise((resolve) => server.listen(8766, '127.0.0.1', resolve));
// The @rnrs/example-http test server: requests in flight across runtime destruction.
const { startServer } = await import('./http-test-server.mjs');
const httpServer = await startServer(8787);
const httpConnection = async (tag) => {
  const res = await fetch(`http://127.0.0.1:${httpServer.address().port}/__log`);
  return (await res.json()).connections.find((c) =>
    c.requests.includes(`GET /drip/forever?t=${tag}`),
  );
};

/** Resolves with the first record of `type` received after index `from`. */
const next = (type, from, timeoutMs = 120_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
    const look = () => {
      const record = records.slice(from).find((r) => r.type === type);
      if (record) {
        clearTimeout(timer);
        resolve(record);
        return true;
      }
      return false;
    };
    if (!look()) waiters.push(look);
  });
/** Serves one step to the given runtime and waits for its report. */
async function run(step, scope, expectType, extra = {}) {
  const from = records.length;
  served = { step, scope, ...extra };
  return next(expectType, from);
}
async function newRuntime(from, previousScope) {
  const runtime = await next('runtime', from);
  if (runtime.scopeId === previousScope) throw new Error('expected a new runtime');
  return runtime;
}

const failures = [];
const expect = (condition, message) => {
  if (!condition) {
    failures.push(message);
    log(`FAIL ${message}`);
  }
};
const result = {};
try {
  adb('reverse', 'tcp:8766', 'tcp:8766');
  adb('reverse', 'tcp:8787', 'tcp:8787');
  adb('logcat', '-c');
  adb('shell', 'am', 'force-stop', PACKAGE);
  adb('shell', 'am', 'start', '-n', ACTIVITY, '--es', 'mode', 'rnr');
  const processId = await (async () => {
    await sleep(1000);
    return pid();
  })();
  let runtime = await next('runtime', 0);
  expect(runtime.env.build === 'release' && runtime.env.hermes, 'not a release Hermes build');
  result.device = {
    model: adb('shell', 'getprop', 'ro.product.model'),
    sdk: adb('shell', 'getprop', 'ro.build.version.sdk'),
  };

  // 1. Shared conformance suite.
  const conformance = await run({ step: 'conformance' }, runtime.scopeId, 'conformance');
  for (const c of conformance.checks)
    log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name} (${c.ms.toFixed(1)} ms) ${c.detail}`);
  expect(conformance.ok, 'conformance suite failed');
  result.conformance = conformance;

  // 1b. An HTTP response (@rnrs/example-http) streaming across an RN reload: the old runtime's
  //     request future is dropped by teardown, its buffer released, and the server sees the
  //     connection closed. Its own reload, so later steps' exact adapter counts are unaffected.
  {
    const from = records.length;
    served = { step: { step: 'http-arm' }, scope: runtime.scopeId };
    const armed = await next('http-armed', from);
    adb('shell', 'am', 'broadcast', '-a', 'dev.rustjsilab.RELOAD', '-p', PACKAGE);
    runtime = await newRuntime(from, runtime.scopeId);
    const checked = await run({ step: 'http-check' }, runtime.scopeId, 'http-checked');
    let connection;
    for (let i = 0; i < 50 && (!connection || connection.open); i++) {
      connection = await httpConnection('http-arm');
      await sleep(100);
    }
    const h0 = armed.http,
      h1 = checked.http;
    expect(
      h0.active >= 1 && h0.bufferedBytes > 0,
      'http reload: no request was streaming at the reload',
    );
    expect(
      h1.active === 0 && h1.bufferedBytes === 0,
      `http reload: requests still active after the reload: ${JSON.stringify(h1)}`,
    );
    expect(
      h1.droppedEarly - h0.droppedEarly >= 1,
      'http reload: the in-flight request future was not dropped',
    );
    expect(
      connection && !connection.open,
      'http reload: the server did not see the connection closed',
    );
    result.httpReload = { armed: h0, after: h1, connection };
    log(`http reload: ${JSON.stringify(result.httpReload)}`);
  }

  // 1c/1d. @rnrs/example-kv (sled) with writes in flight across an RN reload, then across
  //     ReactHost.destroy() and recreation: the next runtime reopens the database while the
  //     old handles are released off the JS thread, every write is whole or absent, and
  //     close waits for in-flight writes on its handle.
  for (const [kind, action] of [
    ['reload', 'dev.rustjsilab.RELOAD'],
    ['destroy', 'dev.rustjsilab.DESTROY'],
  ]) {
    const tag = `${kind}-${Date.now()}`; // keys unique to this run
    const from = records.length;
    const writes = 24; // within the module's 32 slots, so every write is admitted
    served = { step: { step: 'kv-arm', tag, writes }, scope: runtime.scopeId };
    const armed = await next('kv-armed', from);
    adb('shell', 'am', 'broadcast', '-a', action, '-p', PACKAGE);
    runtime = await newRuntime(from, runtime.scopeId);
    const checked = await run({ step: 'kv-check', tag, writes }, runtime.scopeId, 'kv-checked');
    expect(
      JSON.stringify(checked.marker) === '[1,2,3]',
      `kv ${kind}: flushed marker ${JSON.stringify(checked.marker)}`,
    );
    expect(checked.torn === 0, `kv ${kind}: ${checked.torn} partially written values`);
    expect(
      checked.closeOk + checked.closeRefused === 24 && checked.closeApplied === checked.closeOk,
      `kv ${kind}: close vs in-flight: ${checked.closeOk} ok, ${checked.closeRefused} refused, ${checked.closeApplied} applied`,
    );
    expect(
      checked.afterClose.startsWith('closed:'),
      `kv ${kind}: operation after close: ${checked.afterClose}`,
    );
    result[`kv_${kind}`] = { armed: armed.kv, checked };
    log(
      `kv ${kind}: ${JSON.stringify({ applied: checked.applied, of: writes, torn: checked.torn, closeOk: checked.closeOk, closeRefused: checked.closeRefused, kv: checked.kv })}`,
    );
  }

  // 2. Background/foreground: not a runtime teardown; completions still settle.
  {
    const from = records.length;
    served = { step: { step: 'background', ms: 4000 }, scope: runtime.scopeId };
    const armed = await next('bg-armed', from);
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    const backgroundedAt = Date.now();
    await sleep(1500);
    const whileBackground = resumedActivity();
    await sleep(5000);
    adb('shell', 'am', 'start', '-n', ACTIVITY);
    const foregroundedAt = Date.now();
    const settled = await next('bg-result', from);
    await sleep(500);
    const after = await run({ step: 'snapshot', tag: 'bg-check' }, runtime.scopeId, 'bg-check');
    log(
      `background: ${settled.outcome} after ${settled.elapsedMs} ms; settled ${settled.receivedAt < foregroundedAt ? 'while backgrounded' : 'after foreground'}; resumed while away: ${whileBackground}`,
    );
    expect(!whileBackground.includes(PACKAGE), 'app still resumed after HOME');
    expect(
      settled.outcome === 'resolved 1',
      `operation across background did not resolve: ${settled.outcome}`,
    );
    expect(
      after.generation === armed.generation && after.stats.open === 1,
      'runtime module changed across background',
    );
    expect(
      after.lifecycle.scopesInvalidated === armed.lifecycle.scopesInvalidated,
      'background invalidated the runtime scope',
    );
    expect(after.stats.hostsTornDown === armed.stats.hostsTornDown, 'background tore down a host');
    result.background = {
      armed,
      settled,
      after,
      backgroundedAt,
      foregroundedAt,
      whileBackground,
      settledWhileBackgrounded: settled.receivedAt < foregroundedAt,
    };
  }

  // 3. Activity destruction (back) with the React instance kept, then a new Activity.
  {
    const before = await run(
      { step: 'snapshot', tag: 'activity-before' },
      runtime.scopeId,
      'activity-before',
    );
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await sleep(2500);
    const activities = adb('shell', 'dumpsys', 'activity', 'activities');
    const activityGone = !activities.includes('com.helloworld.MainActivity');
    const samePid = pid() === processId;
    adb('shell', 'am', 'start', '-n', ACTIVITY, '--es', 'mode', 'rnr');
    const after = await run(
      { step: 'snapshot', tag: 'activity-after' },
      runtime.scopeId,
      'activity-after',
      { minMounts: before.mounts + 1 },
    );
    log(
      `activity destroyed: ${activityGone}; mounts ${before.mounts} -> ${after.mounts}; scope ${runtime.scopeId}`,
    );
    expect(activityGone, 'Activity was not destroyed by back');
    expect(samePid && pid() === processId, 'process changed during Activity destruction');
    expect(
      after.generation === before.generation && after.stats.open === 1,
      'runtime module changed across Activity destruction',
    );
    expect(
      after.lifecycle.scopesInvalidated === before.lifecycle.scopesInvalidated,
      'Activity destruction invalidated the runtime scope',
    );
    expect(
      after.stats.hostsTornDown === before.stats.hostsTornDown,
      'Activity destruction tore down a host',
    );
    result.activityDestruction = { before, after, activityGone };
  }

  // Checks that hold after any runtime destruction (reload or ReactHost.destroy).
  const checkDestroyed = (label, armed, drained, liveHostsAtArm) => {
    const before = armed.lifecycle,
      after = drained.lifecycle;
    const invalidated = after.scopesInvalidated - before.scopesInvalidated;
    expect(invalidated === 1, `${label}: ${invalidated} runtime scopes invalidated`);
    expect(
      after.invalidateOnJsThread === before.invalidateOnJsThread,
      `${label}: invalidate ran on the JS thread`,
    );
    expect(
      after.invalidateJsThreadAlive === before.invalidateJsThreadAlive,
      `${label}: JS thread still alive at invalidate`,
    );
    const alive = after.adaptersAliveAtInvalidate - before.adaptersAliveAtInvalidate;
    const tornDown = after.adaptersTornDownAtInvalidate - before.adaptersTornDownAtInvalidate;
    expect(
      tornDown === liveHostsAtArm,
      `${label}: invalidate tore down ${tornDown} adapters, expected the ${liveHostsAtArm} open ones`,
    );
    const destroyedAfter =
      after.adaptersDestroyedAfterInvalidate - before.adaptersDestroyedAfterInvalidate;
    expect(
      destroyedAfter >= alive,
      `${label}: only ${destroyedAfter} adapters destroyed after invalidate`,
    );
    const s0 = armed.stats,
      s1 = drained.stats;
    expect(
      s1.tornDownLifecycle - s0.tornDownLifecycle === liveHostsAtArm,
      `${label}: lifecycle teardowns ${s1.tornDownLifecycle - s0.tornDownLifecycle}`,
    );
    expect(
      s1.tornDownDestructor === s0.tornDownDestructor,
      `${label}: fallback destructor teardown was needed`,
    );
    expect(
      s1.budgetRunning === 0 && s1.budgetOrphaned === 0,
      `${label}: work still running: ${s1.budgetRunning}/${s1.budgetOrphaned}`,
    );
    expect(drained.value === 2, `${label}: new generation result ${drained.value}`);
    expect(
      drained.violations.length === 0,
      `${label}: settlement violations ${drained.violations}`,
    );
    const a = drained.after.stats;
    expect(
      a.native.Counter.created - a.native.Counter.dropped === 1,
      `${label}: ${a.native.Counter.created - a.native.Counter.dropped} counters live, expected 1`,
    );
    expect(
      a.hostsCreated - a.hostsFreed === 1,
      `${label}: ${a.hostsCreated - a.hostsFreed} adapters live, expected 1`,
    );
    // ArrayBuffers owning Rust storage do not outlive the runtime that held them.
    expect(
      a.bytesAdopted === a.bytesReleased,
      `${label}: ${a.bytesAdopted - a.bytesReleased} adopted ArrayBuffers never released`,
    );
    expect(pid() === processId, `${label}: process changed`);
    const drains = {
      posted: after.drainsPosted - before.drainsPosted,
      run: after.drainsRun - before.drainsRun,
      skipped: after.drainsSkipped - before.drainsSkipped,
    };
    const lingering = after.invalidateJsTaskLingering - before.invalidateJsTaskLingering;
    return {
      invalidated,
      jsTaskLingering: lingering,
      tornDownAtInvalidate: tornDown,
      aliveAtInvalidate: alive,
      destroyedAfter,
      drains,
      invalidateThread: after.lastInvalidateThread,
      jsThread: after.jsThreadName,
      discardedQueued: s1.teardownDiscardedQueued - s0.teardownDiscardedQueued,
      cancelled: s1.teardownCancelled - s0.teardownCancelled,
      stillRunning: s1.teardownStillRunning - s0.teardownStillRunning,
    };
  };
  const liveHosts = (record) => record.stats.hostsCreated - record.stats.hostsTornDown;

  // 4. RN reload with cooperative, non-cooperative and racing work; JS held busy so that
  //    completions queue undrained while React Native tears the runtime down.
  {
    const from = records.length;
    served = {
      step: {
        step: 'reload-arm',
        racing: 6,
        spreadMs: 4000,
        busyMs: 2500,
        cluster: 24,
        clusterSpacingMs: 2,
      },
      scope: runtime.scopeId,
    };
    const armed = await next('reload-armed', from);
    const go = await next('go', from);
    adb('shell', 'am', 'broadcast', '-a', 'dev.rustjsilab.RELOAD', '-p', PACKAGE);
    const previous = runtime.scopeId;
    runtime = await newRuntime(from, previous);
    const drained = await run({ step: 'drain-check', timeoutMs: 8000 }, runtime.scopeId, 'drained');
    const summary = checkDestroyed('reload', armed, drained, liveHosts(armed));
    // Device clock: when the JS thread was busy, and when the lifecycle hook ran.
    summary.invalidateAfterBusyStartMs = drained.lifecycle.lastInvalidateAtMs - go.busyFrom;
    summary.busyMs = go.busyMs;
    const s0 = armed.stats,
      s1 = drained.after.stats;
    summary.bytes = {
      liveAtReload: s0.bytesAdopted - s0.bytesReleased,
      releasedOffJsThread: s1.bytesFinalizedOffJsThread - s0.bytesFinalizedOffJsThread,
    };
    expect(
      summary.bytes.liveAtReload >= 10 &&
        summary.bytes.releasedOffJsThread >= summary.bytes.liveAtReload,
      `reload: adopted buffers alive at reload ${summary.bytes.liveAtReload}, released off the JS thread ${summary.bytes.releasedOffJsThread}`,
    );
    // Observed, not required: whether completions were still queued at invalidation (their
    // drain task discarded by the quit JS queue). Safety holds either way.
    summary.queuedAtInvalidate = summary.discardedQueued > 0;
    summary.drainsNeverRun = summary.drains.posted - summary.drains.run - summary.drains.skipped;
    result.reload = { armed, go, drained, summary };
    log(`reload: ${JSON.stringify(result.reload.summary)}`);
  }

  // 5. Repeated reloads, each leaving non-cooperative jobs running. The process-wide
  //    executor budget bounds them; later generations get an actionable overload.
  {
    const cycles = [];
    let armedFirst;
    for (let k = 0; k < 4; k++) {
      const from = records.length;
      const churned = await run({ step: 'churn', jobs: 12, ms: 15000 }, runtime.scopeId, 'churned');
      armedFirst ??= churned;
      cycles.push({
        admitted: churned.admitted,
        saturated: churned.saturated,
        moduleOverloaded: churned.moduleOverloaded,
        other: churned.other,
        running: churned.stats.budgetRunning,
        orphaned: churned.stats.budgetOrphaned,
        message: churned.message,
      });
      log(`churn ${k + 1}: ${JSON.stringify(cycles.at(-1))}`);
      expect(
        churned.stats.budgetRunning <= BUDGET,
        `churn ${k + 1}: ${churned.stats.budgetRunning} running`,
      );
      expect(churned.other.length === 0, `churn ${k + 1}: unexpected outcomes ${churned.other}`);
      adb('shell', 'am', 'broadcast', '-a', 'dev.rustjsilab.RELOAD', '-p', PACKAGE);
      runtime = await newRuntime(from, runtime.scopeId);
    }
    const drained = await run(
      { step: 'drain-check', timeoutMs: 30000 },
      runtime.scopeId,
      'drained',
    );
    const admitted = cycles.reduce((n, c) => n + c.admitted, 0);
    const saturated = cycles.reduce((n, c) => n + c.saturated, 0);
    expect(
      admitted === BUDGET,
      `admitted ${admitted} across reloads, expected exactly the budget ${BUDGET}`,
    );
    expect(saturated === 48 - BUDGET, `saturated ${saturated}`);
    expect(drained.stats.budgetPeak <= BUDGET, `peak ${drained.stats.budgetPeak} over budget`);
    // The Rust refusal snapshot: every refusal happened with the budget full.
    const refusals = cycles.filter((c) => c.saturated > 0);
    expect(
      refusals.length > 0 &&
        refusals.every((c) =>
          new RegExp(
            `^executor budget exhausted: ${BUDGET}/${BUDGET} operations running, \\d+ of them from closed runtimes; retry after they exit$`,
          ).test(c.message),
        ),
      `saturation messages: ${refusals.map((c) => c.message)}`,
    );
    const s = drained.stats;
    expect(
      s.budgetRunning === 0 && s.budgetOrphaned === 0,
      `work left after drain: ${s.budgetRunning}`,
    );
    expect(drained.value === 2, `post-churn admission ${drained.value}`);
    const a = drained.after.stats;
    expect(
      a.native.Counter.created - a.native.Counter.dropped === 1,
      `churn: ${a.native.Counter.created - a.native.Counter.dropped} counters live`,
    );
    expect(
      a.hostsCreated - a.hostsFreed === 1,
      `churn: ${a.hostsCreated - a.hostsFreed} adapters live`,
    );
    expect(
      s.tornDownDestructor === armedFirst.stats.tornDownDestructor,
      'churn: fallback destructor teardown was needed',
    );
    const l0 = armedFirst.lifecycle,
      l1 = drained.lifecycle;
    expect(
      l1.scopesInvalidated - l0.scopesInvalidated === 4,
      'churn: not every reload invalidated its scope',
    );
    expect(
      l1.invalidateOnJsThread === l0.invalidateOnJsThread &&
        l1.invalidateJsThreadAlive === l0.invalidateJsThreadAlive,
      'churn: an invalidation ran on, or while, the JS thread was alive',
    );
    expect(
      s.tornDownLifecycle - armedFirst.stats.tornDownLifecycle === 8,
      `churn: ${s.tornDownLifecycle - armedFirst.stats.tornDownLifecycle} lifecycle teardowns, expected 2 per reload`,
    );
    result.repeatedReloads = { cycles, drained, admitted, saturated, peak: s.budgetPeak };
  }

  // 6. ReactHost.destroy(), then Activity.recreate() starts a new React instance.
  {
    const from = records.length;
    const armed = await run({ step: 'destroy-arm', racing: 10 }, runtime.scopeId, 'destroy-armed');
    adb('shell', 'am', 'broadcast', '-a', 'dev.rustjsilab.DESTROY', '-p', PACKAGE);
    runtime = await newRuntime(from, runtime.scopeId);
    const drained = await run({ step: 'drain-check', timeoutMs: 8000 }, runtime.scopeId, 'drained');
    result.destroy = {
      armed,
      drained,
      summary: checkDestroyed('destroy', armed, drained, liveHosts(armed)),
    };
    log(`destroy: ${JSON.stringify(result.destroy.summary)}`);
  }

  // 7. Registration refused after invalidation (test hook), in the final runtime.
  {
    const refused = await run({ step: 'refusal' }, runtime.scopeId, 'refused');
    const b = refused.before,
      a = refused.after;
    log(`refusal: ${refused.error}; main module ${refused.mainAfter}`);
    expect(
      /runtime is being torn down/.test(refused.error),
      `installCounter after invalidation: ${refused.error}`,
    );
    expect(
      a.hostsCreated === b.hostsCreated + 1 && a.hostsFreed === b.hostsFreed + 1,
      'refused adapter was not freed immediately',
    );
    expect(
      a.tornDownRefused === b.tornDownRefused + 1 && a.tornDownDestructor === b.tornDownDestructor,
      'refused adapter not torn down as refused',
    );
    expect(
      a.tornDownLifecycle === b.tornDownLifecycle + 1 && /closed/.test(refused.mainAfter),
      'invalidation did not tear down the open module',
    );
    result.refusal = refused;
  }

  // 8. Scope ownership stress, independent of React Native's ordering.
  {
    adb('shell', 'am', 'broadcast', '-a', 'dev.rustjsilab.SCOPE_STRESS', '-p', PACKAGE);
    let line = '';
    for (let i = 0; i < 60 && !line; i++) {
      await sleep(500);
      line =
        adb('logcat', '-d', '-s', 'rnr:*')
          .split('\n')
          .find((l) => l.includes('rnr scope stress:')) ?? '';
    }
    const stress = line ? JSON.parse(line.slice(line.indexOf('{'))) : null;
    log(`scope stress: ${JSON.stringify(stress)}`);
    expect(
      stress && stress.installers + stress.refused === stress.rounds,
      'scope stress did not finish',
    );
    expect(
      stress && stress.created === stress.expected && stress.freed >= stress.expected,
      'native scopes leaked',
    );
    expect(pid() === processId, 'scope stress crashed the process');
    result.scopeStress = stress;
  }

  // 9. kv persistence across a process restart: a flushed write survives force-stop; the
  //    runner then deletes the lab's own test databases (no other app data is touched).
  {
    // A fresh runtime first: the refusal step invalidated the current one on purpose.
    let from = records.length;
    adb('shell', 'am', 'broadcast', '-a', 'dev.rustjsilab.RELOAD', '-p', PACKAGE);
    runtime = await newRuntime(from, runtime.scopeId);
    const token = `t${Date.now()}`;
    const written = await run(
      { step: 'kv-persist-write', token },
      runtime.scopeId,
      'kv-persist-written',
    );
    from = records.length;
    adb('shell', 'am', 'force-stop', PACKAGE);
    adb('shell', 'am', 'start', '-n', ACTIVITY, '--es', 'mode', 'rnr');
    runtime = await next('runtime', from);
    const read = await run({ step: 'kv-persist-read' }, runtime.scopeId, 'kv-persist-read');
    expect(read.token === token, `kv restart: read ${read.token}, wrote ${token}`);
    expect(
      read.cleanup['rnr-lab-persist'] === true &&
        typeof read.cleanup['rnr-lab-lifecycle'] === 'boolean',
      `kv restart: cleanup ${JSON.stringify(read.cleanup)}`,
    );
    result.kvRestart = { flushed: written.flushed, token, read };
    log(
      `kv restart: ${JSON.stringify({ token: read.token === token, cleanup: read.cleanup, kv: read.kv })}`,
    );
  }

  served = { step: { step: 'done' }, scope: runtime.scopeId };
  await sleep(1000);
  const crashes = adb('logcat', '-d', '-b', 'crash');
  expect(!crashes.includes(PACKAGE), 'crash buffer mentions the app');
  result.rnrLog = adb('logcat', '-d', '-s', 'rnr:*', 'ReactNativeJS:*');
  // React Native drops runnables posted to a JS queue thread that has quit.
  result.droppedRunnableWarnings = adb('logcat', '-d')
    .split('\n')
    .filter((l) => /already finished thread/.test(l));
  result.processId = processId;
  result.errors = records.filter((r) => r.type === 'error');
  expect(result.errors.length === 0, `app reported ${result.errors.length} step errors`);
} catch (error) {
  failures.push(String(error?.stack ?? error));
  // Keep the evidence of a failed run (the success path records these above).
  for (const [key, args] of [
    ['rnrLog', ['logcat', '-d', '-s', 'rnr:*', 'ReactNativeJS:*', 'AndroidRuntime:*']],
    ['crashLog', ['logcat', '-d', '-b', 'crash']],
    // The app reports through these ports; a run that lost them cannot deliver records.
    ['adbReverse', ['reverse', '--list']],
    ['adbState', ['get-state']],
  ]) {
    try {
      result[key] ??= adb(...args);
    } catch (e) {
      result[key] = `unavailable: ${e}`;
    }
  }
  result.records = records;
} finally {
  server.close();
  httpServer.closeAllConnections();
  httpServer.close();
  for (const port of ['tcp:8766', 'tcp:8787']) {
    try {
      adb('reverse', '--remove', port);
    } catch {
      /* best effort */
    }
  }
}
result.failures = failures;
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2));
console.log(
  failures.length
    ? `FAILED:\n  ${failures.join('\n  ')}`
    : 'OK: conformance and lifecycle checks passed',
);
process.exit(failures.length ? 1 : 0);
