// Browser backend (framework, module-independent) over the wasm-bindgen exports of
// rust/rnrs-web. Everything runs on the page's JS thread.
//
// An app's modules live in one or more Wasm instances: each prebuilt module package ships its
// own, and the app's source bundle holds the modules it builds from source. Every instance has
// its own memory, allocator, native-object slab and executor; this backend is the shared
// runtime. Wrapper identity is per instance: each has its own WeakMap and FinalizationRegistry,
// so another instance's wrapper unwraps to nothing (a TypeError in Rust) and is released only by
// the instance that created it. Unlike native tables, an instance's start function (module
// registration, logging) runs when it is initialized, before its ABI can be read; the Wasm
// sandbox confines it to its own memory, and nothing else of it is used before the check.
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
const Float64ArrayCtor = Float64Array;
const memoryBuffer = Object.getOwnPropertyDescriptor(
  (globalThis as any).WebAssembly?.Memory?.prototype ?? {},
  'buffer',
)?.get;

/** Web: reads `xs[start]` .. `xs[start + count - 1]` with ordinary reads, in order, into the
 *  f64 slots at `ptr` in Wasm memory (the Rust reader's spare capacity). Stops at the first
 *  value that is not a number and returns `[index, value]`; later elements are not read.
 *  Getter and proxy-trap exceptions propagate. A getter may re-enter Wasm and grow its
 *  memory, which detaches the old buffer: the view is then derived again. */
function readNumbers(
  xs: any,
  start: number,
  count: number,
  memory: object,
  ptr: number,
): [number, unknown] | undefined {
  let view = new Float64ArrayCtor(reflectApply(memoryBuffer!, memory, []), ptr, count);
  for (let i = 0; i < count; i++) {
    const x = xs[start + i];
    if (typeof x !== 'number') return [start + i, x];
    // i < count, so an attached view reads a number here; only a detached one reads
    // undefined. Indexed reads of a typed array run no user code, unlike its patchable
    // `length` getter: every slot Rust then counts as written was written to live memory.
    if (view[i] === undefined)
      view = new Float64ArrayCtor(reflectApply(memoryBuffer!, memory, []), ptr, count);
    view[i] = x;
  }
  return undefined;
}

type Adapter = InstanceType<RnrsWasm['RnrsWebAdapter']>;

/** The scalar entry of a method with a prepared Rust leaf (`signature` from the adapter's
 *  scalar_signature): when every argument already has its declared type (`typeof` only, no
 *  user code), one Wasm call with plain f64 slots; otherwise `slow`, the generic positional
 *  call, which raises exactly the generic errors. Extra arguments are ignored, as there. */
function scalarEntry(
  adapter: Adapter,
  signature: ArrayLike<number>,
  arity: number,
  slow: (...args: any[]) => unknown,
): ((...args: any[]) => unknown) | undefined {
  // Indexed reads, no destructuring or array methods (Array.prototype may be patched).
  const slot = signature[0],
    kinds = signature[1],
    result = signature[2];
  const call = bindThis(adapter.scalar, adapter) as (
    slot: number,
    a0: number,
    a1: number,
    a2: number,
    a3: number,
  ) => number;
  const takeError = bindThis(adapter.take_scalar_error, adapter);
  const k0 = kinds & 3,
    k1 = (kinds >> 2) & 3,
    k2 = (kinds >> 4) & 3,
    k3 = (kinds >> 6) & 3;
  // Declared parameters must match the wrapper's arity exactly; otherwise keep the slow path.
  if (+(k0 !== 0) + +(k1 !== 0) + +(k2 !== 0) + +(k3 !== 0) !== arity) return undefined;
  // 1 number, 2 boolean; `+x` is then the f64 slot (booleans 0/1).
  const fits = (kind: number, x: unknown) =>
    kind === 1 ? typeof x === 'number' : typeof x === 'boolean';
  const done = (r: number): unknown => {
    if (r !== r) {
      const error = takeError();
      if (error !== undefined) throw error;
    }
    return result === 0 ? undefined : result === 2 ? r !== 0 : r;
  };
  switch (arity) {
    case 0:
      return () => done(call(slot, 0, 0, 0, 0));
    case 1:
      return (a0: any) => (fits(k0, a0) ? done(call(slot, +a0, 0, 0, 0)) : slow(a0));
    case 2:
      return (a0: any, a1: any) =>
        fits(k0, a0) && fits(k1, a1) ? done(call(slot, +a0, +a1, 0, 0)) : slow(a0, a1);
    case 3:
      return (a0: any, a1: any, a2: any) =>
        fits(k0, a0) && fits(k1, a1) && fits(k2, a2)
          ? done(call(slot, +a0, +a1, +a2, 0))
          : slow(a0, a1, a2);
    case 4:
      return (a0: any, a1: any, a2: any, a3: any) =>
        fits(k0, a0) && fits(k1, a1) && fits(k2, a2) && fits(k3, a3)
          ? done(call(slot, +a0, +a1, +a2, +a3))
          : slow(a0, a1, a2, a3);
    default:
      return undefined;
  }
}

/** Version of the contract between rnrs-web's exports and this backend (RNRS_WEB_ABI in
 *  rust/rnrs-web): the adapter class and methods, the helper protocol, and the settle,
 *  admission and byte codes. tools/rnrs-gen/test/web-abi.test.mjs pins both sides. */
export const WEB_ABI = 1;

/** The wasm-bindgen module of one Wasm instance: a prebuilt module package's
 *  (rnrs/native/web/rnrs_<crate>.js) or the app's source bundle (.rnrs/web/pkg/rnrs_bundle.js). */
export interface RnrsWasm {
  /** The instance's web ABI (WEB_ABI); absent in instances built by an older @rnrs/runtime. */
  rnrs_web_abi?(): number;
  /** The spec module names the instance provides. */
  rnrs_web_modules?(): string[];
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
    /** Prepared scalar leaves (bundles built by an older @rnrs/runtime may lack them). */
    scalar_signature?(index: number): Uint32Array | undefined;
    scalar(slot: number, a0: number, a1: number, a2: number, a3: number): number;
    take_scalar_error(): unknown;
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
  wasm: RnrsWasm | readonly RnrsWasm[],
  bootstrap?: WebBootstrapFactory,
): Backend & { dispose(): void } {
  if (installing) throw new Error('Web backend installation is already in progress');
  installing = true;
  try {
    // Checked before anything of an instance is used: its ABI, then the modules it provides.
    const instances = (Array.isArray(wasm) ? wasm : [wasm]) as readonly RnrsWasm[];
    const owners = new Map<string, RnrsWasm>();
    for (const instance of instances) {
      const abi = typeof instance.rnrs_web_abi === 'function' ? instance.rnrs_web_abi() : undefined;
      if (abi !== WEB_ABI)
        throw new Error(
          `@rnrs/runtime: a Wasm instance was built for web ABI ${abi ?? '(none: an older @rnrs/runtime)'}, this @rnrs/runtime needs ${WEB_ABI}. Rebuild or reinstall it with the installed @rnrs/runtime (rnrs build --target web).`,
        );
      for (const name of instance.rnrs_web_modules?.() ?? []) {
        if (owners.has(name))
          throw new Error(`@rnrs/runtime: module ${name} is provided by two Wasm instances`);
        owners.set(name, instance);
      }
    }
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
      // Framework extensions (surfaces) live in the source bundle, the first instance.
      extension = bootstrap?.(instances[0], (cleanup) => {
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
      // Captured now: later patches of WeakMap.prototype cannot change wrapper resolution.
      const weakGet = WeakMap.prototype.get,
        weakSet = WeakMap.prototype.set,
        apply = Reflect.apply;
      // One wrapper identity per instance: its slab entries, its releases.
      const helpersOf = new Map<RnrsWasm, object>();
      for (const instance of instances) {
        const handles = new WeakMap<object, [number, number]>();
        const registry = new FinalizationRegistry<[number, number]>(([slot, version]) =>
          instance.rnrs_release_slot(slot, version),
        );
        helpersOf.set(
          instance,
          Object.freeze({
            ...conversionHelpers,
            numbers: readNumbers,
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
          }),
        );
      }
      const backend: Backend & { dispose(): void } = {
        dispose,
        platform: 'web',
        install(name: string, hash: string, maxInFlight: number, settle: SettleFn): NativeAdapter {
          if (stopped) throw new Error('Web backend is disposed');
          const wasm = owners.get(name);
          if (!wasm)
            throw new Error(
              `@rnrs/runtime: module ${name} is not linked into this app (linked: ${[...owners.keys()].join(', ') || 'none'})`,
            );
          const helpers = helpersOf.get(wasm)!;
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
            // its arguments, as with the JSI backend's prepared host functions. Methods with a
            // prepared Rust leaf take it first (scalarEntry), with that call as the slow path.
            entry: (index, arity) => {
              const call = POSITIONAL[arity];
              if (call === undefined)
                throw new Error(`@rnrs/runtime: ${name}: no entry of arity ${arity}`);
              const slow = reflectApply(functionBind, adapter[call], [
                adapter,
                index,
                undefined,
              ]) as (...args: any[]) => unknown;
              const signature =
                typeof adapter.scalar_signature === 'function'
                  ? adapter.scalar_signature(index)
                  : undefined;
              return (signature && scalarEntry(adapter, signature, arity, slow)) ?? slow;
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
