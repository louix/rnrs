// Bevy (packages/bevy3d) on @rnrs/surface's browser WebGPU presentation.
// ?expect=view (default): quiet headed check (View.tsx): one persistent cube with the consumer
//   app's controls; resize, unmount/remount and the in-app sequence (unchanged smoke.ts) run only
//   on explicit buttons. Live diagnostics, persisted log. Nothing here proves display.
// ?expect=app: the unchanged consumer app (fixtures/bevy-consumer/App.tsx), which runs its
//   in-app sequence automatically on load. Explicit opt-in only.
// ?expect=unsupported: default headless launch (no adapter): terminal, reported, no fallback.
// ?expect=webgpu: test-only SwiftShader launch: Bevy setup and lifecycle, bounded; software
//   WebGPU is correctness evidence only.
import React from 'react';
import {createRoot} from 'react-dom/client';
import init, * as wasm from './rnr/pkg/rnr_bundle.js';
import {installWebBackend, type RnrWasm} from '@rnrs/runtime/web';
import {createSurfaceBootstrap} from '@rnrs/surface/browser';
import {createBevy3DModuleForTesting} from '../../.generated/rnr/rnr_bevy3d';
import App from './.generated/app/App';
import QuietView from './View';
import type {Scene} from '@rnrs/example-bevy3d';

const expect = new URLSearchParams(location.search).get('expect') ?? 'view';
const checks: {name: string; ok: boolean; detail: string}[] = [];
const notes: Record<string, unknown> = {expect};
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const frames = (n = 1) => new Promise<void>(resolve => {
  const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step)); requestAnimationFrame(step);
});
async function until(what: string, condition: () => boolean, ms = 10_000) {
  const end = performance.now() + ms;
  while (!condition()) { if (performance.now() > end) throw new Error('timed out: ' + what); await frames(); }
}
async function test(name: string, run: () => Promise<void>) {
  try { await run(); checks.push({name, ok: true, detail: ''}); }
  catch (error) { checks.push({name, ok: false, detail: String(error)}); }
}
const surfaceDiagnostics = () => {
  const [live, owners, pixels, entries] = Array.from(wasm.rnr_surface_diagnostics()) as number[];
  return {live, owners, pixels, entries};
};
const bevyDiagnostics = () => {
  const [initsStarted, initsDiscarded, devicesCreated, devicesDestroyed, gpuStatesAlive, scenesOpen] =
    Array.from((wasm as any).rnr_bevy3d_web_diagnostics()) as number[];
  return {initsStarted, initsDiscarded, devicesCreated, devicesDestroyed, gpuStatesAlive, scenesOpen};
};
async function jsAdapter() {
  try {
    const gpu = (navigator as any).gpu;
    const adapter = gpu && await gpu.requestAdapter();
    return adapter ? {vendor: adapter.info?.vendor, architecture: adapter.info?.architecture, device: adapter.info?.device,
      description: adapter.info?.description, isFallbackAdapter: adapter.info?.isFallbackAdapter} : null;
  } catch (e) { return 'requestAdapter threw: ' + e; }
}

/** Direct API harness (no React): one scene on a canvas mounted through the surface host. */
function harness() {
  let boot!: ReturnType<typeof createSurfaceBootstrap>;
  const backend = installWebBackend(wasm as unknown as RnrWasm, same => boot = createSurfaceBootstrap(same));
  const module = createBevy3DModuleForTesting(8);
  const wrapper = document.createElement('div'), canvas = document.createElement('canvas');
  wrapper.style.cssText = 'width:320px;height:240px';
  canvas.style.cssText = 'width:100%;height:100%;display:block';
  wrapper.append(canvas); document.body.append(wrapper);
  const errors: string[] = [];
  const mount = (key: number) => boot.host.mount(canvas, wrapper, key, e => errors.push(String(e)));
  return {module, canvas, errors, mount, cleanup() { backend.dispose(); wrapper.remove(); }};
}

async function unsupported() {
  const h = harness();
  try {
    await test('default launch: WebGPU unavailable is a terminal, reported failure with no fallback or retries', async () => {
      const scene = h.module.create();
      const mount = h.mount(scene.surfaceKey());
      assert(mount.presentation === 'webgpu', 'host selected the WebGPU presentation');
      await until('failure', () => scene.stats().gpuState === 'failed');
      await sleep(1500);
      const st = scene.stats(), d = bevyDiagnostics();
      notes.unsupported = {stats: st, errors: h.errors, bevy: d};
      assert(st.lastError?.startsWith('WebGPU unsupported'), 'clear unsupported error: ' + st.lastError);
      assert(h.errors.length === 1 && h.errors[0].includes('WebGPU unsupported'), 'reported once: ' + JSON.stringify(h.errors));
      assert(d.initsStarted === 1 && d.devicesCreated === 0, 'no automatic retries, no device: ' + JSON.stringify(d));
      assert(st.framesPresented === 0 && st.state === 'detached', 'nothing drawn, attachment released');
      assert(h.canvas.getContext('2d') === null, 'no Canvas 2D fallback on the WebGPU canvas');
      mount.refresh();
      await until('explicit reattach fails again', () => bevyDiagnostics().initsStarted === 2 && scene.stats().gpuState === 'failed');
      assert(h.errors.length === 2, 'explicit refresh retries exactly once');
      mount.dispose(); scene.close();
      const after = bevyDiagnostics();
      assert(after.scenesOpen === 0 && after.gpuStatesAlive === 0, 'closed: ' + JSON.stringify(after));
    });
  } finally { h.cleanup(); }
}

async function webgpu() {
  const h = harness();
  try {
    const scene = h.module.create();
    const key = scene.surfaceKey();
    let mount = h.mount(key);
    await test('software adapter: asynchronous setup builds a device, configures the canvas and creates the Bevy app', async () => {
      assert(scene.stats().gpuState === 'initializing', 'initializing while setup is asynchronous: ' + scene.stats().gpuState);
      await until('setup finished', () => scene.stats().gpuState !== 'initializing', 60_000);
      const st = scene.stats();
      notes.setup = {stats: st, bevy: bevyDiagnostics()};
      assert(st.gpuState === 'warming' || st.gpuState === 'ready', 'Bevy running: ' + st.gpuState + ' ' + st.lastError);
      assert(st.presentation.includes('Fifo') && st.deviceInitMs > 0 && st.firstUpdateMs > 0, 'configured: ' + st.presentation);
      const preferred = (navigator as any).gpu.getPreferredCanvasFormat() as string;
      notes.preferredCanvasFormat = preferred;
      assert(st.presentation.toLowerCase().startsWith(preferred + ' '), 'configured with the preferred canvas format ' + preferred + ': ' + st.presentation);
      assert(h.canvas.width === Math.round(320 * devicePixelRatio), 'backing size from the host extent');
    });
    await test('bounded: Bevy cube pipeline readiness or a terminal, reported failure (no retry)', async () => {
      await until('ready or failed', () => ['ready', 'failed'].includes(scene.stats().gpuState), 30_000);
      const st = scene.stats();
      notes.readiness = {stats: st, errors: [...h.errors], bevy: bevyDiagnostics()};
      if (st.gpuState === 'failed') {
        // Known for this headless SwiftShader Chromium (fixtures/web-webgpu/README.md): the device
        // is reported destroyed shortly after the first canvas submits. Not reinvestigated here.
        notes.blocked = 'visible presentation and readiness: ' + st.lastError;
        const inits = bevyDiagnostics().initsStarted;
        await sleep(800);
        assert(bevyDiagnostics().initsStarted === inits && scene.stats().state === 'detached', 'no automatic retry; attachment released');
        assert(h.errors.length === 1, 'reported once: ' + JSON.stringify(h.errors));
      } else {
        assert(st.framesPresented > 0 && st.lastError === null, 'ready after submits: ' + JSON.stringify(st));
      }
    });
    mount.dispose(); await frames(2);
    await test('unmount detaches, drops the Bevy app and destroys the device', async () => {
      const d = bevyDiagnostics();
      assert(scene.stats().state === 'detached' && scene.stats().gpuState !== 'ready', 'detached: ' + scene.stats().gpuState);
      const context = h.canvas.getContext('webgpu') as any;
      if (typeof context?.getConfiguration === 'function') assert(context.getConfiguration() === null, 'canvas context unconfigured after the installed GPU state was dropped');
      else notes.unconfigureUnchecked = 'GPUCanvasContext.getConfiguration unavailable';
      assert(d.gpuStatesAlive === 0 && d.devicesCreated === d.devicesDestroyed, 'no GPU state kept: ' + JSON.stringify(d));
    });
    await test('late setups after detach and after replacement are discarded and keep no device or Bevy app', async () => {
      const before = bevyDiagnostics();
      const token = wasm.rnr_surface_attach(key, 64, 48, 1) as number;
      assert(token > 0, 'attached');
      const scratch = document.createElement('canvas');
      assert(wasm.rnr_surface_bind_canvas(key, token, scratch) === 'ok', 'bound');
      wasm.rnr_surface_detach(key, token);
      assert(scene.stats().gpuState === 'none', 'detach ends setup state at once: ' + scene.stats().gpuState);
      const second = wasm.rnr_surface_attach(key, 64, 48, 1) as number;
      assert(wasm.rnr_surface_bind_canvas(key, second, document.createElement('canvas')) === 'ok', 'rebound');
      assert(wasm.rnr_surface_attach(key, 64, 48, 1) === 0, 'authority refuses a concurrent attachment');
      wasm.rnr_surface_detach(key, second);
      await until('stale setups discarded', () => bevyDiagnostics().initsDiscarded >= before.initsDiscarded + 2, 20_000);
      await sleep(500);
      const d = bevyDiagnostics();
      notes.stale = {before, after: d};
      assert(d.gpuStatesAlive === 0 && d.devicesCreated === d.devicesDestroyed, 'devices destroyed: ' + JSON.stringify(d));
      assert(scene.stats().gpuState === 'none', 'nothing kept from stale setups');
      assert(wasm.rnr_surface_render(key, second, true).status === 'stale', 'old token rejected');
    });
    await test('runtime teardown during setup closes the scene and leaves no GPU state', async () => {
      const other = createBevy3DModuleForTesting(8);
      const s = other.create();
      const k = s.surfaceKey();
      const token = wasm.rnr_surface_attach(k, 32, 32, 1) as number;
      assert(wasm.rnr_surface_bind_canvas(k, token, document.createElement('canvas')) === 'ok', 'bound');
      other.teardown();
      assert(wasm.rnr_surface_render(k, token, true).status === 'closed', 'closed by teardown');
      await sleep(1500); // the in-flight setup settles; it must destroy its device, not keep it
      const d = bevyDiagnostics();
      notes.teardown = d;
      assert(d.gpuStatesAlive === 0 && d.devicesCreated === d.devicesDestroyed && d.scenesOpen === 1, 'released: ' + JSON.stringify(d));
    });
    await test('close and teardown leave no scenes, producers or reservations', async () => {
      scene.close(); h.module.teardown();
      const d = bevyDiagnostics(), s = surfaceDiagnostics();
      notes.final = {bevy: d, surface: s};
      assert(d.scenesOpen === 0 && d.gpuStatesAlive === 0 && s.owners === 0 && s.pixels === 0 && s.entries === 0, JSON.stringify(notes.final));
    });
  } finally { notes.hostErrors = h.errors; h.cleanup(); }
}


const LOG_KEY = 'rnr-web-bevy-log';
const LOG_MAX = 300;
/** ?expect=view (quiet, default) and ?expect=app (the unchanged consumer app, which runs its
 *  in-app sequence automatically on load: explicit opt-in only). Live diagnostics with a copy
 *  button; every phase change and action is also written to localStorage at once, so the log of
 *  a session that crashed can be copied after reopening the page. */
async function view(app: boolean) {
  const reports: Record<string, unknown> = {smokeChecks: []};
  const hostErrors: string[] = [];
  const previous = (() => { try { return JSON.parse(localStorage.getItem(LOG_KEY) ?? 'null'); } catch { return null; } })();
  const events: {t: number; event: string; detail?: unknown}[] = [];
  const session = {startedAt: new Date().toISOString(), mode: expect, events};
  const t0 = performance.now();
  const record = (event: string, detail?: unknown) => {
    events.push({t: Math.round(performance.now() - t0), event, detail});
    if (events.length > LOG_MAX) events.splice(0, events.length - LOG_MAX);
    try { localStorage.setItem(LOG_KEY, JSON.stringify(session)); } catch {}
  };
  const log = console.log.bind(console), error = console.error.bind(console);
  console.log = (...args: unknown[]) => {
    const text = String(args[0]);
    const json = (tag: string) => text.startsWith(tag + ' ') ? JSON.parse(text.slice(tag.length + 1)) : undefined;
    try {
      const stats = json('RNR_BEVY_STATS'), smoke = json('RNR_SMOKE'), check = json('RNR_SMOKE_CHECK');
      if (stats) reports.latestStats = stats;
      if (smoke) { reports.smoke = smoke; record('sequence result', smoke); }
      if (check) (reports.smokeChecks as unknown[]).push({i: check.i, name: check.name, ok: check.ok});
    } catch {}
    log(...args);
  };
  console.error = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    hostErrors.push(text); record('error', text); error(...args);
  };
  installWebBackend(wasm as unknown as RnrWasm, createSurfaceBootstrap);
  const gpu = (navigator as any).gpu;
  const info: Record<string, unknown> = {url: location.href, secureContext: isSecureContext, userAgent: navigator.userAgent,
    navigatorGpu: !!gpu, preferredCanvasFormat: gpu?.getPreferredCanvasFormat?.() ?? null, jsAdapter: await jsAdapter()};
  try { info.build = await (await fetch(new URL('./build-info.json', import.meta.url), {cache: 'no-store'})).json(); }
  catch (e) { info.build = 'unavailable: ' + e; }
  record('page loaded', {build: info.build, preferredCanvasFormat: info.preferredCanvasFormat});
  let scene: Scene | undefined;
  createRoot(document.getElementById('root')!).render(app ? <App /> : <QuietView log={record} onScene={s => { scene = s; }} onActions={a => { (globalThis as any).rnrActions = a; }} />);
  const out = document.getElementById('out')!;
  const snapshot = () => JSON.stringify({...info, ...reports, stats: scene?.stats(), hostErrors, bevy: bevyDiagnostics(),
    surface: surfaceDiagnostics(), canvas: Array.from(document.querySelectorAll('canvas')).map(c => ({width: c.width, height: c.height})),
    session, previousSession: previous, at: new Date().toISOString()}, null, 2);
  const button = document.createElement('button');
  button.textContent = 'Copy diagnostics JSON (includes the previous session log)';
  button.onclick = () => navigator.clipboard.writeText(snapshot()).catch(e => { out.textContent = 'copy failed: ' + e + '\n' + snapshot(); });
  document.getElementById('diag')!.insertBefore(button, out);
  const tick = () => {
    out.textContent = (app
      ? 'Unchanged consumer app: its in-app sequence (pause, blue, resize, unmount, remount) runs automatically.\n'
      : 'Quiet view: one lit cube should rotate under the TSX overlay. Nothing runs automatically; the buttons below the surface are opt-in.\n') +
      'gpuState "ready" and submitted frames are not proof of display: only what you see is.\n' + snapshot();
  };
  tick(); setInterval(tick, 1000);
  (globalThis as any).rnrDiagnostics = snapshot;
}

async function main() {
  await init({module_or_path: new URL('../rnr/pkg/rnr_bundle_bg.wasm', import.meta.url)});
  notes.userAgent = navigator.userAgent;
  notes.navigatorGpu = 'gpu' in navigator;
  if (expect === 'unsupported') await unsupported();
  else if (expect === 'webgpu') await webgpu();
  else if (expect === 'view' || expect === 'app') { await view(expect === 'app'); return; }
  else if (expect === 'log') { document.getElementById('out')!.textContent = localStorage.getItem('rnr-web-bevy-log') ?? 'no persisted log'; return; } // no GPU use
  else checks.push({name: 'expect query', ok: false, detail: 'unknown ?expect=' + expect});
}
main().catch(error => checks.push({name: 'main', ok: false, detail: String(error)})).finally(() => {
  if ((expect === 'view' || expect === 'app' || expect === 'log') && !checks.length) return;
  const ok = checks.length > 0 && checks.every(c => c.ok);
  const blocked = typeof notes.blocked === 'string' ? notes.blocked : undefined;
  (globalThis as any).__rnrResult = {ok, blocked, checks, notes,
    label: (expect === 'webgpu' ? 'software WebGPU (SwiftShader, --enable-unsafe-webgpu, test only); correctness only, no GPU performance claim' : 'default launch') +
      (blocked ? '; visible presentation unproven (BLOCKED)' : '')};
  document.getElementById('out')!.textContent = JSON.stringify((globalThis as any).__rnrResult, null, 2);
});
