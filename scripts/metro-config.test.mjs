// metro.config.js blockList: generated module wrappers (.generated/rnr/) stay visible to Metro,
// including the bare directory (Metro 0.87's crawler tests directory paths without a trailing
// slash), while the other build caches under .generated/ are blocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = createRequire(import.meta.url)(path.join(ROOT, 'metro.config.js'));
const blocked = (rel) => config.resolver.blockList.some((re) => re.test(path.join(ROOT, rel)));

test('generated wrappers and their directories are not blocked', () => {
  for (const rel of ['.generated/rnr', '.generated/rnr/values', '.generated/rnr/values/index.ts'])
    assert.equal(blocked(rel), false, rel);
});

test('other generated caches are blocked', () => {
  for (const rel of [
    '.generated/gradle',
    '.generated/cargo/registry/x.rs',
    '.generated/rnrx',
    '.generated/rnr-old/index.ts',
  ])
    assert.equal(blocked(rel), true, rel);
});

test('ordinary sources are not blocked', () => {
  assert.equal(blocked('src/rnrsAndroid.ts'), false);
});
