// The surface table ABI (RnrsAbi.h RNRS_SURFACE_ABI, rnrs-surface's SURFACE_ABI) and the number
// the publisher records in a surface module's manifest and the link step requires. The layout
// itself is pinned by RnrsAbi.h's static_asserts and host.rs's contract test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../cli.mjs';
import { NATIVE_ABI, NATIVE_SURFACE_ABI } from '../bundle.mjs';

const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

test('surface ABI: one number in the host, rnrs-surface and the generator', () => {
  const abi = read('packages/runtime/cpp/RnrsAbi.h');
  assert.match(abi, new RegExp(`#define RNRS_SURFACE_ABI ${NATIVE_SURFACE_ABI}\\n`));
  assert.match(abi, new RegExp(`#define RNRS_ABI ${NATIVE_ABI}\\n`));
  assert.match(
    read('packages/surface/rust/src/lib.rs'),
    new RegExp(`pub const SURFACE_ABI: u32 = ${NATIVE_SURFACE_ABI};`),
  );
  assert.match(
    read('rust/rnrs-android/src/lib.rs'),
    new RegExp(`pub const RNRS_ABI: u32 = ${NATIVE_ABI};`),
  );
});

test('surface ABI: the browser bootstrap requires the same number and every export it calls exists', () => {
  const bootstrap = read('packages/surface/src/browser/bootstrap.ts');
  assert.match(bootstrap, new RegExp(`export const SURFACE_ABI = ${NATIVE_SURFACE_ABI};`));
  const exports = read('packages/surface/rust/src/web_exports.rs');
  assert.match(exports, /pub fn rnrs_surface_abi\(\) -> u32 \{\s*crate::SURFACE_ABI\s*\}/);
  const list = /const SURFACE_EXPORTS = \[([^\]]*)\]/.exec(bootstrap)[1].match(/'(\w+)'/g);
  assert.ok(list.length >= 10);
  for (const name of list.map((n) => n.slice(1, -1))) {
    assert.match(exports, new RegExp(`pub fn ${name}\\(`), `rnrs-surface exports ${name}`);
    assert.match(exports, new RegExp(`${name} as \\*const \\(\\)`), `${name} is kept`);
  }
});
