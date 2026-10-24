// Worklets lab checks, in stages. Test-hooks build only
// (RNRS_TEST_HOOKS=1); uses lab diagnostics from @rnrs/runtime/testing.
import * as Worklets from 'react-native-worklets';
import {
  createWorkletRuntime,
  runOnRuntimeSync,
  runOnUISync,
  scheduleOnUI,
} from 'react-native-worklets';
import { makeMutable } from 'react-native-reanimated';
import { enableWorklets, isRnrsClosedError, workletEndpoint } from '@rnrs/runtime/worklets';
import type { GestureLabProps, GestureStats } from './GestureLab';

// The app's GestureLab mount (W6): the smoke supplies its props when the stage starts.
let mountGestureLab: ((props: GestureLabProps | null) => void) | undefined;
export function onGestureLab(mount: (props: GestureLabProps | null) => void): () => void {
  mountGestureLab = mount;
  return () => {
    mountGestureLab = undefined;
  };
}
import { runtimeBindings } from '@rnrs/runtime/testing';
import { conversionHelpers } from '@rnrs/runtime';
import { WorkletsProbeModule, workletsProbeModule } from '@rnrs/labs-worklets-probe';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export interface WorkletsResult {
  ok: boolean;
  stage: string;
  /** 1 for the first runtime of the process, then one more per reload. */
  iteration?: number;
  /** The app reloads React Native after reporting (W5). */
  reload?: boolean;
  final?: boolean;
  checks: Check[];
  records?: unknown;
}

interface RouteRecord {
  seq: number;
  callRuntime: string;
  installRuntime: string;
  sameAddress: boolean;
  callIdentity: number;
  installIdentity: number;
  acceptedByInstallBinding: boolean;
  thread: number;
  threadName: string;
  onInstallJsThread: boolean;
  argCount: number;
  argIsNumber: boolean;
}

/** W5: reloads after the first runtime; each keeps UI-runtime endpoint calls in flight. */
const RELOADS = 5;

export async function runWorkletsSmoke(): Promise<WorkletsResult> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: unknown = '') =>
    checks.push({ name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  const bindings = runtimeBindings() as any;
  const iteration = bindings.lifecycle().bindingsInstalled as number;
  if (iteration > 1) return reloadIteration(iteration, checks, check, bindings);
  check('test-hooks build', bindings.testHooks === true);
  check('probe module on the RN runtime', workletsProbeModule().scale(1.5, 4) === 6);

  // W1: routing. One call on the RN runtime (baseline), then exactly one call with one scalar
  // from one runOnUISync worklet. The probe converts nothing and touches no adapter.
  const probe = bindings.routeProbeForTesting as (x: number) => number;
  probe(0);
  runOnUISync(() => {
    'worklet';
    probe(1);
  });
  const records = bindings.routeRecordsForTesting() as RouteRecord[];
  const [rn, ui] = records;
  check('W1: two probe calls recorded', records.length === 2, records.length);
  check(
    'W1: RN call: same runtime address, own identity, install binding accepts',
    !!rn && rn.sameAddress && rn.callIdentity === rn.installIdentity && rn.acceptedByInstallBinding,
    rn,
  );
  check(
    'W1: UI call arrives in another runtime (address differs, no rnrs identity), binding refuses',
    !!ui && !ui.sameAddress && ui.callIdentity === 0 && !ui.acceptedByInstallBinding,
    ui,
  );
  check('W1: UI call carried one number', !!ui && ui.argCount === 1 && ui.argIsNumber, ui);
  // Observation, not a pass condition: which thread runOnUISync ran the worklet on.
  const thread = ui
    ? ui.onInstallJsThread
      ? 'RN JS thread (inline, under the UI runtime lock)'
      : `other thread ${ui.threadName}`
    : 'none';
  const observations: Record<string, unknown> = { routes: records, uiCallThread: thread };
  let stage = 'W1';

  // W2: the existing adapter refuses foreign runtimes. Only on builds that have the guard: an
  // unguarded adapter must never be called from a worklet runtime.
  if (bindings.runtimeGuard !== true) {
    check(
      'W2: native runtime guard present (__rnrsRuntime.runtimeGuard)',
      false,
      'older native library',
    );
  } else {
    stage = 'W2';
    const { name, hash } = WorkletsProbeModule.descriptor;
    const raw = bindings.install(name, hash, 4);
    const helpers = conversionHelpers;
    const { callh, call, cancel, dispose, teardown, stats } = raw;
    const callp = (...args: unknown[]) => Reflect.apply(callh, helpers, args);
    // Method 0 is a scalar method: its prepared entry is a host function of its own.
    const direct = raw.entry(0);
    check('W2: prepared scalar entry from the RN runtime', direct(2, 3) === 6);
    const install = bindings.install;
    check('W2: RN runtime call through a test adapter', callp(0, undefined, 2, 3) === 6);
    const handle = callp(6, undefined, 1);
    const foreign = runOnUISync(() => {
      'worklet';
      const attempts: [string, () => unknown][] = [
        ['callh', () => callh.call(helpers, 0, undefined, 2, 3)],
        ['entry', () => direct(2, 3)],
        ['call', () => call(helpers, 0, undefined, [2, 3])],
        ['cancel', () => cancel(1)],
        ['dispose', () => dispose(handle)],
        ['teardown', () => teardown()],
        ['stats', () => stats(helpers)],
        ['install', () => install(name, hash, 4)],
      ];
      return attempts.map(([what, f]) => {
        try {
          return { what, threw: false, code: '', message: String(f()) };
        } catch (e) {
          return {
            what,
            threw: true,
            code: String((e as any)?.code),
            message: String((e as any)?.message),
          };
        }
      });
    });
    observations.foreignCalls = foreign;
    for (const r of foreign)
      check(
        `W2: ${r.what} from the UI runtime throws ERR_RNRS_FOREIGN_RUNTIME`,
        r.threw && r.code === 'ERR_RNRS_FOREIGN_RUNTIME',
        r,
      );
    // The adapter is untouched: same results, still open, the handle not disposed.
    check(
      'W2: RN runtime calls still work after the refused calls',
      callp(0, undefined, 4, 5) === 20 && callp(11, handle, 2) === 3,
    );
    check('W2: adapter still open', stats(helpers).open === 1, stats(helpers));
    teardown();
  }
  if (bindings.runtimeGuard === true) {
    stage = 'W3';
    await endpointStages(check, observations, bindings);
    stage = 'W5a';
  }
  const reload = typeof bindings.reloadForTesting === 'function';
  check('W5: reload test hook present', reload);
  return { ok: checks.every((c) => c.ok), stage, iteration, reload, checks, records: observations };
}

// W5: one runtime of the reload series. Sets up an endpoint and boxes in the UI and a custom
// runtime, keeps UI-runtime calls running every frame, and reloads with them in flight. The
// UI runtime is recreated by the reload; boxes of old runtimes must each be released once.
async function reloadIteration(
  iteration: number,
  checks: Check[],
  check: CheckFn,
  bindings: any,
): Promise<WorkletsResult> {
  const before = bindings.lifecycle();
  const final = iteration > RELOADS;
  const observations: Record<string, unknown> = { lifecycleAtStart: before };
  if (final) {
    // Every box made by earlier runtimes belongs to a destroyed UI or custom runtime now.
    check(
      'W5: boxes of earlier runtimes were each released exactly once',
      before.workletBoxesReleased === before.workletBoxesCreated,
      {
        created: before.workletBoxesCreated,
        released: before.workletBoxesReleased,
        offCreatorThread: before.workletBoxesReleasedOffCreator,
      },
    );
    // Every earlier runtime's scope (the first one by W5a's invalidation; its reload is then
    // idempotent) was invalidated.
    check(
      `W5: all ${iteration - 1} earlier runtime scopes were invalidated`,
      before.scopesInvalidated === iteration - 1,
      before.scopesInvalidated,
    );
    observations.refusedClosedTotal = before.workletRefusedClosed;
    return {
      ok: checks.every((c) => c.ok),
      stage: 'W5',
      iteration,
      final: true,
      checks,
      records: observations,
    };
  }
  const probe = workletsProbeModule();
  const ep = workletEndpoint(probe, ['scale', 'Accumulator.add']) as any;
  enableWorklets(Worklets);
  const acc = probe.createAccumulator(0);
  const custom = createWorkletRuntime({ name: `rnrs-lab-${iteration}` });
  runOnRuntimeSync(custom, () => {
    'worklet';
    (globalThis as any).__labAcc = acc;
  });
  runOnUISync(() => {
    'worklet';
    const g = globalThis as any;
    g.__labAcc = acc;
    g.__labCalls = 0;
    g.__labClosed = 0;
    g.__labUnexpected = [];
    const frame = () => {
      for (let i = 0; i < 50; i++) {
        try {
          ep.scale(i, 2);
          g.__labAcc.add(1);
          g.__labCalls++;
        } catch (error) {
          // Contained: ERR_RNRS_CLOSED is expected once the scope is torn down; anything else
          // is recorded as a failure (never rethrown into Reanimated's fatal path).
          if (isRnrsClosedError(error)) g.__labClosed++;
          else if (g.__labUnexpected.length < 5)
            g.__labUnexpected.push(
              String((error as any)?.code) + ': ' + String((error as any)?.message ?? error),
            );
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await sleep(300);
  const inFlight = runOnUISync(() => {
    'worklet';
    const g = globalThis as any;
    return { calls: g.__labCalls, closed: g.__labClosed, unexpected: g.__labUnexpected.slice() };
  });
  observations.uiCallsBeforeReload = inFlight;
  check(
    'W5: UI-runtime calls running before the reload, no closed or unexpected errors',
    inFlight.calls > 0 && inFlight.closed === 0 && inFlight.unexpected.length === 0,
    inFlight,
  );
  check('W5: the RN wrapper sees the UI calls', acc.value() >= inFlight.calls);
  return {
    ok: checks.every((c) => c.ok),
    stage: 'W5',
    iteration,
    reload: true,
    checks,
    records: observations,
  };
}

type CheckFn = (name: string, ok: boolean, detail?: unknown) => void;
// Installed on every worklet runtime by react-native-worklets (not in the RN type lib).
declare const performance: { now(): number };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `f` and reports {ok, value} or {ok: false, code, message} (any runtime). */
function attempt(f: () => unknown): {
  ok: boolean;
  value?: unknown;
  code?: string;
  name?: string;
  message?: string;
} {
  'worklet';
  try {
    return { ok: true, value: f() };
  } catch (e) {
    return {
      ok: false,
      code: String((e as any)?.code),
      name: String((e as any)?.name),
      message: String((e as any)?.message),
    };
  }
}

async function endpointStages(
  check: CheckFn,
  observations: Record<string, unknown>,
  bindings: any,
) {
  const probe = workletsProbeModule();
  // W3: endpoint creation (RN runtime). Async methods are refused when listed.
  const asyncAttempt = attempt(() => workletEndpoint(probe, ['scaleLater']));
  check(
    'W3: listing an async method is refused (ERR_RNRS_WORKLET_ASYNC)',
    !asyncAttempt.ok && asyncAttempt.code === 'ERR_RNRS_WORKLET_ASYNC',
    asyncAttempt,
  );
  const unknown = attempt(() => workletEndpoint(probe, ['nope']));
  check(
    'W3: listing an unknown method is refused',
    !unknown.ok && unknown.code === 'ERR_RNRS_WORKLET_SHAPE',
    unknown,
  );
  const ep = workletEndpoint(probe, [
    'scale',
    'isPositive',
    'setPointer',
    'pointerX',
    'pointerWrites',
    'describe',
    'point',
    'pair',
    'createAccumulator',
    'Accumulator.add',
    'Accumulator.value',
    'Accumulator.calls',
  ]) as any;
  enableWorklets(Worklets);
  const epId = ep.$id;
  check(
    'W3: RN runtime call through the endpoint',
    ep.scale(2, 3) === 6 && ep.isPositive(1) === true && ep.setPointer(1, 2) === undefined,
  );

  // The same refusal checks in every runtime kind: shapes are refused, scalars pass.
  const exercise = () => {
    'worklet';
    return {
      id: ep.$id,
      scale: attempt(() => ep.scale(2.5, 4)),
      isPositive: attempt(() => ep.isPositive(-1)),
      stringArg: attempt(() => ep.scale('2', 4)),
      stringResult: attempt(() => ep.describe(1)),
      recordResult: attempt(() => ep.point(1, 2)),
      arrayResult: attempt(() => ep.pair(1, 2)),
      nativeResult: attempt(() => ep.createAccumulator(1)),
      tooManyArgs: attempt(() => ep.scale(1, 2, 3, 4, 5)),
      missing: typeof ep.scaleLater,
    };
  };
  const custom = createWorkletRuntime({ name: 'rnrs-lab' });
  const results = {
    rn: exercise(),
    ui: runOnUISync(exercise),
    custom: runOnRuntimeSync(custom, exercise),
  };
  observations.endpointCalls = results;
  for (const [where, r] of Object.entries(results)) {
    check(
      `W3 ${where}: scalar calls`,
      r.scale.ok && r.scale.value === 10 && r.isPositive.ok && r.isPositive.value === false,
      [r.scale, r.isPositive],
    );
    check(
      `W3 ${where}: string argument refused by Rust conversion (TypeError)`,
      !r.stringArg.ok && r.stringArg.name === 'TypeError',
      r.stringArg,
    );
    const shapes = [r.stringResult, r.recordResult, r.arrayResult, r.nativeResult, r.tooManyArgs];
    check(
      `W3 ${where}: string/record/array/native results and >4 args refused (ERR_RNRS_WORKLET_SHAPE)`,
      shapes.every((s) => !s.ok && s.code === 'ERR_RNRS_WORKLET_SHAPE'),
      shapes,
    );
    check(`W3 ${where}: unlisted method absent`, r.missing === 'undefined', r.missing);
  }
  check(
    'W3: one endpoint HostObject shared by reference (same native id in RN, UI and custom runtimes)',
    results.rn.id === epId && results.ui.id === epId && results.custom.id === epId,
    [epId, results.ui.id, results.custom.id],
  );

  // W3: boxed handle. A wrapper captured by a worklet crosses as a box owning its own
  // reference; the UI and custom runtimes keep it in a global across calls.
  const acc = probe.createAccumulator(10);
  const keep = (where: string) => () => {
    'worklet';
    (globalThis as any).__labAcc = acc;
    const box = acc as any;
    return {
      where,
      id: box.$id,
      spec: box.$spec,
      add: attempt(() => box.add(1)),
      dispose: typeof box.dispose,
    };
  };
  const boxUi = runOnUISync(keep('ui'));
  const boxCustom = runOnRuntimeSync(custom, keep('custom'));
  observations.boxes = [boxUi, boxCustom];
  check(
    'W3: boxed handle called from UI and custom runtimes',
    boxUi.add.value === 11 && boxCustom.add.value === 12,
    [boxUi.add, boxCustom.add],
  );
  check(
    'W3: boxes expose only allow-listed methods',
    boxUi.spec === 'Accumulator' && boxUi.dispose === 'undefined',
    boxUi,
  );
  check('W3: the RN wrapper sees the same object', acc.value() === 12 && acc.calls() === 2);
  // Observation: worklets does not cache custom serializables (cloneCustom), so each capture
  // packs a new box; every box owns the same object (checked above through the values).
  observations.boxPerCapture = boxUi.id !== boxCustom.id;
  // R5: disposing the RN wrapper (and collecting garbage) leaves the boxes working.
  acc.dispose();
  bindings.collectGarbageForTesting();
  const afterDispose = runOnUISync(() => {
    'worklet';
    return attempt(() => (globalThis as any).__labAcc.add(100));
  });
  const afterDisposeCustom = runOnRuntimeSync(custom, () => {
    'worklet';
    return attempt(() => (globalThis as any).__labAcc.value());
  });
  check(
    'W3: boxes keep the object alive after the RN wrapper is disposed',
    afterDispose.ok && afterDispose.value === 112 && afterDisposeCustom.value === 112,
    [afterDispose, afterDisposeCustom],
  );

  // W4: concurrent RN- and UI-runtime calls on one object (Mutex<f64> plus atomic counter).
  // Both sides run for a fixed time: the UI thread adds for 1.5 s; the RN thread yields one
  // microtask (worklets flushes scheduleOnUI work in one), waits without yielding for the
  // UI's first add, then adds for 1 s, sampling the UI's progress after every 1,000 adds.
  const shared = probe.createAccumulator(0);
  runOnUISync(() => {
    'worklet';
    (globalThis as any).__labShared = shared;
    (globalThis as any).__labUiAdds = -1;
  });
  scheduleOnUI(() => {
    'worklet';
    const g = globalThis as any;
    const box = g.__labShared;
    const until = performance.now() + 1500;
    let n = 0;
    while (performance.now() < until) {
      box.add(1);
      n++;
    }
    g.__labUiAdds = n;
  });
  // A microtask, not a timer: worklets flushes scheduleOnUI work in a microtask, and RN
  // Android timers run on the busy UI thread's Choreographer.
  await Promise.resolve();
  const waitStarted = Date.now();
  while (shared.calls() === 0 && Date.now() - waitStarted < 3000) {
    /* the UI job is starting */
  }
  const uiStartWaitMs = Date.now() - waitStarted;
  let rnAdds = 0;
  const samples: number[] = [];
  const started = Date.now();
  while (Date.now() - started < 1000) {
    for (let i = 0; i < 1000; i++) shared.add(1);
    rnAdds += 1000;
    samples.push(shared.calls() - rnAdds);
  }
  const rnLoopMs = Date.now() - started;
  // runOnUISync waits for the UI runtime, so it returns after the UI loop.
  const uiAdds = runOnUISync(() => {
    'worklet';
    return (globalThis as any).__labUiAdds as number;
  });
  // Interleaved: the UI's count grew between two RN samples while both loops ran.
  const interleaved = samples.some((s, i) => i > 0 && s > samples[i - 1] && samples[i - 1] > 0);
  observations.concurrency = {
    uiAdds,
    uiStartWaitMs,
    rnAdds,
    rnLoopMs,
    samples: samples.length,
    firstSample: samples[0],
    lastSample: samples.at(-1),
    interleaved,
  };
  check(
    'W4: RN and UI threads called the same object at the same time (UI progress observed during the RN loop)',
    interleaved,
    observations.concurrency,
  );
  check(
    'W4: every concurrent add was applied exactly once',
    uiAdds > 0 && shared.value() === rnAdds + uiAdds && shared.calls() === rnAdds + uiAdds,
    [shared.value(), shared.calls(), rnAdds + uiAdds],
  );

  // W6: gesture and SharedValue forwarding. The device runner swipes once for each new
  // "RNRS_WORKLETS_SWIPE <tag>" line.
  const reactions = probe.createAccumulator(0);
  const stats = makeMutable<GestureStats>({
    events: 0,
    endpointMs: 0,
    emptyMs: 0,
    probed: false,
    skippedClosed: 0,
    caughtClosed: 0,
    reactionCaughtClosed: 0,
    unexpected: [],
  });
  const control = makeMutable({ bypassOpen: false });
  const writesBefore = probe.pointerWrites();
  const routesBefore = (bindings.routeRecordsForTesting() as RouteRecord[]).length;
  mountGestureLab?.({
    endpoint: ep,
    reactions,
    probe: bindings.routeProbeForTesting,
    stats,
    control,
  });
  await sleep(1000);
  // Waits until `done()` or `limitMs`, then until `count()` stops changing for 1.5 s (the
  // remaining swipes of that round have landed).
  const settle = async (done: () => boolean, count: () => number, limitMs: number) => {
    let waited = 0;
    while (!done() && waited < limitMs) {
      await sleep(250);
      waited += 250;
    }
    let last = -1;
    for (let quiet = 0; quiet < 1500 && waited < limitMs + 15000; waited += 250) {
      const now = count();
      quiet = now === last ? quiet + 250 : 0;
      last = now;
      await sleep(250);
    }
    return waited;
  };
  console.log('RNRS_WORKLETS_SWIPE w6');
  const gestureWaited = await settle(
    () => stats.value.events >= 20 && reactions.value() >= 10,
    () => stats.value.events,
    60000,
  );
  const s = stats.value;
  const writes = probe.pointerWrites() - writesBefore;
  const gestureRoute = (bindings.routeRecordsForTesting() as RouteRecord[])[routesBefore];
  const gesture = {
    events: s.events,
    endpointWrites: writes,
    reactions: reactions.value(),
    lastPointer: [probe.pointerX(), probe.pointerY()],
    repeatPerEvent: 20,
    endpointUsPerCall: s.events ? (s.endpointMs * 1000) / (s.events * 20) : null,
    emptyWorkletUsPerCall: s.events ? (s.emptyMs * 1000) / (s.events * 20) : null,
    gestureThread: gestureRoute?.threadName,
    gestureOnJsThread: gestureRoute?.onInstallJsThread,
    waitedMs: gestureWaited,
  };
  observations.gesture = gesture;
  check(
    'W6: Pan updates called the endpoint from a worklet (20 setPointer calls per event)',
    s.events >= 20 && writes === s.events * 20,
    gesture,
  );
  check(
    'W6: gesture worklet ran on the UI thread, not the RN JS thread',
    gestureRoute !== undefined && gestureRoute.onInstallJsThread === false,
    gestureRoute,
  );
  check(
    'W6: useAnimatedReaction forwarded the SharedValue as plain numbers',
    reactions.value() >= 10,
    gesture.reactions,
  );
  check(
    'W6: no closed or unexpected errors before teardown',
    s.caughtClosed === 0 &&
      s.reactionCaughtClosed === 0 &&
      s.skippedClosed === 0 &&
      s.unexpected.length === 0,
    s,
  );

  const lifecycle = bindings.lifecycle();
  observations.lifecycleBeforeClose = lifecycle;
  check(
    'W4: endpoint calls off the creating thread were made',
    lifecycle.workletCallsOffCreator > 0,
    lifecycle.workletCallsOffCreator,
  );

  // W5a: late calls after the RN runtime's scope is torn down (test hook: invalidation while
  // JS still runs). Boxes and the endpoint stay allocated and refuse with ERR_RNRS_CLOSED.
  bindings.invalidateForTesting();
  const late = {
    rn: attempt(() => ep.scale(1, 2)),
    ui: runOnUISync(() => {
      'worklet';
      return [attempt(() => ep.scale(1, 2)), attempt(() => (globalThis as any).__labShared.add(1))];
    }),
    custom: runOnRuntimeSync(custom, () => {
      'worklet';
      return [attempt(() => ep.scale(1, 2)), attempt(() => (globalThis as any).__labAcc.add(1))];
    }),
  };
  observations.lateCalls = late;
  const all = [late.rn, ...late.ui, ...late.custom];
  check(
    'W5a: endpoint and box calls after teardown throw ERR_RNRS_CLOSED',
    all.every((r) => !r.ok && r.code === 'ERR_RNRS_CLOSED'),
    all,
  );
  check('W5a: endpoint reports $open false after teardown', ep.$open === false, ep.$open);

  // W5a, late gestures (the view stays mounted). Phase 1: the handler sees $open false and
  // skips. Phase 2 (forced): the handler calls the closed endpoint without checking $open, so
  // ERR_RNRS_CLOSED is actually thrown on the UI thread and must be caught there (and in the
  // reaction it drives); an uncaught one would crash the app.
  const beforeSkip = stats.value;
  console.log('RNRS_WORKLETS_SWIPE late-skip');
  await settle(
    () => stats.value.skippedClosed - beforeSkip.skippedClosed >= 5,
    () => stats.value.skippedClosed,
    30000,
  );
  const afterSkip = stats.value;
  control.value = { bypassOpen: true };
  console.log('RNRS_WORKLETS_SWIPE late-forced');
  await settle(
    () =>
      stats.value.caughtClosed - afterSkip.caughtClosed >= 5 &&
      stats.value.reactionCaughtClosed - afterSkip.reactionCaughtClosed >= 1,
    () => stats.value.caughtClosed + stats.value.reactionCaughtClosed,
    30000,
  );
  const afterForced = stats.value;
  mountGestureLab?.(null);
  const lateGesture = {
    skip: {
      skippedClosed: afterSkip.skippedClosed - beforeSkip.skippedClosed,
      caughtClosed: afterSkip.caughtClosed - beforeSkip.caughtClosed,
    },
    forced: {
      caughtClosed: afterForced.caughtClosed - afterSkip.caughtClosed,
      reactionCaughtClosed: afterForced.reactionCaughtClosed - afterSkip.reactionCaughtClosed,
      skippedClosed: afterForced.skippedClosed - afterSkip.skippedClosed,
    },
    unexpected: afterForced.unexpected,
  };
  observations.lateGesture = lateGesture;
  check(
    'W5a: late gestures with the $open check were skipped (no call made)',
    lateGesture.skip.skippedClosed > 0,
    lateGesture.skip,
  );
  check(
    'W5a: forced late gesture calls threw ERR_RNRS_CLOSED on the UI thread and were caught in the handler and the reaction',
    lateGesture.forced.caughtClosed > 0 &&
      lateGesture.forced.reactionCaughtClosed > 0 &&
      lateGesture.forced.skippedClosed === 0,
    lateGesture.forced,
  );
  check(
    'W5a/W6: no unexpected error in any gesture or reaction worklet',
    afterForced.unexpected.length === 0,
    afterForced.unexpected,
  );

  // Release the UI and custom runtimes' boxes; the native counts are read after GC.
  runOnUISync(() => {
    'worklet';
    (globalThis as any).__labAcc = undefined;
    (globalThis as any).__labShared = undefined;
  });
  runOnRuntimeSync(custom, () => {
    'worklet';
    (globalThis as any).__labAcc = undefined;
  });
  bindings.collectGarbageForTesting();
  observations.lifecycleAfterClose = bindings.lifecycle();
}
