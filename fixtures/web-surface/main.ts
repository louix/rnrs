import init, * as wasm from './rnrs/pkg/rnrs_bundle.js';
import { installWebBackend, initRnrs, type RnrsWasm } from '@rnrs/runtime/web';
import { createSurfaceBootstrap } from '@rnrs/surface/browser';
import { createVello2DModuleForTesting } from '../../.generated/rnrs/rnrs_vello2d';
import { FrameWriter } from '../../packages/vello2d/frame';

const checks: { name: string; ok: boolean; detail: string }[] = [];
const samples: { name: string; ms: number }[] = [];
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const frame = (color: readonly [number, number, number, number]) =>
  new FrameWriter().clear(color).finish();
const nextFrames = async () => {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
};
const stats = () => Array.from(wasm.rnrs_surface_diagnostics()) as number[];
let memory: WebAssembly.Memory;
async function test(
  name: string,
  run: (h: ReturnType<typeof setup>) => void | Promise<void>,
  deferredRelease = false,
) {
  const h = setup(deferredRelease);
  try {
    await run(h);
    checks.push({ name, ok: true, detail: '' });
  } catch (e) {
    checks.push({ name, ok: false, detail: String(e) });
  } finally {
    h.backend.dispose();
    h.wrapper.remove();
    const d = stats();
    if (d[1] || d[2] || d[3])
      checks.push({ name: name + ' cleanup', ok: false, detail: JSON.stringify(d) });
  }
}
function setup(deferredRelease = false) {
  let boot!: ReturnType<typeof createSurfaceBootstrap>;
  const bundle = deferredRelease
    ? {
        ...wasm,
        rnrs_surface_set_release_listener(
          listener: ((key: number, token: number) => void) | undefined,
        ) {
          wasm.rnrs_surface_set_release_listener(
            listener
              ? (key: number, token: number) => queueMicrotask(() => listener(key, token))
              : undefined,
          );
        },
      }
    : wasm;
  const backend = installWebBackend(
    bundle as unknown as RnrsWasm,
    (instances) => (boot = createSurfaceBootstrap(instances)),
  );
  const module = createVello2DModuleForTesting(8);
  const renderer = module.create({ resolutionScale: 1, timingRecords: 16 });
  const key = renderer.surfaceKey();
  const wrapper = document.createElement('div'),
    canvas = document.createElement('canvas');
  wrapper.style.cssText = 'width:32px;height:24px';
  canvas.style.cssText = 'width:100%;height:100%';
  wrapper.append(canvas);
  document.body.append(wrapper);
  return { backend, boot, module, renderer, key, wrapper, canvas };
}
function attach(key: number, width = 8, height = 8) {
  const token = wasm.rnrs_surface_attach(key, width, height, 1);
  assert(typeof token === 'number' && token > 0, 'attachment acquired');
  return token;
}
function pixels(key: number, token: number, redraw = true) {
  const p = wasm.rnrs_surface_render(key, token, redraw);
  assert(p.status === 'pixels', 'expected pixels: ' + p.status);
  return p as { status: 'pixels'; width: number; height: number; pixels: Uint8Array };
}
async function main() {
  const exports = await init({
    module_or_path: new URL('../rnrs/pkg/rnrs_bundle_bg.wasm', import.meta.url),
  });
  memory = exports.memory;
  const publicBundle = { ...wasm, default: async () => exports };
  const initializing = initRnrs(publicBundle as any, undefined, {
    bootstrap: createSurfaceBootstrap,
  });
  assert(
    initializing ===
      initRnrs(publicBundle as any, undefined, { bootstrap: createSurfaceBootstrap }),
    'public init shares initialization',
  );
  await initializing;
  const firstModule = createVello2DModuleForTesting(8),
    first = firstModule.create({ resolutionScale: 1, timingRecords: 0 });
  first.submit(frame([1, 0, 0, 1]));
  assert(
    pixels(first.surfaceKey(), attach(first.surfaceKey())).pixels[0] === 255,
    'public bootstrap seam renders real generated module',
  );
  firstModule.teardown();
  checks.push({
    name: 'public initRnrs optional surface bootstrap shares the real bundle',
    ok: true,
    detail: '',
  });
  await test('same generated bundle decodes, blends opaque pixels and returns owned copies', (h) => {
    const token = attach(h.key);
    h.renderer.submit(
      new FrameWriter().clear([0, 0, 1, 1]).rect(0, 0, 8, 8, [1, 0, 0, 0.5]).finish(),
    );
    const p = pixels(h.key, token);
    assert(p.pixels.buffer !== memory.buffer, 'owned JS allocation, not borrowed Wasm memory');
    assert(
      Math.abs(p.pixels[0] - 128) <= 2 && Math.abs(p.pixels[2] - 127) <= 2,
      'alpha blend over blue',
    );
    assert(
      p.pixels.every((v, i) => i % 4 !== 3 || v === 255),
      'opaque alpha invariant',
    );
    const saved = Array.from(p.pixels);
    memory.grow(1);
    assert(
      saved.every((v, i) => p.pixels[i] === v),
      'owned bytes survive memory growth',
    );
    p.pixels[0] = 0;
    assert(pixels(h.key, token).pixels[0] > 120, 'copy mutation does not alter Rust raster');
    h.renderer.close();
    assert(p.pixels.length === 256, 'owned copy survives renderer disposal');
    assert(
      wasm.rnrs_surface_render(h.key, token, true).status === 'closed',
      'closed authority checked',
    );
  });
  await test('latest frame wins and invalid commands preserve last valid scene', (h) => {
    const token = attach(h.key);
    h.renderer.submit(frame([1, 0, 0, 1]));
    h.renderer.submit(frame([0, 1, 0, 1]));
    assert(
      pixels(h.key, token).pixels[1] === 255 && h.renderer.stats().framesReplaced === 1,
      'latest inbox',
    );
    h.renderer.submit(new Float32Array([99, 0]).buffer);
    assert(
      pixels(h.key, token).pixels[1] === 255 && h.renderer.stats().framesInvalid === 1,
      'invalid frame retained scene',
    );
    assert(
      wasm.rnrs_surface_render(h.key, token, false).status === 'unchanged',
      'no duplicate presentation',
    );
    const st = h.renderer.stats();
    assert(
      st.presentation === 'canvas2d' && st.renderThreadsAlive === 0 && st.ownedByRuntime,
      'shared stats truthful',
    );
    assert(
      new DataView(h.renderer.drainTimings()).getUint32(8, true) > 0,
      'browser monotonic timing records',
    );
  });
  await test('authoritative first-wins attachment, stale tokens and resize', (h) => {
    const old = attach(h.key);
    assert(wasm.rnrs_surface_attach(h.key, 8, 8, 1) === 0, 'first attachment wins');
    wasm.rnrs_surface_detach(h.key, old);
    const current = attach(h.key, 10, 12);
    assert(current !== old, 'fresh token');
    wasm.rnrs_surface_detach(h.key, old);
    assert(
      wasm.rnrs_surface_render(h.key, old, true).status === 'stale',
      'stale callback rejected',
    );
    assert(
      wasm.rnrs_surface_resize(h.key, old, 20, 24, 2) === 'stale',
      'stale resize is expected status',
    );
    assert(wasm.rnrs_surface_resize(h.key, current, 20, 24, 2) === 'ok', 'current resize succeeds');
    h.renderer.submit(frame([1, 0, 0, 1]));
    const p = pixels(h.key, current);
    assert(p.width === 20 && p.height === 24 && h.renderer.stats().scale === 2, 'resize and DPR');
  });
  await test('real DOM canvas draws, resizes, suspends at zero and unmounts', async (h) => {
    h.renderer.submit(frame([1, 0, 0, 1]));
    const mount = h.boot.host.mount(h.canvas, h.wrapper, h.key);
    await nextFrames();
    assert(
      h.canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data[0] === 255,
      'actual red canvas',
    );
    h.wrapper.style.width = '48px';
    await nextFrames();
    assert(
      h.renderer.stats().surfaceWidth === Math.round(48 * devicePixelRatio),
      'actual RO resize',
    );
    h.wrapper.style.width = '0px';
    await nextFrames();
    assert(
      h.renderer.stats().state === 'detached' && h.canvas.width === 0,
      'zero clears and detaches',
    );
    h.wrapper.style.width = '32px';
    await nextFrames();
    assert(h.renderer.stats().state === 'attached', 'positive extent reattaches');
    mount.dispose();
    await nextFrames();
    assert(
      h.renderer.stats().state === 'detached' && stats()[2] === 0,
      'unmount frees raster reservation',
    );
  });
  await test('page lifecycle and context restoration reraster current scene', async (h) => {
    h.renderer.submit(frame([1, 0, 0, 1]));
    const mount = h.boot.host.mount(h.canvas, h.wrapper, h.key);
    await nextFrames();
    window.dispatchEvent(new Event('pagehide'));
    assert(h.renderer.stats().state === 'detached', 'pagehide authoritative detach');
    window.dispatchEvent(new Event('pageshow'));
    await nextFrames();
    assert(h.renderer.stats().attaches === 2, 'pageshow fresh attach');
    h.canvas.dispatchEvent(new Event('contextlost', { cancelable: true }));
    h.renderer.submit(frame([0, 1, 0, 1]));
    h.canvas.dispatchEvent(new Event('contextrestored'));
    await nextFrames();
    assert(
      h.canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data[1] === 255,
      'restore current pixels',
    );
    mount.dispose();
  });
  await test('waiting real bridge mount attaches after owner release', async (h) => {
    h.renderer.submit(frame([0, 0, 1, 1]));
    const first = h.boot.host.mount(h.canvas, h.wrapper, h.key);
    const secondCanvas = document.createElement('canvas');
    h.wrapper.append(secondCanvas);
    const errors: unknown[] = [];
    const second = h.boot.host.mount(secondCanvas, h.wrapper, h.key, (e) => errors.push(e));
    assert(errors.length === 1, 'busy reported once');
    first.dispose();
    await new Promise((r) => setTimeout(r, 150));
    await nextFrames();
    assert(
      secondCanvas.width > 0 &&
        secondCanvas.getContext('2d')!.getImageData(0, 0, 1, 1).data[2] === 255,
      'release/retry recovers without author refresh',
    );
    second.dispose();
  });
  await test('external bridge release wakes a mount after its bounded retries exhaust', async (h) => {
    const token = attach(h.key);
    h.renderer.submit(frame([0, 1, 0, 1]));
    const errors: unknown[] = [];
    h.boot.host.mount(h.canvas, h.wrapper, h.key, (e) => errors.push(e));
    await new Promise((r) => setTimeout(r, 2100));
    assert(
      h.renderer.stats().refusedAttaches === 5 && errors.length === 1,
      'bounded attempts exhausted',
    );
    wasm.rnrs_surface_detach(h.key, token); // no first CanvasMount; notification comes from Wasm
    await new Promise((r) => setTimeout(r, 30));
    await nextFrames();
    assert(
      h.canvas.width > 0 && h.canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data[1] === 255,
      'Wasm release notification recovered waiting host',
    );
  });
  await test('visibility detach and fresh attach preserve real Rust lifecycle', async (h) => {
    h.renderer.submit(frame([0, 0, 1, 1]));
    h.boot.host.mount(h.canvas, h.wrapper, h.key);
    await nextFrames();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      assert(h.renderer.stats().state === 'detached' && stats()[2] === 0, 'hidden releases raster');
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      await nextFrames();
      assert(h.renderer.stats().attaches === 2, 'visible fresh attachment');
    } finally {
      delete (document as any).visibilityState;
    }
  });
  await test('four-owner cap rejects create without orphan key and releases on close', (h) => {
    const held = [
      h.renderer,
      ...Array.from({ length: 3 }, () => h.module.create({ resolutionScale: 1 })),
    ];
    const before = stats();
    let refused = false;
    try {
      h.module.create({ resolutionScale: 1 });
    } catch {
      refused = true;
    }
    assert(
      refused && JSON.stringify(stats()) === JSON.stringify(before),
      'no unregistered orphan after failed create',
    );
    held[0].close();
    const replacement = h.module.create({ resolutionScale: 1 });
    assert(stats()[1] === 4, 'closed resource slot reused even with retained wrapper');
    replacement.close();
    held.forEach((r) => r.close());
  });
  await test('aggregate pixel admission and failed resize never over-reserve', (h) => {
    const second = h.module.create({ resolutionScale: 1 }),
      third = h.module.create({ resolutionScale: 1 });
    const firstToken = attach(h.key, 2048, 2048),
      secondToken = attach(second.surfaceKey(), 2048, 2048);
    assert(stats()[2] === 8_388_608, 'exact aggregate pixel cap');
    let refused = false;
    try {
      attach(third.surfaceKey(), 1, 1);
    } catch {
      refused = true;
    }
    assert(refused && stats()[2] === 8_388_608, 'third allocation refused');
    let resizeFailed = false;
    try {
      wasm.rnrs_surface_resize(h.key, firstToken, 4096, 4096, 1);
    } catch {
      resizeFailed = true;
    }
    assert(resizeFailed && stats()[2] === 4_194_304, 'old raster freed before failed reservation');
    wasm.rnrs_surface_detach(h.key, firstToken);
    wasm.rnrs_surface_detach(second.surfaceKey(), secondToken);
    assert(stats()[2] === 0, 'all raster storage released');
    second.close();
    third.close();
  });
  await test('real host clears old pixels on oversized raster admission failure', async (h) => {
    h.renderer.submit(frame([1, 0, 0, 1]));
    const errors: unknown[] = [];
    const mount = h.boot.host.mount(h.canvas, h.wrapper, h.key, (e) => errors.push(e));
    await nextFrames();
    assert(h.canvas.width > 0, 'initial image exists');
    h.wrapper.style.width = '4096px';
    h.wrapper.style.height = '4096px';
    await nextFrames();
    assert(
      h.canvas.width === 0 && h.canvas.height === 0 && errors.length === 1,
      'failure clears instead of stretching stale image',
    );
    assert(
      stats()[2] === 0 && h.renderer.stats().state === 'detached',
      'failed reservation released',
    );
    h.wrapper.style.width = '32px';
    h.wrapper.style.height = '24px';
    await nextFrames();
    assert(h.canvas.width > 0, 'meaningful smaller extent automatically recovers');
    mount.dispose();
  });
  await test('module teardown closes its renderer while another module keeps rendering', async (h) => {
    h.renderer.submit(frame([1, 0, 0, 1]));
    h.boot.host.mount(h.canvas, h.wrapper, h.key);
    await nextFrames();
    const other = createVello2DModuleForTesting(8);
    const otherRenderer = other.create({ resolutionScale: 1, timingRecords: 0 });
    const otherCanvas = document.createElement('canvas');
    h.wrapper.append(otherCanvas);
    const otherMount = h.boot.host.mount(otherCanvas, h.wrapper, otherRenderer.surfaceKey());
    otherRenderer.submit(frame([0, 1, 0, 1]));
    await nextFrames();
    h.module.teardown();
    await nextFrames();
    assert(otherCanvas.width > 0 && stats()[1] === 1, 'another module keeps its host and producer');
    otherMount.dispose();
    other.teardown();
    otherCanvas.remove();
    assert(
      h.canvas.width === 0 && stats()[1] === 0 && stats()[2] === 0 && stats()[3] === 0,
      'host and resources cleaned',
    );
    assert(
      wasm.rnrs_surface_attach(h.key, 8, 8, 1) === 'closed',
      'retained wrapper cannot reattach',
    );
    assert(
      wasm.rnrs_surface_resize(h.key, 1, 8, 8, 1) === 'closed',
      'closed resize does not throw',
    );
    let refused = false;
    try {
      h.renderer.submit(frame([0, 1, 0, 1]));
    } catch {
      refused = true;
    }
    assert(refused, 'retired adapter refuses retained wrapper');
  });
  await test('backend replacement invalidates old canvas epoch and closes resources', async (h) => {
    h.renderer.submit(frame([1, 0, 0, 1]));
    h.boot.host.mount(h.canvas, h.wrapper, h.key);
    const replacement = installWebBackend(wasm as unknown as RnrsWasm, (instances) =>
      createSurfaceBootstrap(instances),
    );
    try {
      await nextFrames();
      assert(
        h.canvas.width === 0 && stats()[1] === 0,
        'replacement closes old host before retained RAF',
      );
      assert(wasm.rnrs_surface_attach(h.key, 8, 8, 1) === 'closed', 'old key is terminal');
      let refused = false;
      try {
        h.renderer.submit(frame([1, 0, 0, 1]));
      } catch {
        refused = true;
      }
      assert(refused, 'retained old wrapper refuses calls after replacement');
      const module = createVello2DModuleForTesting(8),
        renderer = module.create({ resolutionScale: 1, timingRecords: 0 });
      renderer.submit(frame([0, 1, 0, 1]));
      const nextToken = attach(renderer.surfaceKey());
      assert(
        pixels(renderer.surfaceKey(), nextToken).pixels[1] === 255,
        'replacement instance renders',
      );
      module.teardown();
    } finally {
      replacement.dispose();
    }
  });

  for (const deferred of [false, true])
    for (const failure of ['render', 'putImageData']) {
      await test(
        'persistent ' +
          failure +
          ' with ' +
          (deferred ? 'deferred' : 'synchronous') +
          ' own release stays bounded',
        async (h) => {
          h.renderer.submit(frame([1, 0, 0, 1]));
          let attempts = 0,
            reports = 0;
          const original = h.boot.bridge.render;
          const ctx = h.canvas.getContext('2d')!;
          const originalPut = ctx.putImageData;
          if (failure === 'render')
            h.boot.bridge.render = (...args) => {
              original(...args);
              attempts++;
              throw new Error('persistent render failure');
            };
          else
            ctx.putImageData = () => {
              attempts++;
              throw new Error('persistent Canvas presentation failure');
            };
          const mount = h.boot.host.mount(h.canvas, h.wrapper, h.key, () => {
            reports++;
          });
          try {
            await new Promise((resolve) => setTimeout(resolve, 2300));
            assert(attempts === 5, 'initial attempt plus four retries, got ' + attempts);
            const previous = attempts;
            await new Promise((resolve) => setTimeout(resolve, 150));
            assert(
              attempts === previous && reports === 1,
              'no zero-delay event retry loop; report once',
            );
            assert(
              h.canvas.width === 0 && stats()[2] === 0,
              'failed host clears pixels and releases raster',
            );
          } finally {
            mount.dispose();
            ctx.putImageData = originalPut;
            h.boot.bridge.render = original;
          }
        },
        deferred,
      );
    }
  await test('backend cleanup attempts every adapter and reports failures before replacement publication', () => {
    let teardowns = 0,
      published = false;
    class FailingAdapter extends wasm.RnrsWebAdapter {
      teardown() {
        super.teardown();
        if (++teardowns === 1) throw new Error('adapter cleanup failure');
      }
    }
    const backend = installWebBackend(
      { ...wasm, RnrsWebAdapter: FailingAdapter } as unknown as RnrsWasm,
      () => ({
        dispose() {
          throw new Error('bootstrap cleanup failure');
        },
      }),
    );
    const a = createVello2DModuleForTesting(8),
      b = createVello2DModuleForTesting(8);
    const ra = a.create({ resolutionScale: 1, timingRecords: 0 }),
      rb = b.create({ resolutionScale: 1, timingRecords: 0 });
    const ka = ra.surfaceKey(),
      kb = rb.surfaceKey();
    let error: unknown;
    try {
      installWebBackend(wasm as unknown as RnrsWasm, () => {
        published = true;
        return { dispose() {} };
      });
    } catch (e) {
      error = e;
    }
    assert(
      error instanceof AggregateError && error.errors.length === 2,
      'both cleanup failures reported',
    );
    assert(
      teardowns === 2 && !published,
      'all adapters attempted; replacement bootstrap not started',
    );
    assert(
      wasm.rnrs_surface_attach(ka, 8, 8, 1) === 'closed' &&
        wasm.rnrs_surface_attach(kb, 8, 8, 1) === 'closed',
      'retained renderer keys closed',
    );
    backend.dispose(); // completed disposal is idempotent despite its reported errors
  });
  await test('bootstrap creation rollback is complete and no partial backend is published', () => {
    let rolledBack = 0,
      failed = false;
    try {
      installWebBackend(wasm as unknown as RnrsWasm, (_bundle, rollback) => {
        rollback(() => {
          rolledBack++;
        });
        rollback(() => {
          rolledBack++;
          throw new Error('rollback failure');
        });
        throw new Error('bootstrap creation failure');
      });
    } catch (error) {
      failed = error instanceof AggregateError && error.errors.length === 2;
    }
    assert(
      failed && rolledBack === 2,
      'creation and rollback failures reported; all rollback actions attempted',
    );
    let refused = false;
    try {
      createVello2DModuleForTesting(8);
    } catch {
      refused = true;
    }
    assert(refused, 'previous backend stopped and failed replacement not published');
  });

  await test('post-bootstrap installation failure disposes resources without publication', () => {
    const original = globalThis.FinalizationRegistry;
    let cleaned = 0,
      failed = false;
    try {
      globalThis.FinalizationRegistry = class {
        constructor() {
          throw new Error('registry creation failure');
        }
      } as any;
      try {
        installWebBackend(wasm as unknown as RnrsWasm, () => ({
          dispose() {
            cleaned++;
          },
        }));
      } catch (error) {
        failed = String(error).includes('registry creation failure');
      }
    } finally {
      globalThis.FinalizationRegistry = original;
    }
    assert(
      failed && cleaned === 1,
      'successful bootstrap is disposed after later installation failure',
    );
    let refused = false;
    try {
      createVello2DModuleForTesting(8);
    } catch {
      refused = true;
    }
    assert(refused, 'failed installation did not publish a backend');
  });
  await test('modest scene synchronous raster latency sample', (h) => {
    const token = attach(h.key, 320, 240);
    const writer = new FrameWriter()
      .clear([0, 0, 0, 1])
      .rect(20, 20, 40, 40, [1, 0, 0, 1])
      .circle(80, 80, 20, [0, 1, 0, 1]);
    h.renderer.submit(writer.finish());
    const start = performance.now();
    pixels(h.key, token);
    samples.push({
      name: '320x240 three commands; synchronous bridge raster and owned copy',
      ms: performance.now() - start,
    });
  });
  const result = {
    ok: checks.every((c) => c.ok),
    checks,
    samples,
    userAgent: navigator.userAgent,
    limitation:
      'W1 correctness proof. DOM Canvas and real generated single Wasm bundle; synthetic page/context events. Storage caps do not bound execution time.',
  };
  (globalThis as any).__rnrsResult = result;
  document.querySelector('#out')!.textContent = JSON.stringify(result, null, 2);
}
main().catch((error) => {
  (globalThis as any).__rnrsResult = { ok: false, checks, error: String(error?.stack ?? error) };
});
