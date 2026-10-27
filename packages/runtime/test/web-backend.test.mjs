// The browser backend's prepared scalar entries and fused numeric-array helper
// (packages/runtime/src/web-backend.ts, loaded through Node's TypeScript transform) against a
// fake wasm-bindgen adapter: which calls take the scalar leaf, which fall back to the generic
// positional call, how results and leaf errors come back, and how `numbers` writes into a
// real WebAssembly.Memory (stopping, exceptions, growth from a getter).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const FLAG = '--experimental-transform-types';

if (!process.execArgv.includes(FLAG)) {
  // Re-run this file with the transform, so `npm test` needs no extra flags.
  test('web backend entries (web-backend.ts under the Node type transform)', () => {
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
      // Without NODE_TEST_CONTEXT the inner run is a top-level test run whose exit status
      // reflects its own failures (inherited, it reports to this runner and exits 0).
      { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^# pass [1-9]/m, run.stdout);
    assert.match(run.stdout, /^# fail 0$/m, run.stdout);
  });
} else {
  // The sources import each other without extensions (bundler resolution).
  registerHooks({
    resolve: (specifier, context, next) =>
      next(
        specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)
          ? `${specifier}.ts`
          : specifier,
        context,
      ),
  });
  const { installWebBackend, WEB_ABI } = await import('../src/web-backend.ts');

  // Signatures by method index: [slot, argument kinds (2 bits each), result kind].
  const install = ({ signatures = {}, legacy = false, hostHelpers } = {}) => {
    const log = [];
    let helpers;
    let next = 0;
    let error;
    class RnrsWebAdapter {
      generation = 1;
      constructor(_name, _hash, _max, _notify, h) {
        helpers = h;
      }
      call() {}
      cancel() {}
      dispose() {}
      teardown() {}
      stats() {}
      drain() {}
      scalar(...args) {
        log.push(['scalar', ...args]);
        error = next.error;
        return next.value ?? next;
      }
      take_scalar_error() {
        const e = error;
        error = undefined;
        return e;
      }
    }
    for (let n = 0; n <= 4; n++)
      RnrsWebAdapter.prototype[`call${n}`] = function (...args) {
        log.push([`call${n}`, ...args]);
        return 'slow';
      };
    if (!legacy)
      RnrsWebAdapter.prototype.scalar_signature = (index) =>
        signatures[index] && Uint32Array.from(signatures[index]);
    const backend = installWebBackend({
      RnrsWebAdapter,
      rnrs_release_slot() {},
      rnrs_web_abi: () => 1,
      rnrs_web_modules: () => ['M'],
    });
    const adapter = backend.install('M', 'h', 4, () => {}, hostHelpers);
    const installed = helpers;
    return {
      log,
      adapter,
      helpers: installed,
      /** The helpers a plain install of the same instance receives (for comparisons). */
      instanceHelpers() {
        backend.install('M', 'h', 4, () => {});
        return helpers;
      },
      returns(value) {
        next = value;
      },
      dispose: () => backend.dispose(),
    };
  };

  test('typed arguments take the scalar leaf with f64 slots; others the generic call', () => {
    const t = install({ signatures: { 1: [0, 0b0101, 1], 2: [1, 0b10, 2], 3: [2, 0, 0] } });
    const add = t.adapter.entry(1, 2);
    t.returns(5);
    assert.equal(add(2, 3), 5);
    assert.equal(add(-0, NaN, 'extra'), 5);
    assert.deepEqual(t.log.splice(0), [
      ['scalar', 0, 2, 3, 0, 0],
      ['scalar', 0, -0, NaN, 0, 0],
    ]);
    // Wrong or missing types: the generic call with the original arguments, which raises the
    // generic errors (closed admission first, then argument types).
    assert.equal(add('1', 2), 'slow');
    assert.equal(add(1), 'slow');
    assert.equal(add(1, true), 'slow');
    assert.deepEqual(t.log.splice(0), [
      ['call2', 1, undefined, '1', 2],
      ['call2', 1, undefined, 1, undefined],
      ['call2', 1, undefined, 1, true],
    ]);
    const flip = t.adapter.entry(2, 1);
    t.returns(0);
    assert.equal(flip(true), false);
    t.returns(1);
    assert.equal(flip(false), true);
    assert.equal(flip(1), 'slow');
    const nop = t.adapter.entry(3, 0);
    t.returns(0);
    assert.equal(nop(), undefined);
    assert.deepEqual(t.log.splice(0), [
      ['scalar', 1, 1, 0, 0, 0],
      ['scalar', 1, 0, 0, 0, 0],
      ['call1', 2, undefined, 1],
      ['scalar', 2, 0, 0, 0, 0],
    ]);
    t.dispose();
  });

  test('a NaN result is a value unless the leaf left an error, which is thrown as is', () => {
    const t = install({ signatures: { 0: [0, 0b01, 1] } });
    const f = t.adapter.entry(0, 1);
    t.returns(NaN);
    assert.ok(Number.isNaN(f(1)));
    const failure = new Error('leaf failed');
    t.returns({ value: NaN, error: failure });
    assert.throws(
      () => f(1),
      (e) => e === failure,
    );
    t.returns(NaN);
    assert.ok(Number.isNaN(f(1)), 'the error was consumed');
    t.dispose();
  });

  test('methods without a leaf, older bundles and arity mismatches keep the generic call', () => {
    const t = install({ signatures: { 0: [0, 0b0101, 1] } });
    assert.equal(t.adapter.entry(0, 1)(1), 'slow', 'leaf takes two arguments, wrapper one');
    assert.equal(t.adapter.entry(5, 1)(1), 'slow', 'no leaf');
    assert.deepEqual(t.log, [
      ['call1', 0, undefined, 1],
      ['call1', 5, undefined, 1],
    ]);
    t.dispose();
    const old = install({ legacy: true });
    assert.equal(old.adapter.entry(0, 2)(1, 2), 'slow', 'bundle without scalar_signature');
    old.dispose();
  });

  test('numbers: ordinary reads into Wasm memory, stopping at the first non-number', () => {
    const t = install();
    const memory = new WebAssembly.Memory({ initial: 1 });
    const at = (ptr, n) => [...new Float64Array(memory.buffer, ptr, n)];
    assert.equal(t.helpers.numbers([1.5, -0, NaN, 4], 1, 3, memory, 64), undefined);
    assert.ok(Object.is(at(64, 3)[0], -0) && Number.isNaN(at(64, 3)[1]) && at(64, 3)[2] === 4);
    const reads = [];
    const xs = [1, 2, 'x', 4];
    Object.defineProperty(xs, 3, { get: () => reads.push(3) });
    const proto = Object.create(Array.prototype, { 1: { get: () => (reads.push(1), 7) } });
    const holed = Object.setPrototypeOf([1, 0, 'x', 4], proto);
    delete holed[1];
    assert.deepEqual(t.helpers.numbers(holed, 0, 4, memory, 0), [2, 'x']);
    assert.deepEqual(at(0, 2), [1, 7]);
    assert.deepEqual(t.helpers.numbers(xs, 0, 4, memory, 0), [2, 'x']);
    assert.deepEqual(reads, [1], 'the inherited getter ran once; nothing after the stop');
    const boom = new RangeError('getter');
    const throwing = [1];
    Object.defineProperty(throwing, 1, {
      get() {
        throw boom;
      },
    });
    assert.throws(
      () => t.helpers.numbers(throwing, 0, 2, memory, 0),
      (e) => e === boom,
    );
    // A getter that grows the memory detaches the buffer being written.
    const growing = [1, 0, 3];
    Object.defineProperty(growing, 1, { get: () => (memory.grow(1), 2) });
    assert.equal(t.helpers.numbers(growing, 0, 3, memory, 8), undefined);
    assert.equal(memory.buffer.byteLength, 2 * 65536);
    assert.deepEqual(at(8, 3), [1, 2, 3]);
    // A patched %TypedArray%.prototype.length cannot hide the detachment.
    const TypedArray = Object.getPrototypeOf(Uint8Array.prototype);
    const length = Object.getOwnPropertyDescriptor(TypedArray, 'length');
    Object.defineProperty(TypedArray, 'length', { get: () => 1, configurable: true });
    try {
      const patched = [1, 0, 3, 4];
      Object.defineProperty(patched, 1, { get: () => (memory.grow(1), 2) });
      assert.equal(t.helpers.numbers(patched, 0, 4, memory, 16), undefined);
    } finally {
      Object.defineProperty(TypedArray, 'length', length);
    }
    assert.deepEqual(at(16, 4), [1, 2, 3, 4]);
    t.dispose();
  });

  test('independent Wasm instances: routing, per-instance wrapper identity, ABI and duplicate refusal', async () => {
    const instance = (modules, released) => {
      class RnrsWebAdapter {
        generation = 1;
        constructor(name, _hash, _max, _notify, helpers) {
          this.name = name;
          this.helpers = helpers;
        }
        teardown() {}
      }
      for (const m of ['call', 'call0', 'call1', 'call2', 'call3', 'call4'])
        RnrsWebAdapter.prototype[m] = () => {};
      return {
        RnrsWebAdapter,
        rnrs_release_slot: (slot, version) => released.push([slot, version]),
        rnrs_web_abi: () => WEB_ABI,
        rnrs_web_modules: () => modules,
      };
    };
    const releasedA = [],
      releasedB = [];
    const a = instance(['A1', 'A2'], releasedA);
    const b = instance(['B'], releasedB);
    const created = [];
    for (const w of [a, b]) {
      const Base = w.RnrsWebAdapter;
      w.RnrsWebAdapter = class extends Base {
        constructor(...args) {
          super(...args);
          created.push({ instance: w, adapter: this });
        }
      };
    }
    const backend = installWebBackend([a, b]);
    backend.install('A2', 'h', 4, () => {});
    backend.install('B', 'h', 4, () => {});
    assert.equal(created[0].instance, a, 'A2 is constructed by instance a');
    assert.equal(created[1].instance, b, 'B is constructed by instance b');
    const ha = created[0].adapter.helpers,
      hb = created[1].adapter.helpers;
    assert.notEqual(ha, hb, 'helpers are per instance');
    const wrapper = ha.wrap(3, 7);
    assert.deepEqual(ha.unwrap(wrapper), [3, 7]);
    assert.equal(hb.unwrap(wrapper), null, "another instance's wrapper unwraps to nothing");
    assert.throws(
      () => backend.install('C', 'h', 4, () => {}),
      /module C is not linked into this app \(linked: A1, A2, B\)/,
    );
    // A collected wrapper is released by the instance that created it, and only by it.
    (() => ha.wrap(9, 1))();
    for (let i = 0; i < 20 && releasedA.length === 0; i++) {
      globalThis.gc();
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(releasedA, [[9, 1]]);
    assert.deepEqual(releasedB, []);
    backend.dispose();
    assert.throws(
      () => installWebBackend([a, instance(['A1'], [])]),
      /module A1 is provided by two Wasm instances/,
    );
    assert.throws(
      () => installWebBackend([{ ...a, rnrs_web_abi: () => WEB_ABI + 1 }]),
      new RegExp(`built for web ABI ${WEB_ABI + 1}, this @rnrs/runtime needs ${WEB_ABI}`),
    );
    const { rnrs_web_abi: _, ...old } = a;
    assert.throws(
      () => installWebBackend(old),
      /built for web ABI \(none: an older @rnrs\/runtime\)/,
    );
  });

  test('initRnrs hands a surface bootstrap every instance, also when every module is prebuilt', async () => {
    const { initRnrs } = await import('../src/web.ts');
    const prebuilt = (name) => ({
      default: async () => {},
      rnrs_web_abi: () => WEB_ABI,
      rnrs_web_modules: () => [name],
      rnrs_release_slot() {},
      RnrsWebAdapter: class {},
    });
    const p = prebuilt('P'),
      q = prebuilt('Q');
    let given;
    await initRnrs({ instances: [p, q], source: null }, undefined, {
      bootstrap: (instances) => ((given = instances), { dispose() {} }),
    });
    assert.deepEqual(given, [p, q]);
  });

  test('declared errors: host helpers add domainError and keep the instance helpers', async () => {
    const { conversionHelpers } = await import('../src/runtime.ts');
    const plain = install();
    assert.equal(plain.helpers.domainError, conversionHelpers.domainError, 'shared refusal');
    const domainError = () => new Error('declared');
    const t = install({ hostHelpers: Object.freeze({ ...conversionHelpers, domainError }) });
    assert.equal(t.helpers.domainError, domainError);
    assert.ok(Object.isFrozen(t.helpers));
    // The instance's own helpers (one handle map per instance) win over the shared ones.
    const own = t.instanceHelpers();
    assert.notEqual(own, t.helpers);
    for (const key of ['numbers', 'wrap', 'unwrap']) assert.equal(t.helpers[key], own[key], key);
    assert.equal(t.helpers.get, conversionHelpers.get);
    const handle = t.helpers.wrap(3, 7);
    assert.deepEqual(t.helpers.unwrap(handle), [3, 7]);
    plain.dispose();
    t.dispose();
  });
}
