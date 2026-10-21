// Regression for lost drain wakes on React Native 0.88: when an unrelated RuntimeScheduler
// task throws, RN clears the scheduler's queues (RuntimeScheduler_Modern::handleTaskError)
// and reports the error to the JS global handler; an app whose handler does not crash keeps
// running. A drain task queued at that moment is destroyed unrun. The framework detects the
// drop (RnrsDelivery.h) and the Rust host posts the wake again (rnrs-core
// Host::monitor_delivery); a drain that is merely slow is never posted again.
// Deterministic setup: one scheduler task busy-waits while a Rust `addLater` completes (its
// drain is posted behind the busy task), then throws (or, in the controls, returns).
import { counterModule } from '@rnrs/example-counter';

export interface SmokeResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

type Stats = {
  drainsPosted: number;
  drainsRun: number;
  drainsSkipped: number;
  drainsDropped: number;
};
const g = globalThis as any;
const stats = (): Stats => {
  const s = g.__rnrsRuntime.lifecycle();
  return {
    drainsPosted: s.drainsPosted,
    drainsRun: s.drainsRun,
    drainsSkipped: s.drainsSkipped,
    drainsDropped: s.drainsDropped,
  };
};
const diff = (a: Stats, b: Stats) => ({
  posted: b.drainsPosted - a.drainsPosted,
  run: b.drainsRun - a.drainsRun,
  skipped: b.drainsSkipped - a.drainsSkipped,
  dropped: b.drainsDropped - a.drainsDropped,
});
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const settles = (p: Promise<number>, ms: number) =>
  Promise.race([p.then((v) => `settled ${v}`), sleep(ms).then(() => 'pending')]);

// Posts one ImmediatePriority scheduler task that blocks JS for `busyMs`, then throws or
// returns, and a witness task behind it. `during` runs inside the busy task right before it
// ends (JS is still blocked). Returns whether the witness ran.
function blockThen(
  busyMs: number,
  shouldThrow: boolean,
  during: () => void = () => {},
): { witness: () => boolean } {
  const s = g.nativeRuntimeScheduler;
  let ran = false;
  s.unstable_scheduleCallback(s.unstable_ImmediatePriority, () => {
    const end = Date.now() + busyMs;
    while (Date.now() < end) {}
    during();
    if (shouldThrow) throw new Error('RNRS_PROBE deliberate scheduler task error');
  });
  s.unstable_scheduleCallback(s.unstable_ImmediatePriority, () => {
    ran = true;
  });
  return { witness: () => ran };
}

export async function runSmoke(): Promise<SmokeResult> {
  const checks: SmokeResult['checks'] = [];
  const record = (name: string, ok: boolean, detail: unknown) =>
    checks.push({ name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  const errors: string[] = [];
  const previousHandler = g.ErrorUtils.getGlobalHandler();
  g.ErrorUtils.setGlobalHandler((e: unknown, isFatal?: boolean) => {
    errors.push(`${isFatal ? 'fatal' : 'non-fatal'}: ${String((e as Error)?.message ?? e)}`);
  });
  try {
    const c = counterModule().create(0);
    record(
      'baseline addLater settles',
      (await settles(c.addLater(1, 10, false), 3000)) !== 'pending',
      '',
    );

    // Control: same timing, the busy task returns normally; one post, one run, no drop.
    let s0 = stats();
    let p = c.addLater(1, 50, false);
    let block = blockThen(400, false);
    let r = await settles(p, 3000);
    let d = diff(s0, stats());
    record(
      'control: settles with one post and no drop',
      r !== 'pending' && block.witness() && d.dropped === 0 && d.posted === 1,
      { r, ...d },
    );

    // Fix: the busy task throws while the drain is queued behind it. RN drops the queued
    // tasks (the witness does not run); the framework sees the drop and posts again.
    s0 = stats();
    p = c.addLater(1, 50, false);
    block = blockThen(400, true);
    r = await settles(p, 5000);
    d = diff(s0, stats());
    record(
      'after a throwing task: the pending addLater settles (drop detected, posted again)',
      r !== 'pending' &&
        !block.witness() &&
        d.dropped >= 1 &&
        d.posted >= 2 &&
        errors.filter((e) => e.includes('RNRS_PROBE deliberate scheduler task error')).length === 1,
      { r, witness: block.witness(), ...d, errors },
    );
    const later = await settles(c.addLater(1, 10, false), 3000);
    record('after a throwing task: a later addLater settles', later !== 'pending', later);
    record(
      'after a throwing task: sync calls work',
      typeof c.value() === 'number',
      String(c.value()),
    );

    // Bound: JS blocked for 10 s while an outcome is ready. The drain is merely queued, so it
    // is not posted again: at most one post for the whole block, and it settles afterwards.
    s0 = stats();
    p = c.addLater(1, 50, false);
    let atEnd: ReturnType<typeof diff> | undefined;
    block = blockThen(10000, false, () => {
      atEnd = diff(s0, stats());
    });
    r = await settles(p, 5000);
    d = diff(s0, stats());
    record(
      'JS blocked 10 s: at most one queued drain, then it settles',
      r !== 'pending' &&
        atEnd !== undefined &&
        atEnd.posted <= 1 &&
        atEnd.posted - atEnd.run <= 1 &&
        d.dropped === 0,
      { r, duringBlock: atEnd, after: d },
    );
  } finally {
    g.ErrorUtils.setGlobalHandler(previousHandler);
  }
  return { ok: checks.every((x) => x.ok), checks };
}
