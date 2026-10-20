// The TypeScript frame writer (packages/vello2d/frame.ts) produces exactly the layout the Rust
// decoder (packages/vello2d/rust/src/frame.rs) expects; Node strips the TS types on import.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FrameWriter} from '../packages/vello2d/frame.ts';

const floats = buffer => Array.from(new Float32Array(buffer));

test('frame writer layout: header, opcodes, operands; exactly the used length', () => {
  const w = new FrameWriter(16);
  w.begin().clear([0, 0, 1, 1]).rect(1, 2, 3, 4, [1, 0, 0, 1]).circle(5, 6, 7, [0, 1, 0, 0.5]);
  const f = floats(w.finish());
  assert.equal(f.length, 2 + 5 + 9 + 8, 'no unused capacity is submitted');
  assert.deepEqual(f.slice(0, 2), [1, 5 + 9 + 8]);
  assert.deepEqual(f.slice(2, 24), [1, 0, 0, 1, 1, 2, 1, 2, 3, 4, 1, 0, 0, 1, 3, 5, 6, 7, 0, 1, 0, 0.5]);
  w.begin().roundRect(1, 2, 3, 4, 5, [0, 0, 0, 1]).line(0, 0, 9, 9, 2, [1, 1, 1, 1]);
  const g = floats(w.finish());
  assert.deepEqual(g, [1, 20, 4, 1, 2, 3, 4, 5, 0, 0, 0, 1, 5, 0, 0, 9, 9, 2, 1, 1, 1, 1]);
  assert.equal(new FrameWriter(4096).begin().clear([0, 0, 0, 1]).finish().byteLength, 7 * 4, 'a large writer still submits only what was written');
});

test('frame writer grows as needed and refuses frames over 1 MiB', () => {
  const w = new FrameWriter(16);
  w.begin();
  for (let i = 0; i < 1000; i++) w.rect(i, 0, 1, 1, [1, 1, 1, 1]);
  assert.equal(w.length, 9000);
  const f = floats(w.finish());
  assert.equal(f[1], 9000);
  assert.deepEqual(f.slice(2 + 999 * 9, 2 + 1000 * 9), [2, 999, 0, 1, 1, 1, 1, 1, 1]);
  assert.equal(w.finish().byteLength, (2 + 9000) * 4);
  assert.throws(() => { for (let i = 0; i < 40000; i++) w.rect(0, 0, 1, 1, [1, 1, 1, 1]); }, /frame exceeds 1048576 bytes/);
});
