// Optional worklet support, prototype. Android JSI
// backend only; iOS and web are untested. Imports nothing from react-native-worklets,
// Reanimated or Gesture Handler: the app passes worklets' public `registerCustomSerializable`.
//
// - workletEndpoint(module, methods): a HostObject exposing the listed *sync* methods of the
//   runtime's module (`'scale'`) and of its native objects (`'Accumulator.add'`), callable
//   from the RN runtime, the UI runtime and worklet runtimes. Arguments and results are
//   numbers, booleans, undefined, null and boxed native objects only; anything else throws a
//   TypeError with code ERR_RNRS_WORKLET_SHAPE (a refused result is detected after the method
//   ran). Async methods are refused when the endpoint is created (ERR_RNRS_WORKLET_ASYNC), and
//   so, here in JS, are methods with declared errors (ERR_RNRS_WORKLET_THROWS); a raw endpoint
//   created without this check would run such a method and only then refuse its error.
//   Teardown (reload) refuses new calls: later calls throw ERR_RNRS_CLOSED. A call already in
//   progress is not waited for; it completes and may change process-shared state after the
//   teardown. An uncaught error in a UI-thread worklet crashes the app under Reanimated
//   (observed on device), so every worklet that can run after teardown (gesture handlers,
//   reactions, frame callbacks) must catch errors, using isRnrsClosedError to tell the
//   expected closed error from real failures. `endpoint.$open` only lets it skip calls
//   cheaply; teardown can still happen between the check and the call.
//   Endpoints and boxes keep the module's adapter and Rust instance allocated until the last
//   of them is garbage-collected, possibly by the UI runtime after the next runtime started;
//   Drop of the module and its objects can then run on the UI or a finalizer thread. Such
//   modules must not block in Drop or hold exclusive resources across runtime generations:
//   generations isolate adapters, not process-wide resources.
// - enableWorklets(worklets): native-object wrappers captured by a worklet cross as boxed
//   handles: HostObjects with the allow-listed methods of their type, owning their own
//   reference to the object (disposing the RN wrapper does not affect them). Worklets shares
//   HostObjects between runtimes by reference; that is undocumented upstream behaviour,
//   checked by the lab tests.
// Rust methods run on the calling runtime's thread (often the UI thread): they must be
// short, bounded and non-blocking, and their state Send + Sync. The framework does not
// enforce that.
import {
  NativeObjectBase,
  refuseDeclaredErrorsOnWorklets,
  type ModuleBase,
  type ModuleHost,
} from './runtime';

/** The part of react-native-worklets this module uses (pass the package's exports). */
export interface WorkletsRegistrar {
  registerCustomSerializable(data: {
    name: string;
    determine: (value: object) => boolean;
    pack: (value: object) => object;
    unpack: (value: object) => object;
  }): void;
}

/** An endpoint: the listed module methods, plus `$open` (false once the RN runtime that created it
 *  is torn down; a hint, since teardown can race a call). */
export type WorkletEndpoint<Methods> = Methods & { readonly $open: boolean };

/** Whether `error` is the endpoint's closed error (ERR_RNRS_CLOSED). Callable in worklets. */
export function isRnrsClosedError(error: unknown): boolean {
  'worklet';
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ERR_RNRS_CLOSED'
  );
}

/** The latest endpoint per module, used to box that module's native objects. */
const endpoints = new WeakMap<ModuleHost, object>();

/** Allow-listed sync methods of `module` (module methods by name, object methods as
 *  `'Type.method'`), callable from any JS runtime. Capture the result in worklets. */
export function workletEndpoint<M extends ModuleBase, K extends string>(
  module: M,
  methods: readonly K[],
): WorkletEndpoint<Pick<M, Extract<K, keyof M>>> {
  const host = module.host;
  const create = host.adapter.workletEndpoint;
  if (!create)
    throw new Error(
      '@rnrs/runtime/worklets: this platform backend has no worklet endpoint (prototype: Android only)',
    );
  const list = Array.from(methods);
  refuseDeclaredErrorsOnWorklets(module, list);
  const endpoint = create(list);
  endpoints.set(host, endpoint);
  return endpoint as WorkletEndpoint<Pick<M, Extract<K, keyof M>>>;
}

function boxWrapper(wrapper: NativeObjectBase): object {
  const endpoint = endpoints.get(wrapper.host);
  const box = wrapper.host.adapter.workletBox;
  if (!endpoint || !box)
    throw new Error(
      `@rnrs/runtime/worklets: call workletEndpoint(module, [...]) listing this object's methods before passing a ${wrapper.constructor.name} to a worklet`,
    );
  return box(endpoint, wrapper.handle);
}

/** Registers how native-object wrappers cross into worklets (once per RN runtime). */
export function enableWorklets(worklets: WorkletsRegistrar): void {
  // Read by the serializer callbacks below on the RN runtime only; they capture nothing, so
  // their copies in other runtimes see no boxer there and claim no values.
  (globalThis as any).__rnrsWorkletBoxer = Object.freeze({
    isWrapper: (value: object) => value instanceof NativeObjectBase,
    pack: boxWrapper,
  });
  worklets.registerCustomSerializable({
    name: 'rnrs.NativeObject',
    determine: (value: object): boolean => {
      'worklet';
      const boxer = (globalThis as any).__rnrsWorkletBoxer;
      return boxer !== undefined && boxer.isWrapper(value);
    },
    pack: (value: object): object => {
      'worklet';
      return (globalThis as any).__rnrsWorkletBoxer.pack(value);
    },
    unpack: (box: object): object => {
      'worklet';
      return box;
    },
  });
}
