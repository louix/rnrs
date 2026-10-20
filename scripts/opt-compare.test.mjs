import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCheck, load} from './opt-compare.mjs';

test('a missing run is an error, not a smaller sample', () => {
  assert.throws(() => load('no-such-checkpoint', 'web'), /missing run 1/);
});

test('timed runs must not be diagnostics builds; runs without the flag are unverified', () => {
  const run = diagnostics => ({raw: {environment: diagnostics === undefined ? {} : {diagnostics}}});
  assert.throws(() => buildCheck('x', 'web', [run(false), run(true)]), /a timed run is a diagnostics build/);
  assert.equal(buildCheck('x', 'web', [run(false), run(false)]).diagnostics, 'verified-off');
  assert.match(buildCheck('x', 'web', [run(undefined), run(false)]).diagnostics, /^unverified/);
});
