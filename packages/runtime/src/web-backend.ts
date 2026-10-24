// Browser backend (framework, module-independent) over the wasm-bindgen exports of
// rust/rnrs-web. Everything runs on the page's JS thread.
import {
  bindThis,
  conversionHelpers,
  setBackend,
  type AdapterStats,
  type Backend,
  type NativeAdapter,
  type SettleFn,
} from './runtime';

// Captured at init, like runtime.ts's bind helpers.
const reflectApply = Reflect.apply;
const functionBind = Function.prototype.bind;
const POSITIONAL = ['call0', 'call1', 'call2', 'call3', 'call4'] as const;

/** The wasm-bindgen module of the app's Wasm bundle (web/pkg/web_bundle.js). */
export interface RnrsWasm {
  RnrsWebAdapter: new (
    name: string,
    hash: string,
    maxInFlight: number,
    notify: () => void,
    helpers: object,
  ) => {
    readonly generation: number;
    call(index: number, receiver: unknown, args: unknown[]): unknown;
    call0(index: number, receiver: unknown): unknown;
    call1(index: number, receiver: unknown, a0: unknown): unknown;
    call2(index: number, receiver: unknown, a0: unknown, a1: unknown): unknown;
    call3(index: number, receiver: unknown, a0: unknown, a1: unknown, a2: unknown): unknown;
    call4(
      index: number,
      receiver: unknown,
      a0: unknown,
      a1: unknown,
      a2: unknown,
      a3: unknown,
    ): unknown;
    drain(settle: SettleFn): void;
    cancel(id: number): boolean;
    dispose(handle: unknown): void;
    teardown(): void;
    stats(): AdapterStats;
  };
  rnrs_release_slot(slot: number, version: number): void;
}

/** The Wasm adapter must provide the entries this JS runtime calls; a bundle built by an older
 *  @rnrs/runtime lacks the positional ones. Throws an actionable error. */
export function checkWasmAdapter(adapter: Record<string, unknown>, name: string): void {
  for (const entry of ['call', 'call0', 'call1', 'call2', 'call3', 'call4']) {
    if (typeof adapter[entry] !== 'function')
      throw new Error(
        `@rnrs/runtime: the app's Wasm bundle does not match this JS runtime: module ${name} has no "${entry}" entry. Rebuild it with the installed @rnrs/runtime (rnrs build --target web).`,
      );
  }
}

/** Installs the browser backend. Native wrappers are frozen empty objects mapped to their
 *  Wasm slab entry through this module-private WeakMap, so JS cannot forge them; a
 *  FinalizationRegistry frees the entry when a wrapper is collected. */
/** Releases a refused Wasm adapter: teardown, then free (wasm-bindgen's explicit release),
 *  each attempted exactly once; cleanup failures are reported with the original error. */
export function refuseWasmAdapter(
  adapter: { teardown?(): void; free?(): void },
  error: unknown,
): never {
  const failures: unknown[] = [error];
  try {
    adapter.teardown?.();
  } catch (failure) {
    failures.push(failure);
  }
  try {
    adapter.free?.();
  } catch (failure) {
    failures.push(failure);
  }
  if (failures.length > 1)
    throw new AggregateError(failures, 'Wasm adapter refusal and cleanup failed');
  throw error;
}

export interface WebBootstrap {
  dispose(): void;
}
export type WebBootstrapFactory = (
  sameBundle: RnrsWasm,
  onRollback: (cleanup: () => void) => void,
) => WebBootstrap;
let disposeInstalled: (() => void) | undefined;
let installing = false;

/** One active browser backend per JS realm. A new install retires the previous instance
 * before creating or publishing another. Disposal attempts every adapter even on failure.
 * Bootstrap factories register rollback actions before acquiring fallible resources; on
 * successful return their disposer owns cleanup. A failed install publishes no backend. */
export function installWebBackend(
  wasm: RnrsWasm,
  bootstrap?: WebBootstrapFactory,
): Backend & { dispose(): void } {
  if (installing) throw new Error('Web backend installation is already in progress');
  installing = true;
  try {
    disposeInstalled?.();
    let extension: WebBootstrap | undefined;
    let stopped = false;
    const adapters = new Set<{ teardown(): void }>();
    const dispose = () => {
      if (stopped) return;
      stopped = true;
      const failures: unknown[] = [];
      try {
        extension?.dispose();
      } catch (e) {
        failures.push(e);
      }
      for (const adapter of adapters) {
        try {
          adapter.teardown();
        } catch (e) {
          failures.push(e);
        }
      }
      adapters.clear();
      if (disposeInstalled === dispose) disposeInstalled = undefined;
      if (failures.length) throw new AggregateError(failures, 'Web backend cleanup failed');
    };
    const rollback: (() => void)[] = [];
    try {
      extension = bootstrap?.(wasm, (cleanup) => {
        rollback.push(cleanup);
      });
      if (bootstrap && (!extension || typeof extension.dispose !== 'function'))
        throw new Error('Web bootstrap must return a disposer');
    } catch (error) {
      const failures: unknown[] = [error];
      for (const cleanup of rollback.reverse()) {
        try {
          cleanup();
        } catch (failure) {
          failures.push(failure);
        }
      }
      try {
        dispose();
      } catch (failure) {
        failures.push(failure);
      }
      if (failures.length > 1)
        throw new AggregateError(failures, 'Web bootstrap and rollback failed');
      throw error;
    }
    try {
      const handles = new WeakMap<object, [number, number]>();
      const registry = new FinalizationRegistry<[number, number]>(([slot, version]) =>
        wasm.rnrs_release_slot(slot, version),
      );
      // Captured now: later patches of WeakMap.prototype cannot change wrapper resolution.
      const weakGet = WeakMap.prototype.get,
        weakSet = WeakMap.prototype.set,
        apply = Reflect.apply;
      const helpers = Object.freeze({
        ...conversionHelpers,
        wrap(slot: number, version: number): object {
          const wrapper = Object.freeze(Object.create(null));
          apply(weakSet, handles, [wrapper, [slot, version]]);
          registry.register(wrapper, [slot, version]);
          return wrapper;
        },
        unwrap(value: unknown): [number, number] | null {
          return (
            (typeof value === 'object' && value !== null && apply(weakGet, handles, [value])) ||
            null
          );
        },
      });
      const backend: Backend & { dispose(): void } = {
        dispose,
        platform: 'web',
        install(name: string, hash: string, maxInFlight: number, settle: SettleFn): NativeAdapter {
          if (stopped) throw new Error('Web backend is disposed');
          let scheduled = false;
          // Called by Rust with its host lock held: only schedule, never re-enter.
          const adapter = new wasm.RnrsWebAdapter(
            name,
            hash,
            maxInFlight,
            () => {
              if (!scheduled) {
                scheduled = true;
                queueMicrotask(drain);
              }
            },
            helpers,
          );
          let retired = false;
          const drain = () => {
            scheduled = false;
            if (!stopped && !retired) adapter.drain(settle);
          };
          try {
            checkWasmAdapter(adapter as unknown as Record<string, unknown>, name);
          } catch (error) {
            refuseWasmAdapter(adapter as unknown as { teardown?(): void; free?(): void }, error);
          }
          adapters.add(adapter);
          return {
            generation: adapter.generation,
            call: (index, receiver, args) => adapter.call(index, receiver, args),
            // Fixed arities, explicit parameters (no argument array, no spread or rest): the
            // wasm-bindgen methods bound to the adapter (captured bind).
            call0: bindThis(adapter.call0, adapter) as NativeAdapter['call0'],
            call1: bindThis(adapter.call1, adapter) as NativeAdapter['call1'],
            call2: bindThis(adapter.call2, adapter) as NativeAdapter['call2'],
            call3: bindThis(adapter.call3, adapter) as NativeAdapter['call3'],
            call4: bindThis(adapter.call4, adapter) as NativeAdapter['call4'],
            // Scalar entry: the positional wasm method of that arity, bound to the adapter,
            // the method index and the module receiver (undefined), so the wrapper passes only
            // its arguments, as with the JSI backend's prepared host functions.
            entry: (index, arity) => {
              const call = POSITIONAL[arity];
              if (call === undefined)
                throw new Error(`@rnrs/runtime: ${name}: no entry of arity ${arity}`);
              return reflectApply(functionBind, adapter[call], [adapter, index, undefined]) as (
                ...args: any[]
              ) => unknown;
            },
            cancel: (id) => adapter.cancel(id),
            dispose: (handle) => adapter.dispose(handle),
            teardown: () => {
              if (retired) return;
              retired = true;
              adapters.delete(adapter);
              adapter.teardown();
            },
            stats: () => adapter.stats(),
          };
        },
      };
      disposeInstalled = dispose;
      setBackend(backend);
      return backend;
    } catch (error) {
      try {
        dispose();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Web installation and cleanup failed');
      }
      throw error;
    }
  } finally {
    installing = false;
  }
}
