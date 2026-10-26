// Browser entry of @rnrs/runtime. Headless use has no surface dependency.
import { installWebBackend, type RnrsWasm, type WebBootstrapFactory } from './web-backend';
import { setMissingBackendMessage } from './runtime';
export * from './runtime';
export { installWebBackend } from './web-backend';
export type { RnrsWasm, WebBootstrap, WebBootstrapFactory } from './web-backend';

setMissingBackendMessage(
  "@rnrs/runtime: call `await initRnrs(modules)` (from '@rnrs/runtime/web', with the app's module " +
    "registry written by `rnrs build --target web`: import * as modules from '<app>/.rnrs/web/rnrs.js') before using Rust modules",
);

/** One Wasm instance's wasm-bindgen module (its `default` export initializes it). */
export interface RnrsBundle extends RnrsWasm {
  default(input?: { module_or_path: unknown } | unknown): Promise<unknown>;
}
/** The app's module registry (`<app>/.rnrs/web/rnrs.js`, from `rnrs build --target web`): the
 *  Wasm instances to load, the source bundle (if any) first. */
export interface RnrsRegistry {
  readonly instances: readonly RnrsBundle[];
  /** The source bundle (also `instances[0]`), or null when every module is prebuilt. */
  readonly source?: RnrsBundle | null;
}
export interface InitRnrsOptions {
  bootstrap?: WebBootstrapFactory;
}
let initialized: Promise<void> | undefined;
let initializedBundle: RnrsBundle | RnrsRegistry | undefined;
let initializedBootstrap: WebBootstrapFactory | undefined;

/** Loads the app's modules: its registry (every Wasm instance it lists), or one bundle. Calls with
 * the same registry/bundle and bootstrap share initialization; failed loads or bootstrap
 * creation can retry. `wasm` overrides the location of a single bundle's .wasm file. The
 * optional framework bootstrap receives the source bundle (the first instance), without adding
 * a surface dependency to headless applications.
 * Low-level installWebBackend replaces the one active backend in this JS realm; do not
 * mix that testing/framework replacement API with memoized application initRnrs calls. */
export function initRnrs(
  bundle: RnrsBundle | RnrsRegistry,
  wasm?: unknown,
  options: InitRnrsOptions = {},
): Promise<void> {
  if (initialized && initializedBundle !== bundle)
    return Promise.reject(
      new Error(
        '@rnrs/runtime: initRnrs was already called with another bundle or module registry; an app has one',
      ),
    );
  if (initialized && initializedBootstrap !== options.bootstrap)
    return Promise.reject(
      new Error('@rnrs/runtime: initRnrs was already called with another bootstrap'),
    );
  if (!initialized) {
    initializedBundle = bundle;
    initializedBootstrap = options.bootstrap;
    const attempt: Promise<void> = (async () => {
      if ('instances' in bundle) {
        if (wasm !== undefined)
          throw new Error(
            '@rnrs/runtime: a .wasm location applies to a single bundle, not to a module registry',
          );
        // Framework extensions live in the source bundle; never hand them a prebuilt instance.
        if (options.bootstrap && (!bundle.source || bundle.source !== bundle.instances[0]))
          throw new Error(
            '@rnrs/runtime: a bootstrap (surfaces) needs the app source bundle, but every module of this registry is prebuilt; list the surface modules in rustNativeApp.sourceBuild',
          );
        await Promise.all(bundle.instances.map((instance) => instance.default()));
        installWebBackend(bundle.instances, options.bootstrap);
      } else {
        await bundle.default(wasm === undefined ? undefined : { module_or_path: wasm });
        installWebBackend(bundle, options.bootstrap);
      }
    })();
    initialized = attempt;
    attempt.catch(() => {
      if (initialized === attempt) {
        initialized = undefined;
        initializedBundle = undefined;
        initializedBootstrap = undefined;
      }
    });
  }
  return initialized;
}
