// Logging smoke (docs/logging.md): calls the lab-only log-probe fixture on the JS thread and
// on an executor worker. Which of its events reach the platform log is checked from logcat by
// scripts/consumer/rn-smoke.mjs (RNRS_EXPECT_LOG); this only reports the threads used.
import { logProbeModule } from '@rnrs/labs-log-probe';

export interface SmokeResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

export async function runSmoke(): Promise<SmokeResult> {
  const checks: SmokeResult['checks'] = [];
  try {
    const probe = logProbeModule();
    const js = probe.emit('p-js');
    const worker = await probe.emitOnWorker('p-worker');
    checks.push({
      name: 'probe events emitted on the JS thread and on a worker thread',
      ok: js !== worker,
      detail: `js thread "${js}", worker thread "${worker}"`,
    });
  } catch (error) {
    checks.push({
      name: 'probe events emitted on the JS thread and on a worker thread',
      ok: false,
      detail: String((error as Error)?.message ?? error),
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}
