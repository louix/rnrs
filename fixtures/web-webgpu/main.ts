// Optional WebGPU presentation through @rnrs/surface: one wgpu triangle drawn by Rust directly
// into the host's canvas. ?expect=unsupported is the default Chromium launch (no adapter);
// ?expect=webgpu is the test-only SwiftShader launch (software WebGPU: correctness only, no
// performance claim). The optional pixel probe copies the presented canvas into a 2D canvas: a
// TEST-ONLY readback, never part of the presentation path.
import init, * as wasm from './rnr/pkg/rnr_bundle.js';
import {installWebBackend, type RnrWasm} from '@rnrs/runtime/web';
import {createSurfaceBootstrap} from '@rnrs/surface/browser';
import {createWebgpuTriangleModuleForTesting} from '../../.generated/rnr/rnr_webgpu_triangle';
import {createVello2DModuleForTesting} from '../../.generated/rnr/rnr_vello2d';
import {FrameWriter} from '../../packages/vello2d/frame';

const expect = new URLSearchParams(location.search).get('expect');
const checks: {name: string; ok: boolean; detail: string}[] = [];
const notes: Record<string, unknown> = {expect};
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const frames = (n = 2) => new Promise<void>(resolve => {
  const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step)); requestAnimationFrame(step);
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const diagnostics = () => Array.from(wasm.rnr_surface_diagnostics()) as number[];
async function until(what: string, condition: () => boolean, ms = 10_000) {
  const end = performance.now() + ms;
  while (!condition()) { if (performance.now() > end) throw new Error('timed out: ' + what); await frames(1); }
}
async function test(name: string, run: () => Promise<void>) {
  try { await run(); checks.push({name, ok: true, detail: ''}); }
  catch (error) { checks.push({name, ok: false, detail: String(error)}); }
}
function setup() {
  let boot!: ReturnType<typeof createSurfaceBootstrap>;
  const backend = installWebBackend(wasm as unknown as RnrWasm, same => boot = createSurfaceBootstrap(same));
  const module = createWebgpuTriangleModuleForTesting(8);
  const wrapper = document.createElement('div'), canvas = document.createElement('canvas');
  wrapper.style.cssText = 'width:160px;height:120px';
  canvas.style.cssText = 'width:100%;height:100%;display:block';
  wrapper.append(canvas); document.body.append(wrapper);
  const errors: string[] = [];
  const mount = (key: number, target = canvas) => boot.host.mount(target, wrapper, key, e => errors.push(String(e)));
  return {backend, boot, module, wrapper, canvas, errors, mount,
    cleanup() { backend.dispose(); wrapper.remove(); }};
}
/** TEST-ONLY copy of the presented WebGPU canvas into 2D; returns RGBA at (x, y) fractions. */
function probe(source: HTMLCanvasElement, fx: number, fy: number) {
  const copy = document.createElement('canvas');
  copy.width = source.width; copy.height = source.height;
  const ctx = copy.getContext('2d')!;
  ctx.drawImage(source, 0, 0);
  return Array.from(ctx.getImageData(Math.floor(fx * source.width), Math.floor(fy * source.height), 1, 1).data);
}
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 3);

async function unsupported() {
  const h = setup();
  try {
    await test('default launch: WebGPU is a terminal, reported failure with no fallback or retries', async () => {
      const triangle = h.module.create();
      const mount = h.mount(triangle.surfaceKey());
      assert(mount.presentation === 'webgpu', 'host selected the producer presentation');
      await until('failure', () => triangle.stats().gpuState === 'failed');
      await sleep(1500);
      const st = triangle.stats();
      notes.unsupported = {stats: st, errors: h.errors};
      assert(st.lastError?.startsWith('WebGPU unsupported'), 'clear unsupported error: ' + st.lastError);
      assert(h.errors.length === 1 && h.errors[0].includes('WebGPU unsupported'), 'reported once: ' + JSON.stringify(h.errors));
      assert(st.initsStarted === 1, 'no automatic retries: ' + st.initsStarted);
      assert(st.framesSubmitted === 0 && st.state === 'detached', 'nothing drawn, attachment released');
      assert(h.canvas.getContext('2d') === null, 'no Canvas 2D fallback on the WebGPU canvas');
      mount.refresh();
      await until('explicit reattach fails again', () => triangle.stats().initsStarted === 2 && triangle.stats().gpuState === 'failed');
      assert(h.errors.length === 2, 'explicit refresh retries exactly once');
      mount.dispose(); triangle.close();
    });
  } finally { h.cleanup(); }
}

async function webgpu() {
  const h = setup();
  try {
    const triangle = h.module.create();
    const key = triangle.surfaceKey();
    let mount = h.mount(key);
    let presentationSurvived = false;
    await test('software adapter: setup, validated pipeline and a GPU submit into the canvas texture', async () => {
      assert(triangle.stats().gpuState === 'initializing' && triangle.stats().framesSubmitted === 0, 'pending while setup is asynchronous');
      await until('first submit', () => triangle.stats().framesSubmitted > 0);
      const st = triangle.stats();
      notes.firstSubmit = st;
      assert(st.adapter.includes('fallback adapter: software'), 'adapter labelled as software: ' + st.adapter);
      assert(st.presentation.endsWith('Opaque Fifo') && st.lastError === null, 'configured without validation errors: ' + st.presentation);
      assert(h.canvas.width === Math.round(160 * devicePixelRatio), 'backing size from host extent');
      await sleep(1000);
      presentationSurvived = triangle.stats().gpuState === 'ready';
    });
    if (presentationSurvived) {
      await test('visible triangle pixels (test-only copy of the presented canvas)', async () => {
        const centre = probe(h.canvas, 0.5, 0.55), corner = probe(h.canvas, 0.02, 0.02);
        notes.pixels = {centre, corner};
        assert(near(centre, [255, 128, 0, 255]) && near(corner, [0, 0, 0, 255]), 'orange triangle on black');
      });
    } else {
      // Reproduced without Rust (fixtures/web-webgpu/README.md): this headless SwiftShader
      // Chromium reports the device destroyed shortly after the submits into a WebGPU canvas
      // texture, and canvas copies read transparent. Visible proof is blocked here.
      notes.blocked = 'visible presentation: device reported destroyed after the first canvas submit; ' +
        triangle.stats().lastError;
      console.log('BLOCKED ' + notes.blocked);
    }

    await test('device loss is terminal, reported once and never retried automatically', async () => {
      if (presentationSurvived) assert(triangle.destroyDeviceForTesting(), 'device destroyed');
      await until('failed', () => triangle.stats().gpuState === 'failed');
      const inits = triangle.stats().initsStarted;
      await sleep(800);
      const st = triangle.stats();
      assert(st.deviceLosses === 1 && st.lastError?.startsWith('device lost'), 'loss recorded: ' + st.lastError);
      assert(st.initsStarted === inits && st.state === 'detached' && h.canvas.width === 0, 'no automatic recovery; canvas released');
      assert(h.errors.length === 1 && h.errors[0].includes('device lost'), 'reported once: ' + JSON.stringify(h.errors));
      const submitted = st.framesSubmitted;
      mount.refresh();
      await until('explicit reattach builds a new device', () => triangle.stats().initsStarted === inits + 1 && triangle.stats().framesSubmitted > submitted);
    });

    await test('hide/show releases the attachment and show reattaches once', async () => {
      window.dispatchEvent(new Event('pagehide')); await frames(2);
      const st = triangle.stats();
      assert(st.state === 'detached' && st.gpuState !== 'ready' && st.gpuState !== 'initializing' && h.canvas.width === 0, 'hidden: released and cleared');
      window.dispatchEvent(new Event('pageshow'));
      await until('shown', () => triangle.stats().initsStarted === st.initsStarted + 1 && triangle.stats().framesSubmitted > st.framesSubmitted);
      mount.dispose(); await frames(1);
      assert(triangle.stats().state === 'detached', 'unmount detaches');
    });

    await test('resize during setup configures at the current extent', async () => {
      const token = wasm.rnr_surface_attach(key, 64, 48, 1) as number;
      const scratch = document.createElement('canvas');
      assert(wasm.rnr_surface_bind_canvas(key, token, scratch) === 'ok', 'bound');
      assert(wasm.rnr_surface_resize(key, token, 96, 40, 1) === 'ok', 'resized while initializing');
      assert(triangle.stats().surfaceWidth === 96, 'extent recorded');
      const submitted = triangle.stats().framesSubmitted;
      await until('ready', () => triangle.stats().gpuState !== 'initializing');
      assert(triangle.stats().gpuState === 'ready', 'setup finished: ' + triangle.stats().lastError);
      assert(scratch.width === 96 && scratch.height === 40, 'surface configured at the resized extent');
      const r = wasm.rnr_surface_render(key, token, true);
      assert(r.status === 'submitted' && triangle.stats().framesSubmitted === submitted + 1, 'explicit submitted outcome: ' + r.status);
      assert(wasm.rnr_surface_render(key, token, false).status === 'unchanged', 'no resubmission without a change');
      assert(triangle.setBackground(0, 0.5, 1), 'background accepted');
      assert(wasm.rnr_surface_render(key, token, false).status === 'submitted', 'a change resubmits');
      assert(wasm.rnr_surface_resize(key, token, 80, 40, 1) === 'ok' &&
        wasm.rnr_surface_render(key, token, false).status === 'submitted' && scratch.width === 80, 'resize reconfigures and redraws');
      wasm.rnr_surface_detach(key, token);
    });

    await test('late setup after detach and after replacement is discarded', async () => {
      const token = wasm.rnr_surface_attach(key, 64, 48, 1) as number;
      assert(token > 0, 'attached');
      const scratch = document.createElement('canvas');
      assert(wasm.rnr_surface_bind_canvas(key, token, scratch) === 'ok', 'bound');
      const discarded = triangle.stats().initsDiscarded;
      wasm.rnr_surface_detach(key, token);
      assert(triangle.stats().gpuState === 'none', 'detach ends setup state at once');
      // Overlapping replacement: a second attachment binds while the first setup is in flight.
      const second = wasm.rnr_surface_attach(key, 64, 48, 1) as number;
      assert(wasm.rnr_surface_bind_canvas(key, second, scratch) === 'ok', 'rebound');
      assert(wasm.rnr_surface_attach(key, 64, 48, 1) === 0, 'authority still refuses a concurrent attachment');
      wasm.rnr_surface_detach(key, second);
      await until('stale setups discarded', () => triangle.stats().initsDiscarded === discarded + 2);
      const st = triangle.stats();
      assert(st.gpuState === 'none' && st.state === 'detached', 'nothing kept from stale setups: ' + st.gpuState);
      assert(wasm.rnr_surface_render(key, second, true).status === 'stale', 'old token rejected');
    });

    await test('runtime teardown during setup closes the producer and leaves no owners', async () => {
      const other = createWebgpuTriangleModuleForTesting(8);
      const t = other.create();
      const k = t.surfaceKey();
      const token = wasm.rnr_surface_attach(k, 32, 32, 1) as number;
      assert(wasm.rnr_surface_bind_canvas(k, token, document.createElement('canvas')) === 'ok', 'bound');
      const before = diagnostics()[1];
      other.teardown();
      assert(wasm.rnr_surface_render(k, token, true).status === 'closed', 'closed by teardown');
      assert(diagnostics()[1] === before - 1, 'producer owner released at teardown');
      await sleep(500); // the in-flight setup settles; it must drop its device, not keep it
    });

    await test('a canvas keeps its context type: Canvas 2D mount on a WebGPU canvas is refused', async () => {
      const vello = createVello2DModuleForTesting(8);
      const renderer = vello.create({resolutionScale: 1, timingRecords: 0});
      let refused = '';
      try { h.mount(renderer.surfaceKey()); } catch (e) { refused = String(e); }
      assert(refused.includes('canvas already holds a webgpu context'), 'explicit refusal: ' + refused);
      // The existing Canvas 2D path is unchanged on a fresh canvas in the same bundle.
      const fresh = document.createElement('canvas');
      fresh.style.cssText = 'width:100%;height:100%';
      h.wrapper.append(fresh);
      renderer.submit(new FrameWriter().clear([1, 0, 0, 1]).finish());
      const m = h.mount(renderer.surfaceKey(), fresh);
      assert(m.presentation === 'canvas2d', 'Canvas 2D presentation');
      await until('canvas2d frame', () => fresh.width > 0 && fresh.getContext('2d')!.getImageData(0, 0, 1, 1).data[0] === 255);
      m.dispose(); fresh.remove(); vello.teardown();
    });

    await test('close and teardown leave no producers or reservations', async () => {
      triangle.close();
      h.module.teardown();
      const d = diagnostics();
      notes.final = d;
      assert(d[1] === 0 && d[2] === 0 && d[3] === 0, 'producers/pixels/index empty: ' + d);
    });
  } finally { notes.hostErrors = h.errors; h.cleanup(); }
}

/** ?expect=view: headed manual check. Mounts one triangle and keeps it on screen; shows live
 *  diagnostics (also copyable as JSON). No automated checks and no pixel readback. */
async function view() {
  const out = document.getElementById('out')!;
  const h = setup();
  h.wrapper.style.cssText = 'width:400px;height:300px;border:1px solid #888';
  const info: Record<string, unknown> = {secureContext: isSecureContext, userAgent: navigator.userAgent, navigatorGpu: 'gpu' in navigator};
  try {
    const gpu = (navigator as any).gpu;
    const adapter = gpu && await gpu.requestAdapter();
    info.jsAdapter = adapter ? {vendor: adapter.info?.vendor, architecture: adapter.info?.architecture,
      device: adapter.info?.device, description: adapter.info?.description, isFallbackAdapter: adapter.info?.isFallbackAdapter} : null;
  } catch (e) { info.jsAdapter = 'requestAdapter threw: ' + e; }
  const triangle = h.module.create();
  h.mount(triangle.surfaceKey());
  const button = document.createElement('button');
  button.textContent = 'Copy diagnostics JSON';
  const snapshot = () => JSON.stringify({...info, stats: triangle.stats(), hostErrors: h.errors,
    canvas: {width: h.canvas.width, height: h.canvas.height}, at: new Date().toISOString()}, null, 2);
  button.onclick = () => navigator.clipboard.writeText(snapshot()).catch(() => {});
  document.body.insertBefore(button, out);
  const tick = () => { out.textContent = 'Expected: an orange triangle on a black background in the box below.\n' + snapshot(); };
  tick(); setInterval(tick, 500);
  (globalThis as any).rnrDiagnostics = snapshot;
}

async function main() {
  await init({module_or_path: new URL('../rnr/pkg/rnr_bundle_bg.wasm', import.meta.url)});
  notes.userAgent = navigator.userAgent;
  notes.navigatorGpu = 'gpu' in navigator;
  if (expect === 'unsupported') await unsupported();
  else if (expect === 'webgpu') await webgpu();
  else if (expect === 'view') { await view(); return; }
  else checks.push({name: 'expect query', ok: false, detail: 'missing ?expect='});
}
main().catch(error => checks.push({name: 'main', ok: false, detail: String(error)})).finally(() => {
  if (expect === 'view' && !checks.length) return;
  const ok = checks.length > 0 && checks.every(c => c.ok);
  const blocked = typeof notes.blocked === 'string' ? notes.blocked : undefined;
  (globalThis as any).__rnrResult = {ok, blocked, checks, notes,
    label: (expect === 'webgpu' ? 'software WebGPU (SwiftShader, --enable-unsafe-webgpu, test only); correctness only, no GPU performance claim' : 'default launch') +
      (blocked ? '; prototype: visible presentation unproven (BLOCKED)' : '')};
  document.getElementById('out')!.textContent = JSON.stringify((globalThis as any).__rnrResult, null, 2);
});
