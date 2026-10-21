// The fresh Vite consumer: load the app's Wasm bundle, then run the smoke test.
import { initRnrs } from '@rnrs/runtime/web';
import * as bundle from './.rnrs/web/pkg/rnrs_bundle.js';
import { runSmoke } from './smoke';

async function main() {
  await initRnrs(bundle);
  const result = await runSmoke();
  (globalThis as any).__rnrsResult = { platform: 'web', userAgent: navigator.userAgent, ...result };
  document.getElementById('out')!.textContent = JSON.stringify(result, null, 2);
}
main().catch((error) => {
  (globalThis as any).__rnrsResult = {
    platform: 'web',
    ok: false,
    checks: [],
    error: String(error?.stack ?? error),
  };
});
