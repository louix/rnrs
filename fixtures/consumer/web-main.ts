// The Vite consumer app: load the app's Wasm bundle, then run the shared smoke test.
import { initRnrs } from '@rnrs/runtime/web';
import * as bundle from './.rnrs/web/pkg/rnrs_bundle.js';
import { blake3Module } from '@rnrs/example-blake3';
import { runSmoke } from './smoke';

async function main() {
  // Using a module before initRnrs must fail with an actionable message.
  let preInit = '';
  try {
    blake3Module();
  } catch (error) {
    preInit = String(error);
  }
  // A failed load rejects and can be retried; one bundle, one backend.
  let failed = '';
  try {
    await initRnrs(bundle as any, new URL('./missing.wasm', location.href));
  } catch (error) {
    failed = String(error);
  }
  await initRnrs(bundle as any);
  await initRnrs(bundle as any); // same bundle: shares the initialization
  let other = '';
  try {
    await initRnrs({ ...bundle } as any);
  } catch (error) {
    other = String(error);
  }
  const result = await runSmoke();
  result.checks.unshift(
    { name: 'pre-init use is an actionable error', ok: /initRnrs/.test(preInit), detail: preInit },
    {
      name: 'initRnrs: a failed load rejects, a retry succeeds, another bundle is refused',
      ok: failed !== '' && /another bundle/.test(other),
      detail: `${failed.slice(0, 80)} | ${other}`,
    },
  );
  result.ok = result.checks.every((c) => c.ok);
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
