// Optional framework bootstrap: receives the backend's Wasm instances (prebuilt module instances and
// the app's source bundle). Every instance that contains rnrs-surface is bound to its own owner
// number before any of its adapters exists; its surface keys carry that owner in their high bits
// (owner * 2^32 + local key, rnrs-surface lib.rs), so one canvas host with one bridge routes each
// key to the instance that created it. Each instance keeps its own producers and GPU device.
// The instance itself holds its owner (the binding never changes), so installing it again, also
// through another JS object for the same instance, keeps it and its live keys routable.
import { publishHost, retireHost } from './host-registry';
import type { RnrsWasm, WebBootstrap } from '@rnrs/runtime/web';
import {
  createCanvasHost,
  type CanvasBridge,
  type RenderResult,
  type HostEnvironment,
  type Presentation,
} from './canvas-host';
export interface SurfaceWasm extends RnrsWasm {
  /** The instance's surface ABI (rnrs-surface SURFACE_ABI); absent before owner routing. */
  rnrs_surface_abi?(): number;
  /** Binds the instance to `owner` unless already bound; returns the owner it is bound to. */
  rnrs_surface_bind?(owner: number): number;
  rnrs_surface_set_release_listener(
    listener: ((key: number, token: number) => void) | undefined,
  ): void;
  rnrs_surface_attach(key: number, width: number, height: number, scale: number): number | 'closed';
  rnrs_surface_resize(
    key: number,
    token: number,
    width: number,
    height: number,
    scale: number,
  ): 'ok' | 'stale' | 'closed';
  rnrs_surface_detach(key: number, token: number): void;
  rnrs_surface_render(key: number, token: number, redraw: boolean): RenderResult;
  rnrs_surface_presentation(key: number): Presentation | 'closed';
  rnrs_surface_bind_canvas(
    key: number,
    token: number,
    canvas: HTMLCanvasElement,
  ): 'ok' | 'stale' | 'closed';
  rnrs_surface_touch(
    key: number,
    token: number,
    phase: number,
    pointerId: number,
    xPx: number,
    yPx: number,
    timeMs: number,
  ): boolean;
  rnrs_surface_touch_counters(key: number): Float64Array | number[];
}
/** The surface ABI (rnrs-surface's SURFACE_ABI) this bootstrap speaks; exact match required. */
export const SURFACE_ABI = 1;
/** Bits of a surface key below its owner number, and the owner limit (rnrs-surface lib.rs). */
const OWNER_SPAN = 2 ** 32;
const OWNER_LIMIT = 2 ** 21;
const SURFACE_EXPORTS = [
  'rnrs_surface_attach',
  'rnrs_surface_resize',
  'rnrs_surface_detach',
  'rnrs_surface_render',
  'rnrs_surface_set_release_listener',
  'rnrs_surface_presentation',
  'rnrs_surface_bind_canvas',
  'rnrs_surface_touch',
  'rnrs_surface_abi',
  'rnrs_surface_bind',
] as const;
/** The next owner number of this JS realm, never reused. It lives on the global object so that
 *  two copies of this module (a duplicated @rnrs/surface) cannot hand out the same number. */
const counter: { next: number } = ((globalThis as any)[Symbol.for('rnrs.surface.owners')] ??= {
  next: 1,
});
const named = (wasm: RnrsWasm) => {
  const modules = wasm.rnrs_web_modules?.() ?? [];
  return modules.length ? `the Wasm instance of ${modules.join(', ')}` : 'a Wasm instance';
};
/** Throws unless the surface instance has every surface export and this bootstrap's ABI. */
function checkInstance(wasm: SurfaceWasm) {
  for (const name of SURFACE_EXPORTS)
    if (typeof wasm[name] !== 'function')
      throw new Error(
        `@rnrs/surface: ${named(wasm)} lacks the surface export ${name}; rebuild or reinstall it with the installed @rnrs/surface`,
      );
  const abi = wasm.rnrs_surface_abi!();
  if (abi !== SURFACE_ABI)
    throw new Error(
      `@rnrs/surface: ${named(wasm)} implements surface ABI ${abi}, this @rnrs/surface needs ${SURFACE_ABI}; install matching versions of the module, @rnrs/runtime and @rnrs/surface`,
    );
}
/** The (checked) instance's owner: the one it is already bound to, or a new one it is bound to
 *  now. Throws for an owner this realm never issued (it could collide). */
function bindInstance(wasm: SurfaceWasm): number {
  if (counter.next >= OWNER_LIMIT) throw new Error('@rnrs/surface: surface owners exhausted');
  const candidate = counter.next;
  const owner = wasm.rnrs_surface_bind!(candidate);
  if (owner === candidate) counter.next++;
  else if (!Number.isInteger(owner) || owner < 1 || owner >= counter.next)
    throw new Error(
      `@rnrs/surface: ${named(wasm)} is bound to surface owner ${owner}, which this page never issued`,
    );
  return owner;
}
export function createSurfaceBootstrap(
  instances: RnrsWasm | readonly RnrsWasm[],
  onRollback?: (cleanup: () => void) => void,
  env?: HostEnvironment,
) {
  // Instances without rnrs-surface (headless prebuilt modules) take no part. An instance with
  // it must be complete and of this ABI, or the whole installation fails (like a web ABI
  // mismatch in installWebBackend), checked for every instance before any is bound.
  const list = (Array.isArray(instances) ? instances : [instances]) as readonly SurfaceWasm[];
  const surfaces = list.filter((w) => typeof w.rnrs_surface_attach === 'function');
  if (!surfaces.length)
    throw new Error('Surface exports missing from every Wasm instance of the app');
  for (const wasm of surfaces) checkInstance(wasm);
  const byOwner = new Map<number, SurfaceWasm>();
  for (const wasm of surfaces) {
    const owner = bindInstance(wasm);
    if (byOwner.has(owner))
      throw new Error(`@rnrs/surface: ${named(wasm)} is listed twice (surface owner ${owner})`);
    byOwner.set(owner, wasm);
  }
  /** The instance that created `key`, or undefined (matches nothing). Keys are validated first. */
  const route = (key: number) => {
    if (!Number.isSafeInteger(key) || key < 1) throw new Error('invalid surface key');
    return byOwner.get(Math.floor(key / OWNER_SPAN));
  };
  const releases = new Set<(key: number, token: number) => void>();
  // Every instance reports full keys (they carry its owner), so tokens never alias.
  const notify = (key: number, token: number) => {
    for (const listener of releases) listener(key, token);
  };
  const listening: SurfaceWasm[] = [];
  const bridge: CanvasBridge = {
    onRelease(listener) {
      releases.add(listener);
      return () => {
        releases.delete(listener);
      };
    },
    attach: (key, e) =>
      route(key)?.rnrs_surface_attach(key, e.width, e.height, e.scale) ?? 'closed',
    resize: (key, token, e) =>
      route(key)?.rnrs_surface_resize(key, token, e.width, e.height, e.scale) ?? 'closed',
    detach: (key, token) => route(key)?.rnrs_surface_detach(key, token),
    render: (key, token, redraw) =>
      route(key)?.rnrs_surface_render(key, token, redraw) ?? { status: 'closed' },
    presentation: (key) => route(key)?.rnrs_surface_presentation(key) ?? 'closed',
    bindCanvas: (key, token, canvas) =>
      route(key)?.rnrs_surface_bind_canvas(key, token, canvas) ?? 'closed',
    touch: (key, token, phase, id, x, y, time) =>
      route(key)?.rnrs_surface_touch(key, token, phase, id, x, y, time) ?? false,
  };
  let host: ReturnType<typeof createCanvasHost>;
  const dispose = () => {
    const failures: unknown[] = [];
    try {
      retireHost(host);
    } catch (error) {
      failures.push(error);
    }
    // Detaches every mount, of every instance, before any listener goes.
    try {
      host?.dispose();
    } catch (error) {
      failures.push(error);
    }
    releases.clear();
    for (const wasm of listening.splice(0)) {
      try {
        wasm.rnrs_surface_set_release_listener(undefined);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Surface bootstrap cleanup failed');
  };
  onRollback?.(dispose);
  try {
    for (const wasm of surfaces) {
      wasm.rnrs_surface_set_release_listener(notify);
      listening.push(wasm);
    }
    host = createCanvasHost(bridge, env);
    publishHost(host);
  } catch (error) {
    try {
      dispose();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Surface bootstrap creation failed');
    }
    throw error;
  }
  return {
    host,
    bridge,
    dispose,
  } satisfies WebBootstrap & { host: typeof host; bridge: CanvasBridge };
}
