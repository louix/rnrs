import test from 'node:test';
import assert from 'node:assert/strict';
import {checkRun, quantile, summarize} from './compare-summarize.mjs';

const env = {dev: false, diagnostics: false, nitroBuildType: 'release'};
const APK = 'a'.repeat(64);
const sample = (round, path, elapsedMs, collections = 0) => ({round, workload: 'scalar', path, calls: 1000, elapsedMs,
  before: {hermes_numCollections: 5, hermes_totalAllocatedBytes: 100, hermes_allocatedBytes: 50}, after: {hermes_numCollections: 5 + collections, hermes_totalAllocatedBytes: 400, hermes_allocatedBytes: 20}});
const run = (n, samples) => ({mode: 'compare', run: n, seed: 2000 + n, rounds: 2, device: {serialno: 'S1'},
  start: {mode: 'compare', run: n, seed: 2000 + n, rounds: 2, environment: env, workloads: [{workload: 'scalar', calls: 1000, paths: ['js', 'jsi-cpp', 'rnrs-rust']}]},
  samples, done: {type: 'compare-done'}, conditions: {before: {apkSha256: APK}, after: {}}});
const full = () => run(1, Array.from({length: 6}, (_, i) => sample(i >> 2 ? 1 : i < 3 ? 0 : 1, ['js', 'jsi-cpp', 'rnrs-rust'][i % 3], 1)));
const runner = {serial: 'S1', seedBase: 2001, pressureSeedBase: 2101, preSample: 'idle'};

test('paired differences use the control of the same round and run', () => {
  const r1 = run(1, [sample(0, 'js', 1), sample(0, 'jsi-cpp', 2), sample(0, 'rnrs-rust', 3, 1),
    sample(1, 'js', 1), sample(1, 'jsi-cpp', 4), sample(1, 'rnrs-rust', 4)]);
  const s = summarize([r1]).scalar.paths;
  assert.deepEqual(s['rnrs-rust'].perRunMedianDiffNs, {1: 500});
  assert.equal(s['rnrs-rust'].diffVsControlNs.median, 500);
  assert.equal(s.js.diffVsControlNs, null);
  assert.equal(s['jsi-cpp'].diffVsControlNs, null);
  assert.equal(s['rnrs-rust'].samplesWithGcInTiming, 1);
  assert.equal(s['jsi-cpp'].nsPerCall.median, 3000);
  assert.equal(s.js.medianTotalAllocatedBytes, 300);
  assert.equal(s.js.medianLiveHeapDelta, -30);
});

test('a complete, consistent run passes', () => {
  assert.deepEqual(checkRun(full(), {apkSha256: APK, runner}), []);
  assert.deepEqual(checkRun(full(), {apkSha256: APK, runner: null}), []);
});

test('incomplete, debug, diagnostics and inconsistent runs are rejected', () => {
  const ok = full();
  const ctx = {apkSha256: APK, runner};
  assert.match(checkRun({...ok, samples: ok.samples.slice(1)}, ctx).join(), /missing sample 0\|scalar\|js.*5 samples, expected 6/);
  assert.match(checkRun({...ok, samples: [...ok.samples.slice(1), ok.samples[1]]}, ctx).join(), /duplicate sample/);
  assert.match(checkRun({...ok, start: {...ok.start, environment: {...env, diagnostics: true}}}, ctx).join(), /diagnostics/);
  assert.match(checkRun({...ok, start: {...ok.start, environment: {...env, dev: true}}}, ctx).join(), /__DEV__/);
  assert.match(checkRun({...ok, done: {type: 'compare-error', error: 'boom'}}, ctx).join(), /boom/);
  assert.match(checkRun({...ok, start: {...ok.start, seed: 9}}, ctx).join(), /start record/);
  assert.match(checkRun({...ok, seed: 7, start: {...ok.start, seed: 7}}, ctx).join(), /seed 7, expected 2001/);
  assert.match(checkRun({...ok, device: {serialno: 'S2'}}, ctx).join(), /device serial S2/);
  assert.match(checkRun({...ok, conditions: {before: {}, after: {}}}, ctx).join(), /no installed-APK hash/);
  assert.match(checkRun({...ok, conditions: {before: {apkSha256: 'b'.repeat(64)}, after: {}}}, ctx).join(), /differs from provenance/);
  assert.match(checkRun(ok, {apkSha256: APK, runner: {...runner, preSample: 'busy'}}).join(), /preSample idle, runner busy/);
});

test('nearest-rank quantiles', () => {
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1), 1);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
});

test('iOS runs are checked against the app manifest hash', () => {
  const ok = full();
  const ios = {...ok, platform: 'ios', conditions: {before: {artifactSha256: APK}, after: {}}};
  assert.deepEqual(checkRun(ios, {apkSha256: APK, runner}), []);
  assert.match(checkRun({...ios, conditions: {before: {artifactSha256: 'c'.repeat(64)}, after: {}}}, {apkSha256: APK, runner}).join(), /differs from provenance/);
});
