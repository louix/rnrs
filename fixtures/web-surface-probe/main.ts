import init, {raster, raster_mode} from '../pkg/rnr_web_surface_probe.js';
import {FrameWriter} from '../../packages/vello2d/frame';

const checks: {name: string; ok: boolean; detail: string}[] = [];
function check(name: string, ok: boolean, detail = '') {
  checks.push({name, ok, detail});
}
async function main() {
  await init();
  const canvas = document.querySelector('canvas')!;
  const ctx = canvas.getContext('2d')!;
  const writer = new FrameWriter();
  const frame = writer.begin().clear([0, 0, 1, 1])
    .rect(10, 10, 20, 20, [1, 0, 0, 1])
    .circle(80, 20, 10, [0, 1, 0, 1])
    .rect(0, 0, 5, 5, [1, 0, 0, 0.5]).finish();
  function draw(w: number, h: number, scale: number, bytes = frame) {
    const start = performance.now();
    const pixels = raster(new Uint8Array(bytes), w, h, scale);
    const rasterMs = performance.now() - start;
    canvas.width = w; canvas.height = h;
    const image = new ImageData(new Uint8ClampedArray(pixels), w, h);
    ctx.putImageData(image, 0, 0);
    return {rasterMs, totalMs: performance.now() - start};
  }
  const px = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
  const equal = (a: number[], b: number[]) => a.every((n, i) => n === b[i]);
  const first = draw(200, 100, 2);
  check('scaled rect', equal(px(40, 40), [255, 0, 0, 255]));
  check('scaled circle', equal(px(160, 40), [0, 255, 0, 255]));
  check('background', equal(px(70, 70), [0, 0, 255, 255]));
  const blend = px(2, 2);
  check('opaque blended output', blend[0] >= 126 && blend[0] <= 129 &&
    blend[2] >= 126 && blend[2] <= 129 && blend[1] === 0 && blend[3] === 255, JSON.stringify(blend));
  draw(100, 50, 1);
  check('resize and scale', equal(px(20, 20), [255, 0, 0, 255]) && canvas.width === 100);
  for (const [w, h] of [[0, 1], [4097, 1], [4096, 4096], [0xffffffff, 0xffffffff]]) {
    let rejected = false;
    try { raster(new Uint8Array(frame), w, h, 1); } catch { rejected = true; }
    check('reject extent ' + w + 'x' + h, rejected);
  }
  let malformed = false;
  try { raster(new Uint8Array([0, 0, 0]), 10, 10, 1); } catch { malformed = true; }
  check('reject malformed frame', malformed);
  const timings = [];
  // Explicit synchronous measurements, not a frame-rate or lifecycle benchmark.
  for (const size of [256, 1024, 2048]) {
    await new Promise(resolve => setTimeout(resolve, 0));
    const sample = draw(size, size, 1);
    timings.push({size, ...sample, synchronousOver50ms: sample.totalMs >= 50});
  }
  // Near the encoded-frame cap (the minimum command is five f32 values).
  // This stresses command count separately from the 2048² pixel sample.
  const dense = new FrameWriter();
  dense.begin();
  for (let i = 0; i < 52_428; i++) dense.clear([i % 2, 0, 0, 1]);
  const denseFrame = dense.finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  const denseSample = draw(256, 256, 1, denseFrame);
  check('near-frame-cap output', equal(px(1, 1), [255, 0, 0, 255]));
  const commandStress = {commands: 52_428, bytes: denseFrame.byteLength, size: 256,
    ...denseSample, synchronousOver50ms: denseSample.totalMs >= 50};
  canvas.remove();
  check('DOM canvas removed', !canvas.isConnected);
  const result = {rasterMode: raster_mode(), ok: checks.every(c => c.ok), checks, first, timings, commandStress,
    limitation: 'Stateless feasibility: removal is not proof of renderer/runtime lifecycle cleanup.'};
  (globalThis as any).__rnrResult = result;
  document.querySelector('#out')!.textContent = JSON.stringify(result, null, 2);
}
main().catch(error => {
  (globalThis as any).__rnrResult = {ok: false, checks, error: String(error?.stack ?? error)};
});
