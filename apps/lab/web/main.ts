// Browser harness: runs the shared suites against the generated modules on the Wasm backend.
import init, * as wasm from './rnrs/pkg/rnrs_bundle.js';
import {
  checkWasmAdapter,
  installWebBackend,
  type RnrsWasm,
} from '../../../packages/runtime/src/web-backend';
import { runProtocolSuite } from '../src/rnrs/protocol-suite';
import { runConformance } from '../src/rnrs/conformance';
import { runMeterSuite } from '../src/rnrs/meter-suite';
import { runValuesSuite } from '../src/rnrs/values-suite';
import { runBlake3Suite } from '../src/rnrs/blake3-suite';
import { counterModule, createCounterModuleForTesting } from '../../../.generated/rnrs/counter';
import { ValuesModule } from '../../../.generated/rnrs/values';
import { conversionHelpers } from '../../../packages/runtime/src/runtime';

const output = document.getElementById('out')!;
const gc = (globalThis as any).gc as (() => void) | undefined;

async function collectGarbage() {
  if (!gc) throw new Error('start the browser with --js-flags=--expose-gc');
  gc();
  await new Promise((resolve) => setTimeout(resolve, 0)); // FinalizationRegistry callbacks run as tasks
  gc();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** A bundle newer than the JS runtime: helpers without `numbers` still convert numeric
 *  arrays (element by element), with the same results and errors. */
function olderRuntimeHelpers() {
  const start = performance.now();
  const name = "web: numeric arrays with an older runtime's helpers (no numbers helper)";
  let index = -1;
  ValuesModule.prototype.sum.call({ host: { call1: (i: number) => (index = i) } } as any, []);
  const { name: module, hash } = ValuesModule.descriptor;
  const helpers = Object.freeze({ ...conversionHelpers, wrap: () => ({}), unwrap: () => null });
  const adapter = new wasm.RnrsWebAdapter(module, hash, 4, () => {}, helpers);
  try {
    const sum = adapter.call1(index, undefined, [1, 2.5, -0]);
    let error = '';
    try {
      adapter.call1(index, undefined, [1, 'x']);
    } catch (e) {
      error = String(e);
    }
    const ok = sum === 3.5 && error === 'TypeError: xs[1] must be a number, got a string';
    return { name, ok, ms: performance.now() - start, detail: `sum ${sum}; ${error}` };
  } finally {
    adapter.teardown();
    adapter.free();
  }
}

async function main() {
  const exports = (await init({
    module_or_path: new URL('../rnrs/pkg/rnrs_bundle_bg.wasm', import.meta.url),
  })) as { memory: WebAssembly.Memory };
  installWebBackend(wasm as unknown as RnrsWasm);
  const checks = await runConformance({
    platform: 'web',
    makeModule: createCounterModuleForTesting,
    runtimeModule: counterModule,
    collectGarbage,
  });
  checks.push(...(await runMeterSuite({ platform: 'web', collectGarbage })));
  checks.push(
    ...(await runValuesSuite({
      collectGarbage,
      growWasmMemory: () => void exports.memory.grow(1),
    })),
  );
  checks.push(olderRuntimeHelpers());
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
  (globalThis as any).__rnrsResult = result;
}

main().catch((error) => {
  (globalThis as any).__rnrsResult = {
    platform: 'web',
    ok: false,
    error: String(error?.stack ?? error),
    checks: [],
  };
  output.textContent = String(error);
});
