// The Vite HTTP consumer: load the app's Wasm bundle, then run the shared smoke against the
// local test server (cross-origin: the page is served from another port).
import { initRnrs } from '@rnrs/runtime/web';
import * as bundle from './.rnrs/web/pkg/rnrs_bundle.js';

const server = new URLSearchParams(location.search).get('http');
if (server) (globalThis as any).__RNRS_HTTP_BASE = server;

async function main() {
  await initRnrs(bundle as any);
  const { runSmoke } = await import('./smoke');
  const result = await runSmoke();
  (globalThis as any).__rnrsResult = { userAgent: navigator.userAgent, ...result };
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
