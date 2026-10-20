// Measurement and reporting for the paddle game (App.tsx). Two kinds of numbers, labelled:
// - per requestAnimationFrame tick (JS): tick intervals and simulation steps per tick, measured
//   on every running tick (rAF ticks follow the display's frame callbacks; they are not
//   presented frames);
// - renderer snapshots: stats() sampled every 100 ms, each holding the most recent presented
//   frame (CPU time on the render thread), so a distribution of snapshots, not per frame.
// Presented frames are counted by the renderer; nothing here measures display latency.
import type { RendererStats } from '@rnrs/example-vello2d';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export function distribution(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    p50: r(at(0.5)),
    p90: r(at(0.9)),
    p99: r(at(0.99)),
    max: r(s.length ? s[s.length - 1] : NaN),
    n: s.length,
  };
}

/** Collects per-tick and snapshot samples for one session. */
export class Recorder {
  tickIntervalsMs: number[] = [];
  stepsPerTick: number[] = [];
  submits = 0;
  private lastTick: number | null = null;
  private snaps: {
    raster: number[];
    upload: number[];
    acquire: number[];
    present: number[];
    submitToPresentReturn: number[];
  } = { raster: [], upload: [], acquire: [], present: [], submitToPresentReturn: [] };
  first: RendererStats | null = null;
  last: RendererStats | null = null;
  startedMs = 0;
  endedMs = 0;
  /** Running (unpaused) seconds of the session, from the app. Rates are per running second. */
  activeS = 0;
  raster: [number, number] = [0, 0];

  tick(nowMs: number, steps: number, submitted: boolean) {
    if (this.lastTick !== null) this.tickIntervalsMs.push(nowMs - this.lastTick);
    this.lastTick = nowMs;
    this.stepsPerTick.push(steps);
    if (submitted) this.submits++;
  }

  snapshot(s: RendererStats) {
    if (!this.first) this.first = s;
    this.last = s;
    if (s.state !== 'attached') return;
    this.raster = [s.rasterWidth, s.rasterHeight];
    this.snaps.raster.push(s.lastRasterMs);
    this.snaps.upload.push(s.lastUploadMs);
    this.snaps.acquire.push(s.lastAcquireMs);
    this.snaps.present.push(s.lastPresentMs);
    this.snaps.submitToPresentReturn.push(s.lastSubmitToPresentReturnMs);
  }

  summary() {
    const seconds = this.activeS > 0 ? this.activeS : (this.endedMs - this.startedMs) / 1000;
    const presented = (this.last?.framesPresented ?? 0) - (this.first?.framesPresented ?? 0);
    const replaced = (this.last?.framesReplaced ?? 0) - (this.first?.framesReplaced ?? 0);
    const steps = this.stepsPerTick.reduce((a, b) => a + b, 0);
    const hist: Record<string, number> = {};
    for (const n of this.stepsPerTick) hist[n] = (hist[n] ?? 0) + 1;
    return {
      runningSeconds: Math.round(seconds * 100) / 100,
      wallSeconds: Math.round(((this.endedMs - this.startedMs) / 1000) * 100) / 100,
      raster: this.raster,
      perActiveSecond: {
        rafTicks: Math.round((this.stepsPerTick.length / seconds) * 10) / 10,
        simSteps: Math.round((steps / seconds) * 10) / 10,
        submits: Math.round((this.submits / seconds) * 10) / 10,
        rendererPresented: Math.round((presented / seconds) * 10) / 10,
      },
      framesReplacedBeforeDrawing: replaced,
      perRafTick: { intervalMs: distribution(this.tickIntervalsMs), stepsHistogram: hist },
      rendererSnapshotsMs: Object.fromEntries(
        Object.entries(this.snaps).map(([k, v]) => [k, distribution(v)]),
      ),
      note: 'perRafTick: every running requestAnimationFrame tick (JS). rendererPresented includes re-presentations after a resize or re-attach. rendererSnapshotsMs: 100 ms snapshots of the latest presented frame (render-thread CPU time; submitToPresentReturn is Rust submit to present-call return). Display latency is not measured.',
    };
  }
}

/** Reports a result as several short console lines (logcat truncates near 4 KB). */
export function report(
  tag: string,
  result: { ok: boolean; checks: Check[]; [k: string]: unknown },
) {
  result.checks.forEach((c, i) => console.log(`${tag}_CHECK ` + JSON.stringify({ i, ...c })));
  for (const [k, v] of Object.entries(result)) {
    if (k !== 'checks' && k !== 'ok')
      console.log(`${tag}_DATA ` + JSON.stringify({ key: k, value: v }));
  }
  console.log(
    `${tag} ` +
      JSON.stringify({
        ok: result.ok,
        checks: result.checks.map((c) => ({ name: c.name, ok: c.ok })),
      }),
  );
}
