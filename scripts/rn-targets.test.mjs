import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { declaredTargets, requireTarget } from './rn-targets.mjs';

const counter = JSON.parse(readFileSync('packages/counter/package.json', 'utf8'));
const androidOnly = JSON.parse(readFileSync('packages/fixtures/android-only/package.json', 'utf8'));

test('counter package declares android, ios and web', () => {
  assert.deepEqual(declaredTargets(counter), ['android', 'ios', 'web']);
  for (const t of ['android', 'ios', 'web']) assert.doesNotThrow(() => requireTarget(counter, t));
});

test('android-only package rejects web and ios with an actionable message', () => {
  assert.throws(
    () => requireTarget(androidOnly, 'web'),
    /does not support target "web" \(declared: android\).*rustNative\.targets/,
  );
  assert.throws(
    () => requireTarget(androidOnly, 'ios'),
    /does not support target "ios" \(declared: android\)/,
  );
});

test('declarations must be explicit, known and unique', () => {
  assert.throws(
    () => declaredTargets({ name: 'x' }),
    /must declare a nonempty "rustNative.targets"/,
  );
  assert.throws(() => declaredTargets({ name: 'x', rustNative: { targets: [] } }), /nonempty/);
  assert.throws(
    () => declaredTargets({ name: 'x', rustNative: { targets: ['wasi'] } }),
    /unknown target "wasi"/,
  );
  assert.throws(
    () => declaredTargets({ name: 'x', rustNative: { targets: ['web', 'web'] } }),
    /duplicate/,
  );
  assert.throws(() => requireTarget(counter, 'windows'), /Unknown target "windows"/);
});

test('CLI exits nonzero for an unsupported target', () => {
  assert.match(
    execFileSync('node', ['scripts/rn-targets.mjs', 'check', 'packages/counter', 'web'], {
      encoding: 'utf8',
    }),
    /^ok: web/,
  );
  const ios = spawnSync(
    'node',
    ['scripts/rn-targets.mjs', 'check', 'packages/fixtures/android-only', 'ios'],
    { encoding: 'utf8' },
  );
  assert.equal(ios.status, 1);
  assert.match(ios.stderr, /error: @rnrs\/labs-android-only does not support target "ios"/);
});
