// Browser entry of @rnrs/runtime. Headless use has no surface dependency.
import { installWebBackend, type RnrsWasm, type WebBootstrapFactory } from './web-backend';
import { setMissingBackendMessage } from './runtime';
export * from './runtime';
export { installWebBackend } from './web-backend';
export type { RnrsWasm, WebBootstrap, WebBootstrapFactory } from './web-backend';

setMissingBackendMessage(
  "@rnrs/runtime: call `await initRnrs(bundle)` (from '@rnrs/runtime/web', with the app's generated " +
    "Wasm bundle: import * as bundle from '<app>/.rnrs/web/pkg/rnrs_bundle.js') before using Rust modules",
);

export interface RnrsBundle extends RnrsWasm {
  default(input?: { module_or_path: unknown } | unknown): Promise<unknown>;
}
export interface InitRnrsOptions {
  bootstrap?: WebBootstrapFactory;
}
let initialized: Promise<void> | undefined;
let initializedBundle: RnrsBundle | undefined;
let initializedBootstrap: WebBootstrapFactory | undefined;

/** Loads one bundle per app. Same-bundle/bootstrap calls share initialization; failed
 * loads or bootstrap creation can retry. The optional framework bootstrap receives the
 * exact generated bundle, without adding a surface dependency to headless applications.
 * Low-level installWebBackend replaces the one active backend in this JS realm; do not
 * mix that testing/framework replacement API with memoized application initRnrs calls. */
export function initRnrs(
  bundle: RnrsBundle,
  wasm?: unknown,
  options: InitRnrsOptions = {},
): Promise<void> {
  if (initialized && initializedBundle !== bundle)
    return Promise.reject(
      new Error(
        '@rnrs/runtime: initRnrs was already called with another bundle; an app has one Wasm bundle',
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
      await bundle.default(wasm === undefined ? undefined : { module_or_path: wasm });
      installWebBackend(bundle, options.bootstrap);
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
