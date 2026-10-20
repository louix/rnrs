// Internal Canvas host. Framework bootstrap supplies the exports of the same Wasm bundle.
// No React, native component, command decoder, raw Wasm memory view or GPU backend: a WebGPU
// producer draws into the canvas itself, and the host only sizes and hands over the element.
export interface Extent {width: number; height: number; scale: number}
export type RenderResult =
  | {status: 'closed' | 'stale' | 'unchanged'}
  | {status: 'pixels'; width: number; height: number; pixels: Uint8Array}
  // WebGPU producers. submitted: GPU work submitted for the canvas texture (not proof of
  // display); pending: device/surface setup in progress; failed: terminal for the attachment.
  | {status: 'pending' | 'submitted'}
  | {status: 'failed'; reason: string};
export type Presentation = 'canvas2d' | 'webgpu';
export interface CanvasBridge {
  attach(key: number, extent: Extent): number | 'closed'; // 0: busy; 'closed': terminal
  resize(key: number, token: number, extent: Extent): void | 'ok' | 'stale' | 'closed'; // throws on budget exhaustion
  detach(key: number, token: number): void;
  onRelease?(notify: (key: number, token: number) => void): () => void;
  render(key: number, token: number, redraw: boolean): RenderResult;
  /** Absent: every producer is Canvas 2D. 'closed': the key matches no open surface. */
  presentation?(key: number): Presentation | 'closed';
  /** WebGPU producers only: hand the attachment its canvas. Throws when unsupported. */
  bindCanvas?(key: number, token: number, canvas: HTMLCanvasElement): 'ok' | 'stale' | 'closed';
  /** Rust touch input (touch.rs phase codes). True if the queue accepted the transition. */
  touch?(key: number, token: number, phase: TouchCode, pointerId: number, xPx: number, yPx: number, timeMs: number): boolean;
}
export type SurfaceTouchInput = 'none' | 'rust';
/** touch.rs `Phase::from_code`: down, move, up, cancel, cancel all. */
export type TouchCode = 0 | 1 | 2 | 3 | 4;
const DOWN = 0, MOVE = 1, UP = 2, CANCEL = 3, CANCEL_ALL = 4;
/** Pointers that reach Rust: touch contacts, and the mouse while its primary button is down
 *  (for desktop testing). Pens, hover, wheel and keys are not delivered. */
const touchPointer = (event: PointerEvent) =>
  event.pointerType === 'touch' || (event.pointerType === 'mouse' && event.button === 0);
export interface HostEnvironment {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
  observe(element: HTMLElement, callback: (box?: {width: number; height: number}) => void): () => void;
  delay(callback: () => void, ms: number): number;
  cancelDelay(id: number): void;
  now(): number;
  measure(element: HTMLElement): {width: number; height: number};
  dpr(): number;
  visible(): boolean;
  listenVisibility(callback: () => void): () => void;
  listenPage(callback: (active: boolean) => void): () => void;
}
export const browser: HostEnvironment = {
  requestFrame: callback => requestAnimationFrame(callback),
  cancelFrame: id => cancelAnimationFrame(id),
  delay: (callback, ms) => window.setTimeout(callback, ms),
  cancelDelay: id => clearTimeout(id),
  now: () => performance.now(),
  observe(element, callback) {
    const observer = new ResizeObserver(entries => {
      const entry = entries.find(entry => entry.target === element);
      if (entry) callback({width: entry.contentRect.width, height: entry.contentRect.height});
    });
    const resized = () => callback();
    observer.observe(element);
    window.addEventListener('resize', resized);
    let media: MediaQueryList;
    const changed = () => { arm(); callback(); };
    const arm = () => {
      media?.removeEventListener('change', changed);
      media = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      media.addEventListener('change', changed);
    };
    arm();
    return () => {
      observer.disconnect(); window.removeEventListener('resize', resized);
      media.removeEventListener('change', changed);
    };
  },
  measure(element) {
    // Initial/event fallback only. client sizes exclude borders, transforms and scrollbars.
    // ResizeObserver supplies fractional contentRect sizes once observation starts.
    const style = getComputedStyle(element);
    const px = (value: string) => Number.parseFloat(value) || 0;
    return {
      width: Math.max(0, element.clientWidth - px(style.paddingLeft) - px(style.paddingRight)),
      height: Math.max(0, element.clientHeight - px(style.paddingTop) - px(style.paddingBottom)),
    };
  },
  dpr: () => window.devicePixelRatio,
  visible: () => document.visibilityState !== 'hidden',
  listenVisibility(callback) {
    document.addEventListener('visibilitychange', callback);
    return () => document.removeEventListener('visibilitychange', callback);
  },
  listenPage(callback) {
    const hide = () => callback(false), show = () => callback(true);
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    return () => { window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); };
  },
};
const MAX_PIXELS = 4_194_304;
function extent(box: {width: number; height: number}, scale: number): Extent {
  if (![box.width, box.height, scale].every(Number.isFinite) ||
      box.width < 0 || box.height < 0 || scale <= 0) throw new Error('invalid canvas extent');
  const width = Math.round(box.width * scale), height = Math.round(box.height * scale);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width > 0xffff_ffff || height > 0xffff_ffff) throw new Error('canvas extent overflows u32');
  return {width, height, scale};
}
function same(a: Extent | undefined, b: Extent) {
  return a?.width === b.width && a.height === b.height && a.scale === b.scale;
}
export interface CanvasMount {
  dispose(): void; refresh(): void; readonly presentation: Presentation | 'closed';
  /** 'rust': pointer listeners on the element feed this surface's Rust touch queue. */
  setTouchInput(mode: SurfaceTouchInput): void;
}

const released = new WeakMap<CanvasBridge, Set<(key: number, token: number) => void>>();
const RETRY_MS = [100, 250, 500, 1000];
const owners = new WeakMap<HTMLCanvasElement, CanvasMount>();
// A canvas keeps the first context type it was given (2d or webgpu) for its lifetime.
// Switching modes needs a new canvas element; the host refuses rather than misdraw.
const contexts = new WeakMap<HTMLCanvasElement, Presentation>();

/** One instance per framework backend installation. dispose() precedes runtime teardown. */
export function createCanvasHost(bridge: CanvasBridge, env = browser) {
  let stopped = false;
  const mounts = new Set<CanvasMount>();
  let listeners = released.get(bridge);
  if (!listeners) { listeners = new Set(); released.set(bridge, listeners); }
  const unsubscribe = bridge.onRelease?.((key, token) => { for (const notify of listeners!) notify(key, token); });
  return {
    mount(canvas: HTMLCanvasElement, element: HTMLElement, key: number,
          onError: (error: unknown) => void = console.error): CanvasMount {
      if (stopped) throw new Error('canvas host is disposed');
      if (!Number.isSafeInteger(key) || key < 0) throw new Error('invalid surface key');
      if (owners.has(canvas)) throw new Error('canvas already mounted');
      const mode = bridge.presentation?.(key) ?? 'canvas2d';
      if (mode !== 'closed' && mode !== 'canvas2d' && mode !== 'webgpu') throw new Error('invalid surface presentation');
      const held = contexts.get(canvas);
      if (mode !== 'closed' && held && held !== mode)
        throw new Error(`canvas already holds a ${held} context; a ${mode} surface needs a new canvas element`);
      const gpu = mode === 'webgpu';
      if (gpu && !bridge.bindCanvas) throw new Error('surface bridge cannot bind a WebGPU canvas');
      let ctx: CanvasRenderingContext2D | null = null;
      if (mode === 'canvas2d') {
        ctx = canvas.getContext('2d', {alpha: false});
        if (!ctx) throw new Error('Canvas 2D is unavailable');
      }
      if (mode !== 'closed') contexts.set(canvas, mode);
      // gpuFailed: the WebGPU producer reported a terminal failure for its attachment. No
      // automatic retry: refresh(), becoming visible again or a remount reattaches once.
      let disposed = false, pageActive = true, lost = false, blocked = false, terminal = mode === 'closed';
      let gpuFailed = false;
      let observedBox: {width: number; height: number} | undefined;
      let healthySince: number | undefined;
      let desired: Extent | undefined, active = false, retry: number | undefined, attempts = 0, reported = false;
      let lastDetachedToken = 0, detaching = false;
      let generation = 0, token = 0, raf: number | undefined, measured: Extent | undefined;
      let image: ImageData | undefined, redraw = true;
      const cleanups: (() => void)[] = [];
      // Touch input: pointer ids accepted for attachment `token` (cleared whenever it ends).
      let touchMode: SurfaceTouchInput = 'none', touchCleanup: (() => void) | undefined;
      const owned = new Set<number>();
      const forgetPointers = () => {
        const ids = [...owned];
        owned.clear(); // first: a lostpointercapture from the release below is then ignored
        for (const id of ids) {
          try { if (element.hasPointerCapture(id)) element.releasePointerCapture(id); } catch {}
        }
      };
      const clear = () => { image = undefined; canvas.width = 0; canvas.height = 0; };
      const cancelRetry = () => { if (retry !== undefined) env.cancelDelay(retry); retry = undefined; };
      const detach = () => {
        cancelRetry();
        generation++;
        if (raf !== undefined) { env.cancelFrame(raf); raf = undefined; }
        const old = token; token = 0; measured = undefined; redraw = true;
        // Rust ends the old token's touch epoch with a reset; its pointers are no longer ours.
        forgetPointers();
        if (old) {
          lastDetachedToken = Math.max(lastDetachedToken, old);
          detaching = true;
          try { bridge.detach(key, old); }
          finally { detaching = false; }
          for (const notify of listeners!) if (notify !== ownerReleased) notify(key, old);
        }
      };
      const report = (error: unknown) => {
        try { onError(error); } catch (callbackError) {
          // Error reporting must not escape an observer/RAF or interrupt cleanup.
          try { console.error('Canvas error handler threw', callbackError, error); } catch {}
        }
      };
      const reportOnce = (error: unknown) => { if (!reported) { reported = true; report(error); } };
      const retryLater = (ms?: number) => {
        if (disposed || stopped || terminal || !active || retry !== undefined) return;
        if (ms === undefined && attempts >= RETRY_MS.length) return;
        retry = env.delay(() => {
          retry = undefined; blocked = false;
          try { sync(); } catch (error) { fail(error); }
        }, ms ?? RETRY_MS[attempts++]);
      };
      const fail = (error: unknown) => {
        healthySince = undefined;
        blocked = true;
        let cleanupError: unknown;
        try { detach(); } catch (failure) { cleanupError = failure; }
        clear();
        reportOnce(cleanupError === undefined ? error :
          new AggregateError([error, cleanupError], 'Canvas operation and detach failed'));
        retryLater();
      };
      const schedule = () => {
        if (disposed || stopped || !token || raf !== undefined) return;
        const epoch = generation;
        raf = env.requestFrame(() => {
          if (disposed || stopped || epoch !== generation) return;
          raf = undefined;
          try {
            sync(true);
            if (!token || epoch !== generation) return;
            const result = bridge.render(key, token, redraw);
            if (result.status === 'closed' || result.status === 'stale') {
              healthySince = undefined;
              terminal = result.status === 'closed';
              detach(); clear(); blocked = true;
              if (!terminal) retryLater();
              return;
            }
            if (gpu) {
              if (result.status === 'failed') {
                healthySince = undefined; gpuFailed = true;
                detach(); clear(); blocked = true;
                report(new Error('WebGPU surface failed: ' + result.reason));
                return;
              }
              if (result.status === 'pending') { schedule(); return; }
              if (result.status === 'submitted') redraw = false;
              else if (result.status !== 'unchanged') throw new Error('invalid GPU render status');
            } else if (result.status === 'pixels') {
              const {width, height, pixels} = result;
              if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
                  width > 4096 || height > 4096 || width * height > MAX_PIXELS ||
                  pixels.byteLength !== width * height * 4) throw new Error('invalid raster output');
              if (!image || image.width !== width || image.height !== height) {
                canvas.width = width; canvas.height = height;
                image = ctx!.createImageData(width, height);
              }
              // pixels is an owned copy, never a borrowed view into Wasm memory.
              image.data.set(pixels);
              ctx!.putImageData(image, 0, 0);
              redraw = false;
            } else if (result.status !== 'unchanged') throw new Error('invalid Canvas 2D render status');
            healthySince ??= env.now();
            if (env.now() - healthySince >= 1000) { attempts = 0; reported = false; }
            schedule();
          } catch (error) { fail(error); }
        });
      };
      const sync = (inFrame = false) => {
        if (disposed || stopped || terminal) return;
        if (!active || lost || !key) { detach(); clear(); return; }
        if (blocked || gpuFailed) return;
        const next = desired!;
        if (!next.width || !next.height) { detach(); clear(); return; }
        if (!token) {
          const attached = bridge.attach(key, next);
          if (attached === 'closed') { terminal = true; cancelRetry(); clear(); return; }
          if (!Number.isSafeInteger(attached) || attached < 0) throw new Error('invalid attachment token');
          token = attached;
          if (!token) {
            blocked = true; clear(); reportOnce(new Error('Surface is busy; framework retries are bounded'));
            retryLater(); return;
          }
          cancelRetry();
          measured = next; redraw = true;
          if (gpu) {
            // The producer configures its GPU surface at this backing size.
            canvas.width = next.width; canvas.height = next.height;
            const bound = bridge.bindCanvas!(key, token, canvas);
            if (bound === 'closed' || bound === 'stale') {
              terminal = bound === 'closed';
              detach(); clear(); blocked = true;
              if (!terminal) retryLater();
              return;
            }
          }
        } else if (!same(measured, next)) {
          if (!inFrame) { schedule(); return; }
          redraw = true;
          if (gpu) { canvas.width = next.width; canvas.height = next.height; }
          const status = bridge.resize(key, token, next);
          if (status === 'closed' || status === 'stale') {
            terminal = status === 'closed';
            detach(); clear(); blocked = true;
            if (!terminal) retryLater();
            return;
          }
          measured = next;
        }
        schedule();
      };
      const update = (box?: {width: number; height: number}) => {
        if (disposed || stopped || terminal) return;
        try {
          let next: Extent;
          try {
            if (box) observedBox = box;
            next = extent(observedBox ?? env.measure(element), env.dpr());
          }
          catch (error) { desired = undefined; active = false; throw error; }
          const nowActive = pageActive && env.visible();
          if (!active && nowActive) gpuFailed = false;
          if (!same(desired, next) || (!active && nowActive)) {
            cancelRetry(); blocked = false; attempts = 0; reported = false; healthySince = undefined;
          }
          desired = next; active = nowActive;
          sync();
        } catch (error) { fail(error); }
      };
      const refresh = () => {
        if (terminal) return;
        cancelRetry(); blocked = false; gpuFailed = false; attempts = 0; reported = false; update();
      };
      const ownerReleased = (releasedKey: number, releasedToken: number) => {
        // Tokens are monotonic. Ignore our own detach even if delivery is deferred.
        if (releasedKey === key && blocked && !detaching &&
            releasedToken > lastDetachedToken) retryLater(0);
      };
      listeners!.add(ownerReleased);
      cleanups.push(() => listeners!.delete(ownerReleased));
      const lostContext = (event: Event) => {
        event.preventDefault(); lost = true;
        try { detach(); clear(); } catch (error) { fail(error); }
      };
      const restoredContext = () => { lost = false; image = undefined; redraw = true; refresh(); };
      // Element-local CSS pixels to the physical pixels of the extent Rust holds for this token
      // (per axis, so the element's right/bottom edge maps to the attached width/height).
      const physical = (event: PointerEvent): [number, number] => {
        const rect = element.getBoundingClientRect(), e = measured!;
        return [(event.clientX - rect.left) * (rect.width > 0 ? e.width / rect.width : e.scale),
          (event.clientY - rect.top) * (rect.height > 0 ? e.height / rect.height : e.scale)];
      };
      const push = (phase: TouchCode, event: PointerEvent) => {
        if (!token || !measured) return false;
        const [x, y] = physical(event);
        return bridge.touch!(key, token, phase, event.pointerId, x, y, Math.max(0, event.timeStamp));
      };
      const guard = (handler: (event: PointerEvent) => void) => (event: PointerEvent) => {
        if (disposed || stopped) return;
        try { handler(event); } catch (error) { owned.delete(event.pointerId); report(error); }
      };
      const onDown = guard(event => {
        if (!token || !measured || !touchPointer(event) || owned.has(event.pointerId)) return;
        if (!push(DOWN, event)) return; // refused: the event goes on to whatever else wants it
        // Keep the gesture's moves and end even outside the element, like a native view. Without
        // capture the end could be missed, so a failed capture cancels the accepted pointer.
        try { element.setPointerCapture(event.pointerId); }
        catch (error) { push(CANCEL, event); report(error); return; }
        owned.add(event.pointerId);
        // Only for a down this surface took. For a mouse this also suppresses the compatibility
        // mouse events (mousedown/mousemove/mouseup) of the gesture; click is not one.
        event.preventDefault();
      });
      const onMove = guard(event => {
        if (!owned.has(event.pointerId)) return;
        // Chorded buttons: releasing the primary button while another is held fires
        // pointermove, not pointerup. It ends the gesture here; the later pointerup is ignored.
        if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) {
          owned.delete(event.pointerId);
          try { if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId); } catch {}
          push(UP, event);
          return;
        }
        push(MOVE, event);
      });
      const end = (phase: TouchCode) => guard(event => {
        if (!owned.delete(event.pointerId)) return;
        push(phase, event);
      });
      const onUp = end(UP), onCancel = end(CANCEL);
      const setTouchInput = (mode: SurfaceTouchInput) => {
        if (mode !== 'none' && mode !== 'rust') throw new Error('invalid touchInput');
        if (disposed || stopped || mode === touchMode) return;
        if (mode === 'rust' && !bridge.touch) throw new Error('surface bridge has no touch input');
        touchMode = mode;
        if (mode === 'rust') {
          const previous = element.style.touchAction;
          // Pans and pinches on this element go to the pointer listeners, not the page.
          element.style.touchAction = 'none';
          const listeners = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp],
            ['pointercancel', onCancel], ['lostpointercapture', onCancel]] as const;
          for (const [type, listener] of listeners) element.addEventListener(type, listener);
          touchCleanup = () => {
            for (const [type, listener] of listeners) element.removeEventListener(type, listener);
            element.style.touchAction = previous;
          };
          return;
        }
        // Opting out mid-gesture cancels every pointer this surface holds (Android: CANCEL_ALL).
        const held = owned.size > 0 && token !== 0;
        forgetPointers();
        const cleanup = touchCleanup; touchCleanup = undefined;
        cleanup?.();
        if (held) bridge.touch!(key, token, CANCEL_ALL, -1, 0, 0, env.now());
      };
      cleanups.push(() => { forgetPointers(); const cleanup = touchCleanup; touchCleanup = undefined; cleanup?.(); });
      const mount: CanvasMount = {
        setTouchInput,
        refresh,
        presentation: mode,
        dispose() {
          if (disposed) return;
          disposed = true;
          const failures: unknown[] = [];
          try { detach(); } catch (error) { failures.push(error); }
          clear();
          for (const cleanup of cleanups) {
            try { cleanup(); } catch (error) { failures.push(error); }
          }
          owners.delete(canvas); mounts.delete(mount);
          if (failures.length) report(new AggregateError(failures, 'Canvas cleanup failed'));
        },
      };
      owners.set(canvas, mount); mounts.add(mount);
      try {
        canvas.addEventListener('contextlost', lostContext);
        canvas.addEventListener('contextrestored', restoredContext);
        cleanups.push(() => {
          canvas.removeEventListener('contextlost', lostContext);
          canvas.removeEventListener('contextrestored', restoredContext);
        });
        cleanups.push(env.observe(element, update));
        cleanups.push(env.listenVisibility(() => update()));
        cleanups.push(env.listenPage(active => { pageActive = active; update(); }));
        refresh();
      } catch (error) { mount.dispose(); throw error; }
      return mount;
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      unsubscribe?.();
      let error: unknown;
      for (const mount of [...mounts]) {
        try { mount.dispose(); } catch (e) { error ??= e; }
      }
      if (error) throw error;
    },
  };
}
