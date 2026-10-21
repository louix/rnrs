// Browser harness: runs the shared suites against the generated modules on the Wasm backend.
import init, * as wasm from './rnr/pkg/rnr_bundle.js';
import {
  checkWasmAdapter,
  installWebBackend,
  type RnrWasm,
} from '../packages/runtime/src/web-backend';
import { runProtocolSuite } from '../src/rnrs/protocol-suite';
import { runConformance } from '../src/rnrs/conformance';
import { runMeterSuite } from '../src/rnrs/meter-suite';
import { runValuesSuite } from '../src/rnrs/values-suite';
import { runBlake3Suite } from '../src/rnrs/blake3-suite';
import { counterModule, createCounterModuleForTesting } from '../.generated/rnr/counter';

const output = document.getElementById('out')!;
const gc = (globalThis as any).gc as (() => void) | undefined;

async function collectGarbage() {
  if (!gc) throw new Error('start the browser with --js-flags=--expose-gc');
  gc();
  await new Promise((resolve) => setTimeout(resolve, 0)); // FinalizationRegistry callbacks run as tasks
  gc();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function main() {
  await init({ module_or_path: new URL('../rnr/pkg/rnr_bundle_bg.wasm', import.meta.url) });
  installWebBackend(wasm as unknown as RnrWasm);
  const checks = await runConformance({
    platform: 'web',
    makeModule: createCounterModuleForTesting,
    runtimeModule: counterModule,
    collectGarbage,
  });
  checks.push(...(await runMeterSuite({ platform: 'web', collectGarbage })));
  checks.push(...(await runValuesSuite({ collectGarbage })));
  checks.push(...(await runBlake3Suite()));
  const f = () => {};
  checks.push(
    ...runProtocolSuite(
      'Wasm',
      checkWasmAdapter,
      { call: f, call0: f, call1: f, call2: f, call3: f, call4: f },
      { call: f },
      'call0',
    ),
  );
  const result = {
    platform: 'web',
    userAgent: navigator.userAgent,
    ok: checks.every((c) => c.ok),
    checks,
  };
  output.textContent = JSON.stringify(result, null, 2);
  (globalThis as any).__rnrResult = result;
}

main().catch((error) => {
  (globalThis as any).__rnrResult = {
    platform: 'web',
    ok: false,
    error: String(error?.stack ?? error),
    checks: [],
  };
  output.textContent = String(error);
});
