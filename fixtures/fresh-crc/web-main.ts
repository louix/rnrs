// The fresh Vite consumer: load the app's Wasm bundle, then run the smoke test.
import { initRnr } from '@rnrs/runtime/web';
import * as bundle from './.rnr/web/pkg/rnr_bundle.js';
import { runSmoke } from './smoke';

async function main() {
  await initRnr(bundle);
  const result = await runSmoke();
  (globalThis as any).__rnrResult = { platform: 'web', userAgent: navigator.userAgent, ...result };
  document.getElementById('out')!.textContent = JSON.stringify(result, null, 2);
}
main().catch((error) => {
  (globalThis as any).__rnrResult = {
    platform: 'web',
    ok: false,
    checks: [],
    error: String(error?.stack ?? error),
  };
});
