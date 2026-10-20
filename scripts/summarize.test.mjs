import {test} from 'node:test';
import assert from 'node:assert/strict';
import {quantile, summarize} from './summarize.mjs';
test('quantiles sort numerically and interpolate', () => {
  assert.equal(quantile([10, 1, 3, 2], .5), 2.5);
  assert.equal(quantile([], .5), null);
});
test('normalizes batched work per operation, not per call', () => {
  const sample = {type: 'sample', runId: 'one', name: 'rust', group: 'batch', elapsedMs: 2, operations: 2000,
    calls: 2, before: {threadCpuMs: 1, nativeAllocatedBytes: 100},
    after: {threadCpuMs: 3, nativeAllocatedBytes: 120}, postGcMs: .5};
  assert.deepEqual(summarize([sample]), []);
  const [s] = summarize([sample, {type: 'done', runId: 'one', samples: 1}]);
  assert.equal(s.medianNsPerOp, 1000);
  assert.equal(s.medianNativeLiveDelta, 20);
  assert.equal(s.medianJsAllocatedBytes, null);
  assert.equal(s.medianCollections, null);
});
test('does not pool distinct runs or include failures', () => {
  const sample = {type: 'sample', name: 'x', group: 'scalar', elapsedMs: 1, operations: 1,
    before: {threadCpuMs: 0, nativeAllocatedBytes: 0}, after: {threadCpuMs: 1, nativeAllocatedBytes: 0}, postGcMs: 0};
  const records = ['a', 'b'].flatMap(runId => [{...sample, runId}, {type: 'done', runId, samples: 1}]);
  assert.equal(summarize(records).length, 2);
  assert.equal(summarize([...records, {type: 'error', runId: 'a'}]).length, 1);
});
