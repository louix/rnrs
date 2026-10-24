// JSI backend for Android and iOS (framework, module-independent). Requiring the framework's
// `RnrsRuntime` module makes React Native call its JSI bindings installer on this runtime
// (Android: BindingsInstallerHolder; iOS: RCTTurboModuleWithJSIBindings). React Native later
// invalidates that module when the runtime is reloaded or destroyed, which tears down every
// adapter installed here. Call installJsiBackend() once at startup (an explicit call rather
// than an import side effect: Metro inlines requires).
import { TurboModuleRegistry } from 'react-native';
import {
  bindThis,
  conversionHelpers,
  setBackend,
  type AdapterStats,
  type Backend,
  type NativeAdapter,
  type SettleFn,
} from './runtime';

export interface LifecycleStats {
  scopesCreated: number;
  scopesDestroyed: number;
  scopesInvalidated: number;
  /** Invalidations where java.lang.Thread.isAlive was still true for the JS thread. */
  invalidateJsThreadAlive: number;
  /** Invalidations where the (terminated) JS thread's kernel task entry still existed. */
  invalidateJsTaskLingering: number;
  invalidateOnJsThread: number;
  adaptersAliveAtInvalidate: number;
  adaptersTornDownAtInvalidate: number;
  adaptersDestroyedAfterInvalidate: number;
  adaptersDestroyedBeforeInvalidate: number;
  registrationsRefused: number;
  /** Drain tasks posted through the CallInvoker, run on the JS thread, and run but skipped
   *  because their adapter was gone or closed. Posted minus both: never run. */
  drainsPosted: number;
  drainsRun: number;
  drainsSkipped: number;
  /** Posted drain tasks destroyed without running (React Native's scheduler cleared its
   *  queue); the host posts again (rnrs-core Host::monitor_delivery). */
  drainsDropped: number;
  /** Device wall clock (ms) of the latest scope invalidation. */
  lastInvalidateAtMs: number;
  /** Runtimes that installed the bindings in this process (survives reloads). */
  bindingsInstalled: number;
  lastInvalidateThread: string;
  jsThreadName: string;
  /** Worklet endpoint (./worklets), process-wide: endpoints and boxed handles created,
   *  boxes released (and released off the creating thread), calls (and calls off the
   *  creating thread), calls refused as closed or for their value shapes. */
  workletEndpoints: number;
  workletBoxesCreated: number;
  workletBoxesReleased: number;
  workletBoxesReleasedOffCreator: number;
  workletCalls: number;
  workletCallsOffCreator: number;
  workletRefusedClosed: number;
  workletRefusedShape: number;
  /** Test-hooks builds: wall time of endpoint calls off the creating thread (diagnostic). */
  workletOffCreatorNsTotal?: number;
  workletOffCreatorNsMax?: number;
}

/** The JSI adapter object: every call carries the framework conversion helpers. */
interface RawAdapter {
  readonly generation: number;
  call(helpers: object, index: number, receiver: object | undefined, args: unknown[]): unknown;
  /** The same with 0 to 4 positional arguments (no argument array), helpers as `this`. */
  callh(this: object, index: number, receiver: object | undefined, ...args: unknown[]): unknown;
  /** The prepared host function of a generated scalar method, or undefined if the native
   *  library has none for that index. */
  entry(index: number): ((...args: any[]) => unknown) | undefined;
  cancel(id: number): boolean;
  dispose(handle: object): void;
  teardown(): void;
  stats(helpers: object): AdapterStats;
  workletEndpoint?(methods: readonly string[]): object;
  workletBox?(endpoint: object, handle: object): object;
}

interface RuntimeBindings {
  readonly scopeId: number;
  /** Adapters and these bindings refuse calls from other JS runtimes (ERR_RNRS_FOREIGN_RUNTIME). */
  readonly runtimeGuard?: boolean;
  readonly platform: JsiPlatform;
  install(name: string, hash: string, maxInFlight: number): RawAdapter;
  lifecycle(): LifecycleStats;
  /** Whether the native test hooks below were compiled in (RNRS_TEST_HOOKS: Android Gradle
   *  property rnrs.testHooks=true, iOS RNRS_TEST_HOOKS=1 at pod install). Default: false. */
  readonly testHooks: boolean;
  /** Test hook: invalidates this runtime's scope while JS is running. */
  invalidateForTesting?(): void;
  /** Test hook: ArrayBuffer results take the copy fallback (as if external storage were refused). */
  forceBytesCopyOutForTesting?(force: boolean): void;
  /** Test hook: forced full GC through JSI instrumentation. */
  collectGarbageForTesting?(): void;
  /** Test hook (iOS only): reloads through React Native's own reload path
   *  (RCTTriggerReloadCommandListeners, which reloads every host in the process), since
   *  release builds have no JS-reachable reload. */
  reloadForTesting?(): void;
}

export function runtimeBindings(): RuntimeBindings {
  const global = globalThis as any;
  if (!global.__rnrsRuntime) TurboModuleRegistry.get('RnrsRuntime');
  if (!global.__rnrsRuntime)
    throw new Error('rnrs: the RnrsRuntime framework module is not linked into this app');
  return global.__rnrsRuntime;
}

// Native drains settle through one global entry point, routed by generation. Entries: the
// runtime-scoped modules, which live as long as the runtime, plus open test-hook modules
// until their teardown(). Settlements to unknown generations are ignored.
const settles = new Map<number, SettleFn>();

/** Open adapters in the settle registry (diagnostics). */
export function registeredModuleCount(): number {
  return settles.size;
}

/** The native adapter must provide the entries this JS runtime calls; a native library from an
 *  older @rnrs/runtime lacks the positional entry. Throws an actionable error. */
export function checkNativeAdapter(
  raw: { callh?: unknown; call?: unknown; entry?: unknown },
  name: string,
): void {
  for (const entry of ['call', 'callh', 'entry'] as const) {
    if (typeof raw[entry] !== 'function')
      throw new Error(
        `@rnrs/runtime: the app's native library does not match this JS runtime: module ${name} has no "${entry}" entry. Rebuild the native app (Android: librnrs.so; iOS: pod install) so it comes from the installed @rnrs/runtime.`,
      );
  }
}

function jsiBackend(platform: JsiPlatform): Backend {
  return {
    platform,
    install(name, hash, maxInFlight, settle) {
      const raw = runtimeBindings().install(name, hash, maxInFlight);
      try {
        checkNativeAdapter(raw, name);
      } catch (error) {
        // Do not leave a refused adapter registered with the runtime scope; a failing
        // teardown must not replace the original error.
        try {
          raw.teardown();
        } catch {
          /* reported error stays the mismatch */
        }
        throw error;
      }
      settles.set(raw.generation, settle);
      const global = globalThis as any;
      if (!global.__rnrsSettle) {
        const entry = (
          generation: number,
          id: number,
          status: number,
          value: unknown,
          message: string,
        ) => {
          settles.get(generation)?.(id, status, value, message);
        };
        // Drains convert results with these helpers (read by the JSI adapter).
        Object.defineProperty(entry, 'helpers', { value: conversionHelpers });
        global.__rnrsSettle = entry;
      }
      const callh = bindThis(raw.callh, conversionHelpers);
      const adapter: NativeAdapter = {
        generation: raw.generation,
        call: (index, receiver, args) => raw.call(conversionHelpers, index, receiver, args),
        // Fixed arities: callh bound to the helpers as `this` (captured bind), so a generated
        // wrapper calls the host function with its explicit parameters directly (no spread or
        // rest, no forwarding frame, no extra helpers argument). The callers pass exactly
        // index, receiver and their arguments.
        call0: callh as NativeAdapter['call0'],
        call1: callh as NativeAdapter['call1'],
        call2: callh as NativeAdapter['call2'],
        call3: callh as NativeAdapter['call3'],
        call4: callh as NativeAdapter['call4'],
        // Generated wrapper and native library come from the same spec and generator; a
        // missing entry means mismatched builds, refused before the first call.
        entry: (index) => {
          const f = raw.entry(index);
          if (typeof f !== 'function')
            throw new Error(
              `@rnrs/runtime: the app's native library does not match this module: ${name} has no prepared entry for method ${index}. Rebuild the native app (Android: librnrs.so; iOS: pod install) from the installed module package.`,
            );
          return f;
        },
        cancel: (id) => raw.cancel(id),
        dispose: (handle) => raw.dispose(handle),
        teardown: () => raw.teardown(),
        stats: () => raw.stats(conversionHelpers),
        // Absent on native libraries without the worklet endpoint.
        workletEndpoint: raw.workletEndpoint && ((methods) => raw.workletEndpoint!(methods)),
        workletBox: raw.workletBox && ((endpoint, handle) => raw.workletBox!(endpoint, handle)),
      };
      return adapter;
    },
    release(adapter) {
      settles.delete(adapter.generation);
    },
  };
}

export type JsiPlatform = 'android' | 'ios';

export function installJsiBackend(platform: JsiPlatform): Backend {
  const backend = jsiBackend(platform);
  setBackend(backend);
  return backend;
}

/** The Android lab harness's entry point. */
export const installAndroidBackend = (): Backend => installJsiBackend('android');
