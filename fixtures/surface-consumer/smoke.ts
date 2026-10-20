// Milestone 1 surface lifecycle checks (docs/surface.md), using only public package APIs.
// The App renders whatever `Scene` the sequence sets; a requestAnimationFrame loop submits one
// frame per live renderer per tick (a moving ball, a paddle and a frame counter bar).
import type {Renderer, RendererStats} from '@rnrs/example-vello2d';
import {vello2DModule} from '@rnrs/example-vello2d';
import {FrameWriter} from '@rnrs/example-vello2d/frame';

export interface ViewSpec {
  id: string;
  renderer: 'A' | 'B';
  height: number;
}
export interface Scene {
  views: ViewSpec[];
  label: string;
}
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export interface SmokeResult {
  ok: boolean;
  checks: Check[];
  samples?: Record<string, unknown>;
  stats?: Record<string, RendererStats>;
}

export interface Renderers {
  A: Renderer;
  B: Renderer;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function createRenderers(): Renderers {
  const m = vello2DModule();
  return {A: m.create({resolutionScale: 1}), B: m.create({resolutionScale: 0.5})};
}

/** Starts the frame loop; returns a stop function. `closed` renderers are skipped once
 *  submit reports false. */
export function startFrames(renderers: Renderers): {stop: () => void; submitted: () => number} {
  const writer = new FrameWriter();
  const live = new Set<keyof Renderers>(['A', 'B']);
  let frames = 0;
  let handle = 0;
  const tick = (t: number) => {
    frames++;
    for (const name of [...live]) {
      const hue = name === 'A' ? [0.05, 0.1, 0.25, 1] : [0.2, 0.05, 0.05, 1];
      const x = 40 + ((t / 8) % 280);
      writer
        .begin()
        .clear(hue as [number, number, number, number])
        .roundRect(20, 20, 24, 120, 6, [0.9, 0.9, 0.9, 1])
        .circle(x, 90, 14, [1, 0.85, 0.2, 1])
        .rect(0, 0, (frames % 120) * 3, 6, [0.2, 0.9, 0.4, 1])
        .line(0, 170, 360, 170, 2, [0.5, 0.5, 0.6, 1]);
      try {
        if (!renderers[name].submit(writer.finish())) live.delete(name);
      } catch {
        live.delete(name); // disposed wrapper
      }
    }
    handle = requestAnimationFrame(tick);
  };
  handle = requestAnimationFrame(tick);
  return {stop: () => cancelAnimationFrame(handle), submitted: () => frames};
}

async function until(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}

/** p50/p90/max of a list of snapshot values. */
const distribution = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN);
  return {p50: at(0.5), p90: at(0.9), max: s.length ? s[s.length - 1] : NaN, n: s.length};
};

export async function runSmoke(renderers: Renderers, setScene: (s: Scene) => void): Promise<SmokeResult> {
  const {A, B} = renderers;
  const checks: Check[] = [];
  const st = (r: Renderer) => r.stats();
  const check = (name: string, ok: boolean, detail: unknown = '') =>
    checks.push({name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail)});
  const show = (label: string, views: ViewSpec[]) => setScene({label, views});

  // 1. Mount: attach, first present.
  show('mount A', [{id: 'v1', renderer: 'A', height: 300}]);
  check('mount: A attaches and presents',
    await until(() => st(A).state === 'attached' && st(A).framesPresented > 5),
    st(A));
  check('mount: no renderer error', st(A).lastError === null && st(A).surfaceErrors === 0, st(A).lastError ?? '');
  const keyA = A.surfaceKey();
  check('keys are opaque positive integers below 2^53, distinct per renderer',
    Number.isSafeInteger(keyA) && keyA > 0 && B.surfaceKey() !== keyA, `${keyA} ${B.surfaceKey()}`);

  // Sampled timings over ~2 s while presenting.
  const samples: Record<string, number[]> = {raster: [], upload: [], acquire: [], present: [], submitToPresentReturn: []};
  const p0 = st(A).framesPresented;
  const t0 = Date.now();
  while (Date.now() - t0 < 2000) {
    const s = st(A);
    samples.raster.push(s.lastRasterMs);
    samples.upload.push(s.lastUploadMs);
    samples.acquire.push(s.lastAcquireMs);
    samples.present.push(s.lastPresentMs);
    samples.submitToPresentReturn.push(s.lastSubmitToPresentReturnMs);
    await sleep(100);
  }
  const presentedPerSecond = ((st(A).framesPresented - p0) * 1000) / (Date.now() - t0);
  const sampled = {
    note: 'distribution of stats() snapshots taken every 100 ms (each holds the most recent presented frame), not per-frame percentiles. ' +
      'CPU time on the render thread; submitToPresentReturn is CPU queue latency from Rust submit (after the JS-to-Rust copy) to the present call returning, excluding GPU execution, composition and display.',
    presentedPerSecond,
    snapshotMs: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, distribution(v)])),
    gpuState: st(A).gpuState,
    presentation: st(A).presentation,
    raster: `${st(A).rasterWidth}x${st(A).rasterHeight}`,
    surface: `${st(A).surfaceWidth}x${st(A).surfaceHeight}@${st(A).scale}`,
    deviceInitMs: st(A).deviceInitMs,
  };
  check('presents continuously (> 20 frames/s)', presentedPerSecond > 20, sampled);

  // 2. Resize.
  const r0 = st(A).resizes;
  const h0 = st(A).surfaceHeight;
  show('resize A', [{id: 'v1', renderer: 'A', height: 200}]);
  check('resize: counted', await until(() => st(A).resizes > r0 && st(A).surfaceHeight > 0 && st(A).surfaceHeight < h0), st(A));
  const presentedAtResize = st(A).framesPresented;
  check('resize: frames presented at the new size (raster matches the new surface)',
    await until(() => st(A).framesPresented > presentedAtResize + 3 && st(A).rasterHeight === st(A).surfaceHeight && st(A).surfaceHeight < h0), st(A));

  // 3. Zero size, then back.
  const d0 = st(A).detaches;
  show('zero height', [{id: 'v1', renderer: 'A', height: 0}]);
  check('zero size: detached', await until(() => st(A).state === 'detached' && st(A).detaches > d0), st(A));
  show('height back', [{id: 'v1', renderer: 'A', height: 300}]);
  check('after zero size: attached and presenting again', await until(() => st(A).state === 'attached'), st(A));

  // 4. Unmount and remount: the renderer survives its view.
  const a0 = st(A).attaches;
  show('unmount', []);
  check('unmount: detached, renderer still accepts frames',
    await until(() => st(A).state === 'detached') && A.submit(new FrameWriter().begin().finish()), st(A));
  show('remount', [{id: 'v2', renderer: 'A', height: 300}]);
  check('remount (new view, same key): attaches again', await until(() => st(A).state === 'attached' && st(A).attaches > a0), st(A));

  // 4b. Two views with the same key, unfavourable order: the first attached keeps it, the
  // second is refused as busy and retries; when the first unmounts, the second attaches.
  show('one key, first view', [{id: 'v5', renderer: 'A', height: 200}]);
  check('busy: first view attached', await until(() => st(A).state === 'attached'), st(A));
  const refused0 = st(A).refusedAttaches;
  show('one key, two views', [{id: 'v5', renderer: 'A', height: 200}, {id: 'v6', renderer: 'A', height: 200}]);
  check('busy: the second view is refused (first attached wins)', await until(() => st(A).refusedAttaches > refused0), st(A));
  const attachesBusy = st(A).attaches;
  show('one key, second view only', [{id: 'v6', renderer: 'A', height: 200}]);
  check('busy: after the first unmounts, the waiting view attaches by its retry',
    await until(() => st(A).state === 'attached' && st(A).attaches > attachesBusy, 5000), st(A));
  show('remount', [{id: 'v2', renderer: 'A', height: 300}]);
  await until(() => st(A).state === 'attached');

  // 5. Key change on a mounted view: A detaches, B attaches to the same window.
  show('key change', [{id: 'v2', renderer: 'B', height: 300}]);
  check('key change: A detached, B attached and presenting',
    await until(() => st(A).state === 'detached' && st(B).state === 'attached' && st(B).framesPresented > 3), {A: st(A), B: st(B)});
  check('B renders at half resolution', st(B).rasterWidth > 0 && Math.abs(st(B).rasterWidth * 2 - st(B).surfaceWidth) <= 1, st(B));

  // 6. Two surfaces at once.
  show('two surfaces', [{id: 'v3', renderer: 'A', height: 220}, {id: 'v4', renderer: 'B', height: 220}]);
  const pa = st(A).framesPresented;
  const pb = st(B).framesPresented;
  check('two surfaces: both attached and presenting',
    await until(() => st(A).state === 'attached' && st(B).state === 'attached' && st(A).framesPresented > pa + 5 && st(B).framesPresented > pb + 5),
    {A: st(A), B: st(B)});

  // 7. Close B while its view is attached: contained, the view keeps working, A unaffected.
  B.close();
  check('close while attached: submit returns false, state closed', !B.submit(new FrameWriter().begin().finish()) && st(B).state === 'closed', st(B));
  const pa2 = st(A).framesPresented;
  await sleep(500);
  check('A keeps presenting after B closed', st(A).framesPresented > pa2, st(A));
  show('unmount closed B view', [{id: 'v3', renderer: 'A', height: 300}]);
  await sleep(500);
  B.dispose();
  check('no detach timeouts', st(A).detachTimeouts === 0, st(A));

  const result: SmokeResult = {ok: checks.every(c => c.ok), checks, samples: sampled, stats: {A: st(A)}};
  show('steady A', [{id: 'v3', renderer: 'A', height: 300}]);
  return result;
}
