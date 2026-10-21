// Optional framework bootstrap; receives the same generated bundle as the runtime adapter.
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
export function createSurfaceBootstrap(
  bundle: RnrsWasm,
  onRollback?: (cleanup: () => void) => void,
  env?: HostEnvironment,
) {
  const wasm = bundle as SurfaceWasm;
  for (const name of [
    'rnrs_surface_attach',
    'rnrs_surface_resize',
    'rnrs_surface_detach',
    'rnrs_surface_render',
    'rnrs_surface_set_release_listener',
    'rnrs_surface_presentation',
    'rnrs_surface_bind_canvas',
    'rnrs_surface_touch',
  ] as const) {
    if (typeof wasm[name] !== 'function')
      throw new Error('Surface exports missing from the runtime Wasm bundle: ' + name);
  }
  const releases = new Set<(key: number, token: number) => void>();
  wasm.rnrs_surface_set_release_listener((key, token) => {
    for (const listener of releases) listener(key, token);
  });
  const bridge: CanvasBridge = {
    onRelease(listener) {
      releases.add(listener);
      return () => {
        releases.delete(listener);
      };
    },
    attach: (key, e) => wasm.rnrs_surface_attach(key, e.width, e.height, e.scale),
    resize: (key, token, e) => wasm.rnrs_surface_resize(key, token, e.width, e.height, e.scale),
    detach: (key, token) => wasm.rnrs_surface_detach(key, token),
    render: (key, token, redraw) => wasm.rnrs_surface_render(key, token, redraw),
    presentation: (key) => wasm.rnrs_surface_presentation(key),
    bindCanvas: (key, token, canvas) => wasm.rnrs_surface_bind_canvas(key, token, canvas),
    touch: (key, token, phase, id, x, y, time) =>
      wasm.rnrs_surface_touch(key, token, phase, id, x, y, time),
  };
  let host: ReturnType<typeof createCanvasHost>;
  const dispose = () => {
    const failures: unknown[] = [];
    try {
      retireHost(host);
    } catch (error) {
      failures.push(error);
    }
    try {
      host?.dispose();
    } catch (error) {
      failures.push(error);
    }
    releases.clear();
    try {
      wasm.rnrs_surface_set_release_listener(undefined);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Surface bootstrap cleanup failed');
  };
  onRollback?.(dispose);
  try {
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
