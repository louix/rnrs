// Framework JS runtime shared by every generated module wrapper and both backends (JSI on
// Android, wasm-bindgen in the browser). Handwritten, module-independent.
//
// Ownership: a module is runtime-scoped and owned by the framework. Applications get the
// runtime's single instance from the generated accessor (e.g. `counterModule()`) and never
// tear it down; it ends with the runtime (on Android, through React Native's module
// invalidation). Native objects are disposed individually: dispose() or GC releases one
// wrapper's handle; in-flight operations keep their own. `teardown()` exists only on extra
// modules created through the generated `create…ForTesting` hooks.
//
// Promise state is owned here, on the JS thread; backends only deliver
// (generation, id, status, value, message) settlements.

// Intrinsics captured when this module initializes, so later prototype pollution or
// patching cannot change how native conversions read or write JS values.
const hasOwn = Object.prototype.hasOwnProperty;
const reflectApply = Reflect.apply;
const functionBind = Function.prototype.bind;
/** `f.bind(thisArg)` / `f.bind(thisArg, first)` through the intrinsic captured at init
 *  (backends build fixed-arity call entries without an extra JS frame). Literal argument
 *  arrays only: no rest or spread, even at install time. */
export function bindThis(f: Function, thisArg: unknown): (...args: any[]) => unknown {
  return reflectApply(functionBind, f, [thisArg]) as (...args: any[]) => unknown;
}
export function bindThisAndFirst(
  f: Function,
  thisArg: unknown,
  first: unknown,
): (...args: any[]) => unknown {
  return reflectApply(functionBind, f, [thisArg, first]) as (...args: any[]) => unknown;
}
const reflectGet = Reflect.get;
const defineProperty = Object.defineProperty;
const arrayIsArray = Array.isArray;
const getPrototypeOf = Object.getPrototypeOf;
const setPrototypeOf = Object.setPrototypeOf;
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const weakMapGet = WeakMap.prototype.get;
const weakMapSet = WeakMap.prototype.set;
const objectEntries = Object.entries;
const objectPrototype = Object.prototype;
const isView = ArrayBuffer.isView;
const getter = (proto: object | undefined, key: string) =>
  proto ? Object.getOwnPropertyDescriptor(proto, key)?.get : undefined;
// Brand checks: these intrinsic getters throw unless their receiver really is that kind of
// buffer, so proxies and look-alikes fail. `resizable` / `detached` exist only on engines
// that support resizable buffers and transfer(); where absent the state cannot occur.
const abByteLength = getter(ArrayBuffer.prototype, 'byteLength')!;
const abResizable = getter(ArrayBuffer.prototype, 'resizable');
const abDetached = getter(ArrayBuffer.prototype, 'detached');
const sabByteLength =
  typeof SharedArrayBuffer === 'function'
    ? getter(SharedArrayBuffer.prototype, 'byteLength')
    : undefined;
// Byte copies use these captured constructors and %TypedArray%.prototype.set, never a
// `length`/`byteLength` property read or a global looked up at call time.
const ArrayBufferCtor = ArrayBuffer;
const Uint8ArrayCtor = Uint8Array;
const typedArraySet = Object.getPrototypeOf(Uint8Array.prototype).set as (
  this: Uint8Array,
  source: Uint8Array,
) => void;
const wasmApi = (globalThis as any).WebAssembly; // absent on Hermes
const wasmMemoryBuffer =
  typeof wasmApi?.Memory === 'function' ? getter(wasmApi.Memory.prototype, 'buffer') : undefined;

/** 0 ArrayBuffer, 1 not a buffer, 2 SharedArrayBuffer, 3 resizable, 4 detached, 5 view. */
function bufferStatus(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 1;
  try {
    reflectApply(abByteLength, value, []);
  } catch {
    if (sabByteLength) {
      try {
        reflectApply(sabByteLength, value, []);
        return 2;
      } catch {
        /* not shared */
      }
    }
    return isView(value) ? 5 : 1;
  }
  if (abDetached && reflectApply(abDetached, value, [])) return 4;
  if (abResizable && reflectApply(abResizable, value, [])) return 3;
  return 0;
}

/** Property semantics for native conversions:
 *  - Input reads (record fields, union tags, array elements, `length`) are ordinary reads,
 *    prototype-inclusive: getters and proxy traps run and their exceptions propagate. The JSI
 *    backend reads natively; the web backend calls `get` (and `length`).
 *  - define: creates an own data property (null-prototype descriptor), so inherited setters
 *    or descriptor-shaped prototype properties cannot intercept output.
 *  - isArray: Array.isArray (proxies of arrays are arrays).
 *  - entries: `Record<string, T>` and `JsonValue` objects enumerate own enumerable string keys
 *    (Object.entries) of plain objects only; ordinary records never enumerate. */
export const conversionHelpers = Object.freeze({
  /** Ordinary read `object[key]` (Reflect.get captured at init). */
  get(object: object, key: string | number): unknown {
    return reflectGet(object, key);
  },
  /** Own-property read (inherited ones read as undefined). No longer used by framework input
   *  conversions, which read ordinarily; kept so the 0.1.0 export surface does not shrink. */
  readOwn(object: object, key: string | number): unknown {
    return reflectApply(hasOwn, object, [key]) ? (object as any)[key] : undefined;
  },
  define(object: object, key: string | number, value: unknown): void {
    defineProperty(object, key, {
      __proto__: null,
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    } as PropertyDescriptor);
  },
  /** Native (Android/iOS JSI) number[] output, before the native fill of a fresh, unpublished array: sets its
   *  prototype to null (so no inherited accessor, non-writable index or proxy can intercept the
   *  indexed writes) and returns the original prototype for `restorePrototype`. */
  detachPrototype(array: object): object | null {
    const prototype = getPrototypeOf(array);
    setPrototypeOf(array, null);
    return prototype;
  },
  /** Native (Android/iOS JSI) number[] output, after the fill: puts back the exact prototype `detachPrototype`
   *  returned, before the array is published. */
  restorePrototype(array: object, prototype: object | null): void {
    setPrototypeOf(array, prototype);
  },
  isArray(value: unknown): boolean {
    return arrayIsArray(value);
  },
  length(array: object): unknown {
    return reflectGet(array, 'length');
  },
  /** Object.entries of a plain object (prototype Object.prototype or null), or null for any
   *  other object. Proxy traps and getters run; their exceptions propagate. */
  entries(value: object): [string, unknown][] | null {
    const proto = getPrototypeOf(value);
    return proto === objectPrototype || proto === null ? objectEntries(value) : null;
  },
  /** 0 ArrayBuffer, 1 not a buffer, 2 SharedArrayBuffer, 3 resizable, 4 detached, 5 view.
   *  Brand checks through intrinsic getters captured at init; runs no user code. (Android:
   *  the JSI adapter then reads size and storage from the engine.) */
  bufferKind: bufferStatus,
  /** Web: the brand-checked byte length of a plain ArrayBuffer, or -status (see bufferKind). */
  byteLength(value: unknown): number {
    const status = bufferStatus(value);
    return status === 0 ? reflectApply(abByteLength, value, []) : -status;
  },
  /** Web: copies all bytes of `value` into Wasm memory at [ptr, ptr + length). Re-checks the
   *  buffer, requires its brand-checked length to equal `length` (what the caller allocated),
   *  and bounds-checks the destination (the Uint8Array constructor throws RangeError). Runs
   *  no user code. Returns false if the buffer no longer qualifies. */
  copyBuffer(value: unknown, memory: object, ptr: number, length: number): boolean {
    if (bufferStatus(value) !== 0 || !wasmMemoryBuffer) return false;
    if (reflectApply(abByteLength, value, []) !== length) return false;
    if (length === 0) return true;
    const target = new Uint8ArrayCtor(
      reflectApply(wasmMemoryBuffer, memory, []) as ArrayBuffer,
      ptr,
      length,
    );
    reflectApply(typedArraySet, target, [new Uint8ArrayCtor(value as ArrayBuffer)]);
    return true;
  },
  /** Web: a new ArrayBuffer holding a copy of Wasm memory [ptr, ptr + length). */
  bytesFromMemory(memory: object, ptr: number, length: number): ArrayBuffer {
    const out = new ArrayBufferCtor(length);
    if (length === 0 || !wasmMemoryBuffer) return out;
    const source = new Uint8ArrayCtor(
      reflectApply(wasmMemoryBuffer, memory, []) as ArrayBuffer,
      ptr,
      length,
    );
    reflectApply(typedArraySet, new Uint8ArrayCtor(out), [source]);
    return out;
  },
  /** Android fallback when the engine refuses external storage: a new ArrayBuffer from the
   *  captured constructor (the adapter verifies it before writing). */
  allocBuffer(length: number): ArrayBuffer {
    return new ArrayBufferCtor(length);
  },
  /** The error to throw for a declared error (spec `Throws<T, E>`) of method `method`. Hosts
   *  whose wrapper declares errors pass their own helpers (see ModuleHost); these shared ones
   *  only report the mismatch. */
  domainError(method: number, _data?: unknown): Error {
    return new RnrsError(
      'failed',
      `@rnrs/runtime: method #${method} reported a declared error, but its wrapper declares none; regenerate the module package and rebuild the app`,
    );
  },
});

/** Value type of the spec's `JsonValue` (generated wrappers use it in signatures). */
export type { JsonValue } from './spec';

export type ErrorCode = 'cancelled' | 'overloaded' | 'closed' | 'failed' | 'lost';

// DomainError brands: error -> [wrapper descriptor, declared type name]. Only errors built
// here have one; not a security boundary.
const domainBrands = new WeakMap<object, readonly [object, string]>();

/** A declared error of a module method (spec `Throws<T, E>`): thrown by sync methods, rejected
 *  by async ones. `name` is the declared type, `data` the Rust `Err` value converted like a
 *  result (plain data, not frozen). Framework failures (argument validation, conversion,
 *  closed, cancelled, lost, overloaded, String errors) are never DomainErrors. Test with the
 *  generated guard (`isKvError(e)`), which checks the brand of the wrapper that declared it. */
export class DomainError<E = unknown> extends Error {
  readonly data: E;
  /** @internal Built by the runtime; a constructed instance has no brand. */
  constructor(name: string, message: string, data: E) {
    super(message);
    this.name = name;
    this.data = data;
  }
}

/** Whether `error` is a DomainError raised for declared type `type` by a module whose wrapper's
 *  descriptor is `descriptor` (generated guards pass their own). */
export function isDomainError(error: unknown, descriptor: object, type: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const brand = reflectApply(weakMapGet, domainBrands, [error]) as
    | readonly [object, string]
    | undefined;
  return brand !== undefined && brand[0] === descriptor && brand[1] === type;
}

/** `[method index, label ('Module.method' / 'Object.method'), declared type, discriminator]`. */
export type DeclaredErrorEntry = readonly [number, string, string, string | null];

/** The `domainError` helper of a wrapper's declared errors, or undefined if it declares none.
 *  Closes over the immutable descriptor and a frozen copy of its table only (never a host). */
function declaredErrors(
  descriptor: ModuleDescriptor,
): ((method: number, data: unknown) => Error) | undefined {
  const list = descriptor.errors;
  if (!list || list.length === 0) return undefined;
  const table: Record<number, DeclaredErrorEntry> = objectCreate(null);
  // Indexed loop: no iterator protocol (Array.prototype may be patched).
  for (let i = 0; i < list.length; i++) {
    const entry = list[i] as unknown as DeclaredErrorEntry;
    table[entry[0]] = objectFreeze([entry[0], entry[1], entry[2], entry[3]] as const);
  }
  objectFreeze(table);
  return (method, data) => {
    const entry = table[method];
    if (entry === undefined)
      return new RnrsError(
        'failed',
        `@rnrs/runtime: ${descriptor.name} method #${method} reported a declared error its wrapper does not declare; regenerate the module package and rebuild the app`,
      );
    // `data` is the fresh payload: the tag is its own data property (no user code runs).
    const tag =
      entry[3] !== null && typeof data === 'object' && data !== null
        ? (data as Record<string, unknown>)[entry[3]]
        : undefined;
    const error = new DomainError(
      entry[2],
      typeof tag === 'string' ? `${entry[1]} failed: ${tag}` : `${entry[1]} failed`,
      data,
    );
    reflectApply(weakMapSet, domainBrands, [error, objectFreeze([descriptor, entry[2]] as const)]);
    return error;
  };
}

export class RnrsError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** For `overloaded`: this module's own slots, or the executor budget shared by every
     *  runtime generation in the process (which may be held by work of closed runtimes). */
    readonly scope?: 'module' | 'executor',
  ) {
    super(message);
    this.name = code === 'cancelled' ? 'AbortError' : 'RnrsError';
  }
}

/** Admission refused by the native side, with the native (Rust) error text. */
export interface AdmitFailure {
  /** -1 closed, -2 module overloaded, -3 executor budget full. */
  code: -1 | -2 | -3;
  message: string;
}

export interface CallOptions {
  /** Cooperative cancellation: abort requests it; the outcome still arrives once. */
  signal?: AbortSignal;
}

export interface NativeCounts {
  created: number;
  dropped: number;
}

export interface AdapterStats {
  generation: number;
  open: number;
  pending: number;
  inFlight: number;
  queued: number;
  /** Admission slots in use: running work or undrained outcomes. */
  slots: number;
  admitted: number;
  delivered: number;
  discarded: number;
  lost: number;
  hostsCreated: number;
  hostsTornDown: number;
  hostsFreed: number;
  /** Live Rust objects per native type of this module. */
  native: Record<string, NativeCounts>;
  /** Android: teardowns by path, totals over teardowns, process executor budget,
   *  NativeState finalizer threads. */
  tornDownExplicit?: number;
  tornDownLifecycle?: number;
  tornDownDestructor?: number;
  tornDownRefused?: number;
  teardownCancelled?: number;
  teardownDiscardedQueued?: number;
  teardownStillRunning?: number;
  budgetLimit?: number;
  budgetRunning?: number;
  budgetOrphaned?: number;
  budgetPeak?: number;
  budgetRejected?: number;
  nativeFinalizers?: number;
  nativeFinalizersOffJsThread?: number;
  scopeId?: number;
}

/** One adapter generation as a backend exposes it. */
export interface NativeAdapter {
  readonly generation: number;
  /** Sync methods return their result; async methods an operation id or an AdmitFailure.
   *  `args` is passed as one array (no spread), so Array.prototype cannot observe it. */
  call(index: number, receiver: object | undefined, args: unknown[]): unknown;
  /** Sync calls with 0 to 4 positional arguments (no argument array is built or read). */
  call0(index: number, receiver: object | undefined): unknown;
  call1(index: number, receiver: object | undefined, a0: unknown): unknown;
  call2(index: number, receiver: object | undefined, a0: unknown, a1: unknown): unknown;
  call3(
    index: number,
    receiver: object | undefined,
    a0: unknown,
    a1: unknown,
    a2: unknown,
  ): unknown;
  call4(
    index: number,
    receiver: object | undefined,
    a0: unknown,
    a1: unknown,
    a2: unknown,
    a3: unknown,
  ): unknown;
  /** The prepared entry of a scalar method (protocol 3 wrappers call it as
   *  `this.host.m<index>(...arguments)`, with the host as `this`). Throws if the backend
   *  cannot provide it. Optional: backends without it still serve protocol 1/2 modules;
   *  ModuleHost refuses protocol 3 modules on them. */
  entry?(index: number, arity: number): (...args: any[]) => unknown;
  cancel(id: number): boolean;
  dispose(handle: object): void;
  teardown(): void;
  stats(): AdapterStats;
  /** Optional worklet endpoint (JSI backend only; see ./worklets). */
  workletEndpoint?(methods: readonly string[]): object;
  workletBox?(endpoint: object, handle: object): object;
}

export type SettleFn = (id: number, status: number, value: unknown, message: string) => void;

export interface Backend {
  readonly platform: string;
  /** `helpers`: this host's conversion helpers when its wrapper declares errors (the shared
   *  `conversionHelpers` plus its own `domainError`); backends use them for every sync call of
   *  this adapter. Absent: the shared `conversionHelpers`. */
  install(
    name: string,
    hash: string,
    maxInFlight: number,
    settle: SettleFn,
    helpers?: typeof conversionHelpers,
  ): NativeAdapter;
  /** Called after a test-hook teardown, so the backend stops routing settlements. */
  release?(adapter: NativeAdapter): void;
}

let backend: Backend | undefined;
let missingBackend =
  '@rnrs/runtime: no platform backend is installed (import @rnrs/runtime under React Native, or call initRnrs from @rnrs/runtime/web in the browser)';

/** Called once by the platform entry point (native.ts, web.ts) or a test harness. */
export function setBackend(b: Backend): void {
  if (backend !== b) runtimeModules.clear();
  backend = b;
}

/** The error shown when a module is used before its platform backend exists. */
export function setMissingBackendMessage(message: string): void {
  missingBackend = message;
}

function currentBackend(): Backend {
  if (!backend) throw new Error(missingBackend);
  return backend;
}

const Status = { Ok: 0, Cancelled: 1, Failed: 2, Lost: 3, Domain: 4 } as const;

interface PendingOperation {
  method: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  detach(): void;
  wrap?: (value: unknown) => unknown;
}

function admitError(failure: AdmitFailure): RnrsError {
  switch (failure.code) {
    case -1:
      return new RnrsError('closed', failure.message);
    case -2:
      return new RnrsError('overloaded', failure.message, 'module');
    default:
      return new RnrsError('overloaded', failure.message, 'executor');
  }
}

/** Own property of every ModuleHost holding the conversion helpers, so a native scalar entry
 *  called with the host as `this` finds them on its error path (RnrsJsi.cpp kHostHelpers). */
export const HOST_HELPERS_KEY = 'rnrs:helpers';

/** One installed adapter generation and its promise registry. */
export class ModuleHost {
  private readonly pendingOps = new Map<number, PendingOperation>();
  private closed = false;
  /** Settlements that violate the contract (duplicate, unknown, or after close). */
  readonly violations: string[] = [];
  readonly adapter: NativeAdapter;
  /** Builds the DomainError of a declared error (descriptor metadata only, no host). */
  private readonly declared: (method: number, data: unknown) => Error;

  constructor(
    readonly name: string,
    hash: string,
    maxInFlight: number,
    readonly runtimeOwned: boolean,
    direct: readonly (readonly number[])[] = [],
    descriptor?: ModuleDescriptor,
  ) {
    const declared = descriptor && declaredErrors(descriptor);
    // Hosts of wrappers with declared errors carry their own helpers on every sync path.
    const helpers = declared
      ? objectFreeze({ ...conversionHelpers, domainError: declared })
      : conversionHelpers;
    this.declared = declared ?? conversionHelpers.domainError;
    this.adapter = currentBackend().install(
      name,
      hash,
      maxInFlight,
      (id, status, value, message) => this.settle(id, status, value, message),
      declared ? helpers : undefined,
    );
    const self = this as any;
    self.call0 = this.adapter.call0;
    self.call1 = this.adapter.call1;
    self.call2 = this.adapter.call2;
    self.call3 = this.adapter.call3;
    self.call4 = this.adapter.call4;
    // Fixed, before any entry can be called: own, non-writable, non-configurable,
    // non-enumerable (descriptor defaults).
    defineProperty(this, HOST_HELPERS_KEY, {
      __proto__: null,
      value: helpers,
    } as PropertyDescriptor);
    // Indexed loop: no iterator protocol (Array.prototype could be patched by then). A
    // backend that cannot provide an entry refuses the module; nothing stays installed.
    try {
      if (direct.length && typeof this.adapter.entry !== 'function')
        throw new Error(
          `@rnrs/runtime: the ${currentBackend().platform} backend has no prepared scalar entries, which ${name} (call protocol 3) needs; use a backend from this @rnrs/runtime`,
        );
      for (let i = 0; i < direct.length; i++) {
        const index = direct[i][0];
        self[`m${index}`] = this.adapter.entry!(index, direct[i][1]);
      }
    } catch (error) {
      try {
        this.adapter.teardown();
      } catch {
        /* reported error stays the refusal */
      }
      currentBackend().release?.(this.adapter);
      throw error;
    }
  }

  get generation(): number {
    return this.adapter.generation;
  }

  /** Called by the backend on the JS thread for each terminal outcome. */
  settle(id: number, status: number, value: unknown, message: string): void {
    const operation = this.pendingOps.get(id);
    if (!operation) {
      this.violations.push(
        `${this.closed ? 'after close' : 'unknown or duplicate'}: op ${id} status ${status}`,
      );
      return;
    }
    this.pendingOps.delete(id);
    operation.detach();
    switch (status) {
      case Status.Ok:
        try {
          operation.resolve(operation.wrap ? operation.wrap(value) : value);
        } catch (error) {
          operation.reject(new RnrsError('failed', String(error)));
        }
        break;
      case Status.Cancelled:
        operation.reject(new RnrsError('cancelled', 'operation cancelled'));
        break;
      case Status.Lost:
        operation.reject(new RnrsError('lost', 'executor dropped the operation'));
        break;
      case Status.Domain: {
        const error = this.declared(operation.method, value);
        if (!(error instanceof DomainError))
          this.violations.push(`undeclared declared error: op ${id} method ${operation.method}`);
        operation.reject(error);
        break;
      }
      default:
        operation.reject(new RnrsError('failed', message));
    }
  }

  /** Sync call (generated wrappers). */
  call(index: number, receiver: object | undefined, args: unknown[]): unknown {
    return this.adapter.call(index, receiver, args);
  }

  /** Sync calls with up to four positional arguments (generated wrappers). */
  // The adapter's own entries (no forwarding frame); assigned in the constructor.
  readonly call0!: NativeAdapter['call0'];
  readonly call1!: NativeAdapter['call1'];
  readonly call2!: NativeAdapter['call2'];
  readonly call3!: NativeAdapter['call3'];
  readonly call4!: NativeAdapter['call4'];
  /** Prepared scalar entries by method index (protocol 3; assigned in the constructor). */
  readonly [entry: `m${number}`]: (...args: any[]) => unknown;

  /** Async call: admission, cancellation wiring and promise bookkeeping. */
  start(
    index: number,
    receiver: object | undefined,
    args: unknown[],
    options: CallOptions | undefined,
    wrap?: (value: unknown) => unknown,
  ): Promise<unknown> {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(new RnrsError('cancelled', 'aborted before start'));
    let started: unknown;
    try {
      started = this.adapter.call(index, receiver, args);
    } catch (error) {
      return Promise.reject(error);
    }
    if (typeof started !== 'number') return Promise.reject(admitError(started as AdmitFailure));
    const id = started;
    return new Promise((resolve, reject) => {
      // Abort only requests cancellation; the outcome still arrives through settle().
      const onAbort = () => {
        this.adapter.cancel(id);
      };
      signal?.addEventListener('abort', onAbort);
      this.pendingOps.set(id, {
        method: index,
        resolve,
        reject,
        wrap,
        detach: () => signal?.removeEventListener('abort', onAbort),
      });
    });
  }

  cancel(id: number): boolean {
    return this.adapter.cancel(id);
  }

  dispose(handle: object): void {
    this.adapter.dispose(handle);
  }

  stats(): AdapterStats {
    return this.adapter.stats();
  }

  /** Test hook: explicit teardown while JS is still alive. Rejects pending promises here;
   *  the backend guarantees no later outcome for this generation. */
  teardown(): void {
    if (this.runtimeOwned)
      throw new Error('the runtime-scoped module is torn down by the framework with its runtime');
    if (this.closed) return;
    this.closed = true;
    this.adapter.teardown();
    currentBackend().release?.(this.adapter);
    const operations = [...this.pendingOps.values()];
    this.pendingOps.clear();
    for (const operation of operations) {
      operation.detach();
      operation.reject(new RnrsError('closed', 'runtime adapter torn down'));
    }
  }
}

/** Base of generated module classes. */
export abstract class ModuleBase {
  constructor(/** @internal */ readonly host: ModuleHost) {}
  get generation(): number {
    return this.host.generation;
  }
  get runtimeOwned(): boolean {
    return this.host.runtimeOwned;
  }
  get violations(): readonly string[] {
    return this.host.violations;
  }
  stats(): AdapterStats {
    return this.host.stats();
  }
  /** Test hook only (see ModuleHost.teardown). */
  teardown(): void {
    this.host.teardown();
  }
}

/** Worklet endpoints (./worklets) do not carry declared errors (spec Throws): a listed method
 *  (`'get'`, `'Type.method'`) that declares one is refused before the endpoint exists. */
export function refuseDeclaredErrorsOnWorklets(
  module: ModuleBase,
  methods: readonly string[],
): void {
  const errors = (module.constructor as { descriptor?: ModuleDescriptor }).descriptor?.errors;
  if (!errors) return;
  for (const name of methods) {
    const label = name.includes('.') ? name : `${module.host.name}.${name}`;
    if (errors.some((entry) => entry[1] === label)) {
      const error = new TypeError(
        `${name}: methods with declared errors (Throws) are not available on worklet endpoints`,
      );
      (error as TypeError & { code: string }).code = 'ERR_RNRS_WORKLET_THROWS';
      throw error;
    }
  }
}

/** Base of generated native-object classes: a wrapper owning one native handle. */
export abstract class NativeObjectBase {
  constructor(
    /** @internal */ readonly host: ModuleHost,
    /** @internal */ readonly handle: object,
  ) {}
  /** Releases this wrapper's handle now; in-flight operations keep the object alive. */
  dispose(): void {
    this.host.dispose(this.handle);
  }
}

/** Native wrapper -> handle for the adapter; anything else passes through for the native
 *  side to reject with a typed error. */
export function handleOf(value: unknown): unknown {
  return value instanceof NativeObjectBase ? value.handle : value;
}

/** A generated wrapper's static descriptor. `protocol`: the wrapper/runtime call protocol the
 *  wrapper uses (1 or absent: argument arrays only; 2: also positional host.call0..call4; 3:
 *  also the prepared scalar entries host.m<index> listed in `direct` as [index, arity]; 4: also
 *  declared errors, listed in `errors`). The object's identity brands its DomainErrors. */
export interface ModuleDescriptor {
  name: string;
  hash: string;
  defaultMaxInFlight: number;
  protocol?: number;
  direct?: readonly (readonly number[])[];
  /** `DeclaredErrorEntry` tuples (typed loosely, like `direct`, as wrappers declare literals). */
  errors?: readonly (readonly (number | string | null)[])[];
}

export interface ModuleClass<M extends ModuleBase> {
  new (host: ModuleHost): M;
  readonly descriptor: ModuleDescriptor;
}

/** The newest wrapper call protocol this runtime implements. */
export const RUNTIME_PROTOCOL = 4;

/** Refuses wrappers generated for a newer runtime, with an actionable message. */
export function checkWrapperProtocol(descriptor: { name: string; protocol?: number }): void {
  const protocol = descriptor.protocol ?? 1;
  if (protocol > RUNTIME_PROTOCOL)
    throw new Error(
      `@rnrs/runtime: ${descriptor.name} was generated for call protocol ${protocol}, but this @rnrs/runtime implements up to ${RUNTIME_PROTOCOL}; update @rnrs/runtime to the version that generated the module package`,
    );
}

// JS module state is per runtime, so this map is runtime-scoped.
const runtimeModules = new Map<string, ModuleBase>();

/** The runtime's framework-owned instance of a module (generated accessors call this). */
export function runtimeModule<M extends ModuleBase>(cls: ModuleClass<M>): M {
  checkWrapperProtocol(cls.descriptor);
  const { name, hash, defaultMaxInFlight, direct } = cls.descriptor;
  let module = runtimeModules.get(name);
  if (!module) {
    module = new cls(new ModuleHost(name, hash, defaultMaxInFlight, true, direct, cls.descriptor));
    runtimeModules.set(name, module);
  }
  return module as M;
}

/** Test hook: an extra adapter generation; the caller tears it down. */
export function createModuleForTesting<M extends ModuleBase>(
  cls: ModuleClass<M>,
  maxInFlight: number,
): M {
  checkWrapperProtocol(cls.descriptor);
  const { name, hash, direct } = cls.descriptor;
  return new cls(new ModuleHost(name, hash, maxInFlight, false, direct, cls.descriptor));
}
