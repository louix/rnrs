// Binary-first web consumer: the modules come from the app's registry (rnrs build --target web).
import { initRnrs } from '@rnrs/runtime/web';
import * as modules from './.rnrs/web/rnrs.js';
import { runSmoke } from './web-smoke';

async function main() {
  await initRnrs(modules);
  (globalThis as any).__rnrsResult = {
    platform: 'web',
    instances: modules.instances.length,
    ...(await runSmoke()),
  };
}
main().catch((error) => {
  (globalThis as any).__rnrsResult = {
    ok: false,
    checks: [],
    error: String(error?.stack ?? error),
  };
});
