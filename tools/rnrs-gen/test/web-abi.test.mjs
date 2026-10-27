// The web ABI contract (WEB_ABI in packages/runtime/src/web-backend.ts, RNRS_WEB_ABI in
// rust/rnrs-web): what a Wasm instance built by one @rnrs/runtime offers the JS backend of
// another. Pinned here: the version on both sides, every rnrs-web export the backend calls with
// its parameter count, and the status and admission codes runtime.ts interprets (their Rust
// values are pinned by rnrs-android's abi_contract test, shared through rnrs-core). Changing any
// of them requires bumping both ABI numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../cli.mjs';

const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

test('web ABI: version, exports and codes', () => {
  const backend = read('packages/runtime/src/web-backend.ts');
  const web = read('rust/rnrs-web/src/web.rs');
  const runtime = read('packages/runtime/src/runtime.ts');
  assert.match(backend, /export const WEB_ABI = 1;/);
  assert.match(web, /pub const RNRS_WEB_ABI: u32 = 1;/);
  assert.match(read('tools/rnrs-gen/native.mjs'), /export const NATIVE_WEB_ABI = 1;/);
  // Free functions and adapter methods (wasm-bindgen exports) with their parameter counts,
  // `&self` excluded.
  const params = (name) => {
    const m = new RegExp(`pub fn ${name}\\(([^)]*)\\)`).exec(web);
    assert.ok(m, `rnrs-web exports ${name}`);
    return m[1]
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p && p !== '&self').length;
  };
  const exports = {
    rnrs_web_abi: 0,
    rnrs_web_modules: 0,
    rnrs_release_slot: 2,
    new: 5,
    generation: 0,
    call: 3,
    call0: 2,
    call1: 3,
    call2: 4,
    call3: 5,
    call4: 6,
    scalar_signature: 1,
    scalar: 5,
    take_scalar_error: 0,
    drain: 1,
    cancel: 1,
    dispose: 1,
    teardown: 0,
    stats: 0,
  };
  for (const [name, count] of Object.entries(exports)) assert.equal(params(name), count, name);
  for (const name of Object.keys(exports).filter((n) => n !== 'new' && n !== 'generation'))
    assert.match(backend, new RegExp(`\\b${name}\\b`), `web-backend.ts uses ${name}`);
  // Settlement statuses (Rust SETTLE_OK..SETTLE_DOMAIN = 0..4) and admission codes (-1..-3).
  // Domain (4, declared errors) was added without a web ABI bump: only Wasm generated from a
  // spec with Throws settles it, and that spec's wrapper requires call protocol 4, which an
  // older @rnrs/runtime refuses before installing; older Wasm never produces it.
  assert.match(
    runtime,
    /const Status = \{ Ok: 0, Cancelled: 1, Failed: 2, Lost: 3, Domain: 4 \} as const;/,
  );
  assert.match(runtime, /case -1:\s*return new RnrsError\('closed'/);
  assert.match(
    runtime,
    /case -2:\s*return new RnrsError\('overloaded', failure\.message, 'module'\)/,
  );
});
