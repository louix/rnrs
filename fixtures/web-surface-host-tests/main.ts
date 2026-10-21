import {
  createCanvasHost,
  type CanvasBridge,
  type HostEnvironment,
  browser,
} from '../../packages/surface/src/browser/canvas-host';

const checks: { name: string; ok: boolean; detail: string }[] = [];
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function harness() {
  const canvas = document.createElement('canvas'),
    wrapper = document.createElement('div');
  wrapper.append(canvas);
  document.body.append(wrapper);
  let next = 0,
    token = 0,
    visible = true,
    page = true,
    closed = false,
    rejectResize = false;
  let box = { width: 10, height: 10 },
    ratio = 1,
    now = 0;
  let resize: (box?: { width: number; height: number }) => void = () => {},
    visibility = () => {},
    pageChange: (visible: boolean) => void = () => {};
  const queue = new Map<number, FrameRequestCallback>(),
    timers = new Map<number, () => void>(),
    errors: unknown[] = [];
  const calls = {
    attach: 0,
    detach: 0,
    render: 0,
    resize: 0,
    forced: 0,
    observers: 0,
    measures: 0,
  };
  const env: HostEnvironment = {
    requestFrame(fn) {
      queue.set(++next, fn);
      return next;
    },
    cancelFrame(id) {
      queue.delete(id);
    },
    delay(fn) {
      timers.set(++next, fn);
      return next;
    },
    cancelDelay(id) {
      timers.delete(id);
    },
    now: () => now,
    observe(_, callback) {
      calls.observers++;
      resize = callback;
      return () => {
        calls.observers--;
      };
    },
    measure: () => {
      calls.measures++;
      return box;
    },
    dpr: () => ratio,
    visible: () => visible,
    listenVisibility(callback) {
      visibility = callback;
      return () => {
        visibility = () => {};
      };
    },
    listenPage(callback) {
      pageChange = callback;
      return () => {
        pageChange = () => {};
      };
    },
  };
  const bridge: CanvasBridge = {
    attach() {
      calls.attach++;
      return closed ? 0 : ++token;
    },
    detach() {
      calls.detach++;
    },
    resize() {
      calls.resize++;
      if (rejectResize) throw new Error('pixel budget exhausted');
    },
    render(_, requested, redraw) {
      calls.render++;
      if (closed) return { status: 'closed' };
      if (requested !== token) return { status: 'stale' };
      if (!redraw) return { status: 'unchanged' };
      calls.forced++;
      return {
        status: 'pixels',
        width: 2,
        height: 1,
        pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
      };
    },
  };
  const host = createCanvasHost(bridge, env);
  const mount = host.mount(canvas, wrapper, 1, (error) => errors.push(error));
  return {
    canvas,
    wrapper,
    calls,
    errors,
    host,
    mount,
    queue,
    timers,
    bridge,
    env,
    retry() {
      const item = timers.entries().next().value;
      assert(item, 'expected retry');
      timers.delete(item[0]);
      item[1]();
    },
    tick() {
      const item = queue.entries().next().value;
      assert(item, 'expected RAF');
      queue.delete(item[0]);
      item[1](0);
    },
    advance(ms: number) {
      now += ms;
    },
    observed(width: number, height: number) {
      resize({ width, height });
    },
    setSize(width: number, height: number, dpr = ratio) {
      box = { width, height };
      ratio = dpr;
      resize();
    },
    hidden(value: boolean) {
      visible = !value;
      visibility();
    },
    page(value: boolean) {
      page = value;
      pageChange(page);
    },
    rejectResize(value: boolean) {
      rejectResize = value;
    },
    close() {
      closed = true;
    },
    cleanup() {
      host.dispose();
      wrapper.remove();
    },
  };
}
function test(name: string, run: (h: ReturnType<typeof harness>) => void) {
  const h = harness();
  try {
    run(h);
    checks.push({ name, ok: true, detail: '' });
  } catch (error) {
    checks.push({ name, ok: false, detail: String(error) });
  } finally {
    h.cleanup();
  }
}
test('one pending RAF, owned pixels and no repeated unchanged presentation', (h) => {
  assert(h.queue.size === 1, 'one callback after mount');
  h.mount.refresh();
  h.mount.refresh();
  assert(h.queue.size === 1, 'refresh does not multiply callbacks');
  h.tick();
  assert(h.canvas.width === 2 && h.canvas.height === 1, 'raster backing dimensions');
  const pixel = h.canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data;
  assert(pixel[0] === 255 && pixel[3] === 255, 'actual canvas red pixel');
  h.tick();
  assert(h.calls.forced === 1 && h.queue.size === 1, 'unchanged frame is not re-presented');
});
test('hidden and pagehide detach; resume gets fresh attachment and redraw', (h) => {
  h.tick();
  h.hidden(true);
  assert(h.calls.detach === 1 && h.queue.size === 0, 'hidden cancels and detaches');
  h.hidden(false);
  h.tick();
  assert(h.calls.attach === 2 && h.calls.forced === 2, 'visible reattaches and redraws');
  h.page(false);
  assert(h.queue.size === 0, 'pagehide cancels');
  h.page(true);
  h.tick();
  assert(h.calls.attach === 3, 'pageshow fresh attachment');
});
test('zero extent detaches and positive size resumes', (h) => {
  h.tick();
  h.setSize(0, 10);
  assert(h.canvas.width === 0 && h.queue.size === 0, 'zero extent clears and suspends');
  h.setSize(10, 10);
  h.tick();
  assert(h.calls.attach === 2, 'reattached at positive extent');
});
test('DPR and resize rerasterize, budget failure clears stale canvas', (h) => {
  h.tick();
  h.setSize(10, 10, 2);
  h.tick();
  assert(h.calls.resize === 1 && h.calls.forced === 2, 'DPR resize forces new pixels');
  h.rejectResize(true);
  h.setSize(20, 10);
  h.tick();
  assert(h.canvas.width === 0 && h.canvas.height === 0, 'failed resize has no stale pixels');
  assert(h.errors.length === 1 && h.queue.size === 0, 'failure reported and no retry spin');
  h.rejectResize(false);
  h.setSize(5, 5);
  h.tick();
  assert(h.calls.attach === 2, 'fresh size can recover');
});
test('unmount and shutdown invalidate queued callbacks and disconnect listeners', (h) => {
  const late = [...h.queue.values()][0];
  h.mount.dispose();
  h.mount.dispose();
  late(0);
  assert(h.calls.render === 0 && h.queue.size === 0, 'late callback cannot render');
  assert(h.calls.observers === 0 && h.calls.detach === 1, 'cleanup once');
  h.host.dispose();
  h.host.dispose();
  let refused = false;
  try {
    h.host.mount(h.canvas, h.wrapper, 1);
  } catch {
    refused = true;
  }
  assert(refused, 'disposed backend refuses mounts');
});
test('runtime-closed result cancels RAF and clears pixels', (h) => {
  h.tick();
  h.close();
  h.tick();
  assert(h.queue.size === 0 && h.canvas.width === 0, 'closed runtime stops presentation');
});
test('duplicate canvas ownership is refused', (h) => {
  let refused = false;
  try {
    h.host.mount(h.canvas, h.wrapper, 2);
  } catch {
    refused = true;
  }
  assert(refused, 'same canvas cannot be mounted twice');
});
test('context loss detaches, restoration redraws current generation', (h) => {
  h.tick();
  h.canvas.dispatchEvent(new Event('contextlost', { cancelable: true }));
  assert(h.queue.size === 0 && h.canvas.width === 0, 'loss clears');
  h.canvas.dispatchEvent(new Event('contextrestored'));
  h.tick();
  assert(h.calls.attach === 2 && h.calls.forced === 2, 'restore reattaches and redraws');
});
test('old installer callback cannot render into a replacement host', (h) => {
  const old = [...h.queue.values()][0];
  h.host.dispose();
  const next = createCanvasHost(h.bridge, h.env);
  try {
    next.mount(h.canvas, h.wrapper, 1);
    old(0);
    assert(h.calls.render === 0, 'old epoch ignored');
    h.tick();
    assert(h.calls.render === 1, 'new host renders');
  } finally {
    next.dispose();
  }
});
test('invalid extents fail before the bridge receives resize', (h) => {
  h.tick();
  h.setSize(Number.MAX_VALUE, 10);
  assert(h.errors.length === 1 && h.calls.resize === 0, 'checked physical conversion');
  assert(h.canvas.width === 0, 'invalid size clears');
});
test('invalid bridge token is rejected without detaching an unowned token', (h) => {
  h.mount.dispose();
  const detached = h.calls.detach;
  h.bridge.attach = () => -1;
  h.host.mount(h.canvas, h.wrapper, 1, (error) => h.errors.push(error));
  assert(h.errors.length === 1 && h.calls.detach === detached, 'invalid token never becomes owned');
});

test('resize stays painted until RAF and coalesces intermediate extents', (h) => {
  h.tick();
  h.setSize(11, 11);
  h.setSize(12, 12);
  assert(h.canvas.width === 2 && h.calls.resize === 0, 'no observer-time clear/configure');
  h.tick();
  assert(h.calls.resize === 1, 'one coalesced resize');
});
test('primary render and detach failures are reported without escaping RAF', (h) => {
  h.bridge.render = () => {
    throw new Error('primary');
  };
  h.bridge.detach = () => {
    throw new Error('cleanup');
  };
  h.tick();
  assert(h.errors.length === 1 && h.errors[0] instanceof AggregateError, 'both failures retained');
  assert((h.errors[0] as AggregateError).errors.length === 2, 'primary and cleanup errors');
  assert(h.queue.size === 0 && h.canvas.width === 0, 'failure stops presentation');
});
test('throwing error handler cannot escape or stop cleanup', (h) => {
  h.mount.dispose();
  h.bridge.render = () => {
    throw new Error('primary');
  };
  const saved = console.error;
  console.error = () => {};
  try {
    const mounted = h.host.mount(h.canvas, h.wrapper, 1, () => {
      throw new Error('handler');
    });
    h.tick();
    mounted.dispose();
    assert(h.queue.size === 0 && h.calls.observers === 0, 'handler failure contained');
  } finally {
    console.error = saved;
  }
});
test('busy retry is bounded, automatic and reported once per blocked state', (h) => {
  h.mount.dispose();
  let attempts = 0;
  h.bridge.attach = () => {
    attempts++;
    return 0;
  };
  h.host.mount(h.canvas, h.wrapper, 1, (e) => h.errors.push(e));
  for (let i = 0; i < 4; i++) h.retry();
  assert(attempts === 5 && h.timers.size === 0 && h.errors.length === 1, 'bounded timer retries');
  h.setSize(10, 10);
  assert(attempts === 5, 'unchanged observer notification does not restart');
  h.setSize(12, 12);
  assert(attempts === 6 && h.errors.length === 2, 'meaningful size resets retry window');
  h.hidden(true);
  assert(h.timers.size === 0, 'hidden cancels retry');
  h.hidden(false);
  assert(attempts === 7, 'visibility recovery retries');
  h.page(false);
  h.page(true);
  assert(attempts === 8, 'pageshow recovery retries');
});
test('second mount succeeds after first detach even after timed retries exhaust', (h) => {
  let occupied = true;
  h.bridge.attach = () => (occupied ? 0 : ((occupied = true), 99));
  h.bridge.detach = () => {
    occupied = false;
  };
  const canvas = document.createElement('canvas');
  h.wrapper.append(canvas);
  const other = createCanvasHost(h.bridge, h.env);
  try {
    other.mount(canvas, h.wrapper, 1, (e) => h.errors.push(e));
    for (let i = 0; i < 4; i++) h.retry();
    assert(h.timers.size === 0, 'waiting mount exhausted timers');
    h.mount.dispose();
    h.retry();
    assert(occupied && h.queue.size === 1, 'release notification acquired waiting attachment');
  } finally {
    other.dispose();
    canvas.remove();
  }
});
test('persistent producer errors cannot reset the retry budget by reattaching', (h) => {
  h.bridge.render = () => {
    throw new Error('persistent render failure');
  };
  h.tick();
  for (let i = 0; i < 4; i++) {
    h.retry();
    h.tick();
  }
  assert(
    h.timers.size === 0 && h.queue.size === 0 && h.errors.length === 1,
    'failed reattachments stop after bounded retries and one report',
  );
});
test('closed attach and render results never restart after events', (h) => {
  h.tick();
  h.close();
  h.tick();
  const attempts = h.calls.attach;
  h.setSize(20, 20);
  h.hidden(true);
  h.hidden(false);
  h.mount.refresh();
  assert(h.calls.attach === attempts && h.timers.size === 0, 'closed render terminal');
  h.mount.dispose();
  let closedAttempts = 0;
  h.bridge.attach = () => {
    closedAttempts++;
    return 'closed';
  };
  const mount = h.host.mount(h.canvas, h.wrapper, 1);
  h.setSize(30, 30);
  mount.refresh();
  assert(closedAttempts === 1 && h.timers.size === 0, 'closed attach terminal');
});
test('RAF uses cached geometry without layout measurements', (h) => {
  const initial = h.calls.measures;
  h.tick();
  h.tick();
  h.tick();
  assert(h.calls.measures === initial, 'no measurement per animation frame');
  h.setSize(12, 12);
  assert(h.calls.measures === initial + 1, 'event refreshes geometry cache');
});
test('content measurement excludes transforms padding and borders', (h) => {
  h.wrapper.style.cssText =
    'box-sizing:border-box;width:120px;height:90px;padding:7px;border:3px solid;transform:scale(2)';
  const box = browser.measure(h.wrapper);
  assert(box.width === 100 && box.height === 70, 'untransformed content box');
});
test('canvas ownership extends across host installations', (h) => {
  const other = createCanvasHost(h.bridge, h.env);
  let refused = false;
  try {
    other.mount(h.canvas, h.wrapper, 2);
  } catch {
    refused = true;
  }
  other.dispose();
  assert(refused, 'another live host cannot acquire the same canvas');
});

test('DPR media listener rearms and is removed at cleanup', (h) => {
  const original = window.matchMedia;
  const queries: { query: string; callback?: () => void }[] = [];
  window.matchMedia = ((query: string) => {
    const record: { query: string; callback?: () => void } = { query };
    queries.push(record);
    return {
      addEventListener(_type: string, callback: () => void) {
        record.callback = callback;
      },
      removeEventListener(_type: string, callback: () => void) {
        if (record.callback === callback) record.callback = undefined;
      },
    } as unknown as MediaQueryList;
  }) as typeof matchMedia;
  let stop: (() => void) | undefined;
  try {
    let changes = 0;
    stop = browser.observe(h.wrapper, () => changes++);
    assert(queries.length === 1 && queries[0].query.includes('dppx'), 'resolution query installed');
    queries[0].callback!();
    assert(!queries[0].callback && queries[1].callback && changes === 1, 'listener rearmed');
    stop();
    stop = undefined;
    assert(!queries[1].callback, 'current media listener removed');
  } finally {
    stop?.();
    window.matchMedia = original;
  }
});
test('ResizeObserver supplies fractional content box; initial fallback excludes chrome', (h) => {
  const Original = window.ResizeObserver;
  let observed: ResizeObserverCallback | undefined;
  window.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      observed = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  let stop: (() => void) | undefined;
  try {
    let received: { width: number; height: number } | undefined;
    stop = browser.observe(h.wrapper, (box) => {
      received = box;
    });
    observed!(
      [{ target: h.wrapper, contentRect: { width: 101.25, height: 72.5 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    assert(
      received?.width === 101.25 && received.height === 72.5,
      'fractional observer box retained',
    );
    h.wrapper.style.cssText =
      'box-sizing:content-box;width:100px;height:70px;padding:7px;border:3px solid;transform:scale(2)';
    const fallback = browser.measure(h.wrapper);
    assert(
      fallback.width === 100 && fallback.height === 70,
      'fallback excludes padding border and transform',
    );
  } finally {
    stop?.();
    window.ResizeObserver = Original;
  }
});

test('fractional observer size survives visibility pageshow and DPR changes', (h) => {
  const extents: { width: number; height: number; scale: number }[] = [];
  const attach = h.bridge.attach;
  h.bridge.attach = (key, size) => {
    extents.push(size);
    return attach(key, size);
  };
  const resize = h.bridge.resize;
  h.bridge.resize = (key, token, size) => {
    extents.push(size);
    resize(key, token, size);
  };
  h.setSize(100, 70, 2);
  h.observed(100.5, 70.5);
  h.tick();
  assert(extents.at(-1)!.width === 201, 'fractional CSS extent at DPR2');
  const measurements = h.calls.measures,
    resizes = h.calls.resize;
  h.hidden(true);
  h.hidden(false);
  h.tick();
  h.page(false);
  h.page(true);
  h.tick();
  h.setSize(100, 70, 2);
  h.tick(); // window resize before a new RO delivery
  assert(
    extents.at(-1)!.width === 201 && h.calls.resize === resizes,
    'visibility and window events do not introduce integer-size reconfiguration',
  );
  h.setSize(100, 70, 3);
  h.tick();
  assert(
    extents.at(-1)!.width === 302 && h.calls.resize === resizes + 1,
    'DPR changes physical size using retained CSS content box',
  );
  assert(h.calls.measures === measurements, 'fallback unused after first RO delivery');
});
test('isolated successful frames do not reset a flapping retry budget', (h) => {
  const render = h.bridge.render;
  let fail = true;
  h.bridge.render = (key, token, redraw) => {
    if (fail) throw new Error('flapping');
    return render(key, token, redraw);
  };
  h.tick();
  for (let i = 0; i < 4; i++) {
    h.retry();
    fail = false;
    h.tick();
    h.advance(50);
    fail = true;
    h.tick();
  }
  assert(
    h.timers.size === 0 && h.errors.length === 1,
    'short successes cannot restart retries or diagnostics',
  );
});
test('one second of successful presentation resets the retry window', (h) => {
  const render = h.bridge.render;
  h.bridge.render = () => {
    throw new Error('first failure');
  };
  h.tick();
  h.retry();
  h.bridge.render = render;
  h.tick();
  h.advance(1000);
  h.tick();
  h.bridge.render = () => {
    throw new Error('later failure');
  };
  h.tick();
  assert(
    h.timers.size === 1 && h.errors.length === 2,
    'stable success starts a fresh failure window',
  );
});

(globalThis as any).__rnrResult = {
  ok: checks.every((c) => c.ok),
  checks,
  limitation:
    'Real Canvas; deterministic scheduler and fake bridge. Not generated Wasm lifecycle evidence.',
};
document.querySelector('#out')!.textContent = JSON.stringify(
  (globalThis as any).__rnrResult,
  null,
  2,
);
