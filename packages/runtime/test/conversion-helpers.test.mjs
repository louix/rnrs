// The Android number[] output helpers (conversionHelpers.detachPrototype / restorePrototype in
// packages/runtime/src/runtime.ts, loaded through Node's TypeScript transform), used the way the
// JSI adapter uses them: a fresh array of the result length, its prototype detached, one ordinary
// indexed write per element (jsi setValueAtIndex is an ordinary [[Set]]), then the exact
// prototype restored before the array is published. The result must be what one `define` per
// element gives: own writable/enumerable/configurable data properties with the exact values,
// untouched by inherited accessors, non-writable indices, proxies in the prototype chain,
// polluted prototypes or globals patched after init.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FLAG = '--experimental-transform-types';

if (!process.execArgv.includes(FLAG)) {
  test('conversion helpers (runtime.ts under the Node type transform)', () => {
    const run = spawnSync(
      process.execPath,
      [
        FLAG,
        '--expose-gc',
        '--no-warnings',
        '--test',
        '--test-reporter=tap',
        fileURLToPath(import.meta.url),
      ],
      { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^# pass [1-9]/m, run.stdout);
    assert.match(run.stdout, /^# fail 0$/m, run.stdout);
  });
} else {
  const { conversionHelpers: helpers } = await import('../src/runtime.ts');

  // A fresh array of `n` holes, as jsi::Array(rt, n) creates.
  const holes = (n) => {
    const array = [];
    array.length = n;
    return array;
  };
  // What RnrsJsi.cpp newNumbers does (empty results skip the helpers).
  const fromNative = (values) => {
    const array = holes(values.length);
    if (values.length === 0) return array;
    const prototype = helpers.detachPrototype(array);
    for (let i = 0; i < values.length; i++) array[i] = values[i];
    helpers.restorePrototype(array, prototype);
    return array;
  };
  // The ABI 2 path: one `define` per element.
  const byElement = (values) => {
    const array = holes(values.length);
    values.forEach((x, i) => helpers.define(array, i, x));
    return array;
  };
  const SPECIAL = [1.5, -0, 0, NaN, Infinity, -Infinity, 5e-324, -Number.MAX_VALUE, 2 ** 53 + 2];
  const exact = (out, values) => {
    assert.ok(Array.isArray(out));
    assert.equal(Object.getPrototypeOf(out), Array.prototype);
    assert.deepEqual(Reflect.ownKeys(out), [...values.keys()].map(String).concat('length'));
    values.forEach((x, i) => {
      assert.ok(Object.is(out[i], x), `index ${i}`);
      assert.deepEqual(
        { ...Object.getOwnPropertyDescriptor(out, i) },
        { value: x, writable: true, enumerable: true, configurable: true },
      );
    });
  };

  test('same array as one define per element: values, -0, NaN, infinities, descriptors', () => {
    for (const values of [[], [7], SPECIAL]) {
      const out = fromNative(values);
      exact(out, values);
      assert.deepEqual(
        Object.getOwnPropertyDescriptors(out),
        Object.getOwnPropertyDescriptors(byElement(values)),
      );
    }
  });

  test('large arrays', () => {
    const n = 1 << 20;
    const values = Array.from({ length: n }, (_, i) => i * 0.5 - 7);
    const out = fromNative(values);
    assert.equal(out.length, n);
    assert.equal(Object.getPrototypeOf(out), Array.prototype);
    for (const i of [0, 1, 4095, 4096, n - 2, n - 1]) assert.equal(out[i], i * 0.5 - 7);
    assert.ok(Object.hasOwn(out, n - 1));
  });

  test('the exact original prototype is restored', () => {
    const custom = Object.create(Array.prototype);
    const array = holes(2);
    Object.setPrototypeOf(array, custom);
    const prototype = helpers.detachPrototype(array);
    assert.equal(prototype, custom);
    assert.equal(Object.getPrototypeOf(array), null);
    array[0] = 1;
    array[1] = 2;
    helpers.restorePrototype(array, prototype);
    assert.equal(Object.getPrototypeOf(array), custom);
  });

  test('inherited indexed setters and getters never run', () => {
    const seen = [];
    const trap = (target, key) =>
      Object.defineProperty(target, key, {
        get: () => seen.push(`get ${key}`),
        set: (v) => seen.push(`set ${key}=${v}`),
        configurable: true,
      });
    trap(Array.prototype, 0);
    trap(Object.prototype, 1);
    try {
      const out = fromNative([10, 20, 30]);
      assert.deepEqual(seen, []);
      assert.deepEqual([Object.hasOwn(out, 0), Object.hasOwn(out, 1)], [true, true]);
      assert.deepEqual([out[0], out[1], out[2]], [10, 20, 30]);
      assert.deepEqual(seen, []);
    } finally {
      delete Array.prototype[0];
      delete Object.prototype[1];
    }
  });

  test('inherited non-writable indices do not drop or reject values', () => {
    // Without the detached prototype an ordinary [[Set]] would fail here (silently in Hermes's
    // setValueAtIndex, which passes no ThrowOnError).
    Object.defineProperty(Array.prototype, 0, { value: 9, writable: false, configurable: true });
    Object.defineProperty(Object.prototype, 1, { value: 9, writable: false, configurable: true });
    try {
      assert.throws(() => {
        const plain = holes(1);
        plain[0] = 1; // strict-mode module: the ordinary write is rejected
      }, TypeError);
      exact(fromNative([1, 2, 3]), [1, 2, 3]);
    } finally {
      delete Array.prototype[0];
      delete Object.prototype[1];
    }
  });

  test('a proxy in the prototype chain is never trapped during the fill', () => {
    const traps = [];
    let recording = false;
    const proxy = new Proxy(Object.create(Object.prototype), {
      get: (t, k, r) => (recording && traps.push(`get ${String(k)}`), Reflect.get(t, k, r)),
      set: (t, k, v, r) => (recording && traps.push(`set ${String(k)}`), Reflect.set(t, k, v, r)),
      has: (t, k) => (recording && traps.push(`has ${String(k)}`), Reflect.has(t, k)),
      getOwnPropertyDescriptor: (t, k) => (
        recording && traps.push(`gopd ${String(k)}`),
        Reflect.getOwnPropertyDescriptor(t, k)
      ),
      defineProperty: (t, k, d) => (
        recording && traps.push(`define ${String(k)}`),
        Reflect.defineProperty(t, k, d)
      ),
      getPrototypeOf: (t) => (recording && traps.push('getPrototypeOf'), Reflect.getPrototypeOf(t)),
    });
    const original = Object.getPrototypeOf(Array.prototype);
    Object.setPrototypeOf(Array.prototype, proxy);
    let out;
    try {
      recording = true;
      out = fromNative([4, 5, 6]);
      recording = false;
    } finally {
      recording = false;
      Object.setPrototypeOf(Array.prototype, original);
    }
    assert.deepEqual(traps, []);
    exact(out, [4, 5, 6]);
  });

  test('descriptor-shaped prototype pollution is ignored', () => {
    const keys = ['get', 'set', 'value', 'writable', 'enumerable', 'configurable'];
    const calls = [];
    Object.prototype.get = () => calls.push('get');
    Object.prototype.set = () => calls.push('set');
    Object.prototype.value = 'polluted';
    Object.prototype.writable = false;
    Object.prototype.enumerable = false;
    Object.prototype.configurable = false;
    let out;
    try {
      out = fromNative([1, -0]);
    } finally {
      for (const key of keys) delete Object.prototype[key];
    }
    exact(out, [1, -0]);
    assert.deepEqual(calls, []);
  });

  test('globals patched after init are not used', () => {
    const saved = {
      getPrototypeOf: Object.getPrototypeOf,
      setPrototypeOf: Object.setPrototypeOf,
      reflectSet: Reflect.setPrototypeOf,
    };
    const used = [];
    Object.getPrototypeOf = () => (used.push('getPrototypeOf'), null);
    Object.setPrototypeOf = (o) => (used.push('setPrototypeOf'), o);
    Reflect.setPrototypeOf = () => (used.push('Reflect.setPrototypeOf'), true);
    let out;
    try {
      out = fromNative([1, 2, 3]);
    } finally {
      Object.getPrototypeOf = saved.getPrototypeOf;
      Object.setPrototypeOf = saved.setPrototypeOf;
      Reflect.setPrototypeOf = saved.reflectSet;
    }
    assert.deepEqual(used, []);
    exact(out, [1, 2, 3]);
  });

  test('exceptions propagate (the adapter retains them; nothing is published)', () => {
    // A non-extensible array's prototype cannot change (the adapter's array is always fresh).
    assert.throws(() => helpers.detachPrototype(Object.preventExtensions(holes(1))), TypeError);
    assert.throws(
      () => helpers.restorePrototype(Object.preventExtensions(holes(1)), null),
      TypeError,
    );
  });
}
