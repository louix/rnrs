// The Vite HTTP consumer: load the app's Wasm bundle, then run the shared smoke against the
// local test server (cross-origin: the page is served from another port).
import { initRnr } from '@rnrs/runtime/web';
import * as bundle from './.rnr/web/pkg/rnr_bundle.js';

const server = new URLSearchParams(location.search).get('http');
if (server) (globalThis as any).__RNR_HTTP_BASE = server;

async function main() {
  await initRnr(bundle as any);
  const { runSmoke } = await import('./smoke');
  const result = await runSmoke();
  (globalThis as any).__rnrResult = { userAgent: navigator.userAgent, ...result };
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
