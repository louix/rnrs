// Vite consumer of the author's package.
import { initRnrs } from '@rnrs/runtime/web';
import * as bundle from './.rnrs/web/pkg/rnrs_bundle.js';
import { xorModule } from '@demo/xor';

async function main() {
  await initRnrs(bundle as any);
  const m = xorModule();
  const out = new Uint8Array(m.xor(new Uint8Array([0, 1, 255]).buffer, 255));
  let rejected = '';
  try {
    m.xor(new Uint8Array([1]), 1);
  } catch (error) {
    rejected = String(error);
  }
  const checks = [
    { name: 'xor bytes', ok: out.join(',') === '255,254,0', detail: out.join(',') },
    { name: 'greet', ok: m.greet('author') === 'hello, author', detail: '' },
    { name: 'Uint8Array argument rejected', ok: /TypeError/.test(rejected), detail: rejected },
  ];
  (globalThis as any).__rnrsResult = { platform: 'web', ok: checks.every((c) => c.ok), checks };
}
main().catch((error) => {
  (globalThis as any).__rnrsResult = {
    ok: false,
    checks: [],
    error: String(error?.stack ?? error),
  };
});
