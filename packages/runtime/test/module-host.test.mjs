// ModuleHost against custom/older backends (packages/runtime/src/runtime.ts, loaded through
// Node's TypeScript transform): protocol 1/2 modules keep working on a backend without
// prepared scalar entries; protocol 3 modules are refused there with an actionable error and
// nothing stays installed; entries and the host's helpers property are installed as specified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FLAG = '--experimental-transform-types';

if (!process.execArgv.includes(FLAG)) {
  // Re-run this file with the transform, so `npm test` needs no extra flags.
  test('ModuleHost backend compatibility (runtime.ts under the Node type transform)', () => {
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
  const rt = await import('../src/runtime.ts');
  const { ModuleBase, createModuleForTesting, runtimeModule, setBackend, conversionHelpers } = rt;

  const backend = ({ entry } = {}) => {
    const log = { installs: 0, teardowns: 0, releases: 0, entries: [] };
    const positional = () => 'positional';
    const adapter = {
      generation: 1,
      call: () => 'array',
      call0: positional,
      call1: positional,
      call2: positional,
      call3: positional,
      call4: positional,
      cancel: () => false,
      dispose() {},
      teardown: () => void log.teardowns++,
      stats: () => ({}),
    };
    if (entry)
      adapter.entry = (index, arity) => {
        log.entries.push([index, arity]);
        return entry(index, arity);
      };
    setBackend({
      platform: 'test',
      install() {
        log.installs++;
        return adapter;
      },
      release: () => void log.releases++,
    });
    return { log, adapter };
  };
  const moduleClass = (name, descriptor) =>
    class extends ModuleBase {
      static descriptor = { name, hash: 'h', defaultMaxInFlight: 4, ...descriptor };
      add(a, b) {
        return this.host.m0 ? this.host.m0(a, b) : this.host.call2(0, undefined, a, b);
      }
    };

  test('a backend without entry still serves protocol 1 and 2 modules', () => {
    const { log } = backend();
    for (const [name, descriptor] of [
      ['Array', {}],
      ['Positional', { protocol: 2 }],
    ]) {
      const m = createModuleForTesting(moduleClass(name, descriptor), 4);
      assert.equal(m.add(1, 2), 'positional');
      assert.equal(m.host.m0, undefined);
      m.teardown();
    }
    const owned = runtimeModule(moduleClass('Owned', { protocol: 2 }));
    assert.equal(owned.add(1, 2), 'positional');
    assert.deepEqual([log.installs, log.teardowns, log.releases], [3, 2, 2]);
  });

  test('a protocol 3 module on a backend without entry is refused; nothing stays installed', () => {
    const { log } = backend();
    const Mod = moduleClass('Scalar', { protocol: 3, direct: [[0, 2]] });
    assert.throws(
      () => createModuleForTesting(Mod, 4),
      /the test backend has no prepared scalar entries, which Scalar \(call protocol 3\) needs; use a backend from this @rnrs\/runtime/,
    );
    assert.throws(() => runtimeModule(Mod), /no prepared scalar entries/);
    assert.deepEqual([log.installs, log.teardowns, log.releases], [2, 2, 2]);
    // The refused runtime module was not cached: a later attempt installs again.
    assert.throws(() => runtimeModule(Mod), /no prepared scalar entries/);
    assert.equal(log.installs, 3);
  });

  test('entries become m<index> host properties; helpers are a fixed own property', () => {
    const prepared = function m0(a, b) {
      return a + b;
    };
    const { log } = backend({ entry: () => prepared });
    const m = createModuleForTesting(
      moduleClass('Scalar', {
        protocol: 3,
        direct: [
          [0, 2],
          [3, 1],
        ],
      }),
      4,
    );
    assert.deepEqual(log.entries, [
      [0, 2],
      [3, 1],
    ]);
    assert.equal(m.host.m0, prepared);
    assert.equal(m.host.m3, prepared);
    assert.equal(m.add(2, 3), 5);
    assert.deepEqual(Object.getOwnPropertyDescriptor(m.host, 'rnrs:helpers'), {
      value: conversionHelpers,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    assert.throws(() => {
      m.host['rnrs:helpers'] = {};
    }, TypeError);
    assert.throws(() => delete m.host['rnrs:helpers'], TypeError);
    assert.ok(!Object.keys(m.host).includes('rnrs:helpers'));
    m.teardown();
  });

  test('an entry the backend cannot provide refuses the module and tears it down', () => {
    const { log } = backend({
      entry: (index) => {
        if (index === 7) throw new Error('no prepared entry for method 7');
        return () => 0;
      },
    });
    assert.throws(
      () =>
        createModuleForTesting(
          moduleClass('Mismatch', {
            protocol: 3,
            direct: [
              [0, 2],
              [7, 1],
            ],
          }),
          4,
        ),
      /no prepared entry for method 7/,
    );
    assert.deepEqual([log.installs, log.teardowns, log.releases], [1, 1, 1]);
  });

  test('wrappers for a newer protocol are refused before install', () => {
    const { log } = backend({ entry: () => () => 0 });
    assert.throws(
      () => createModuleForTesting(moduleClass('Future', { protocol: rt.RUNTIME_PROTOCOL + 1 }), 4),
      new RegExp(
        `Future was generated for call protocol ${rt.RUNTIME_PROTOCOL + 1}, but this @rnrs/runtime implements up to ${rt.RUNTIME_PROTOCOL}`,
      ),
    );
    assert.equal(log.installs, 0);
  });

  test('entries: own enumerable string keys of plain objects only (Record and JsonValue)', () => {
    const { entries, define } = conversionHelpers;
    const base = { inherited: 1 };
    const own = Object.create(base);
    assert.equal(entries(own), null, 'another prototype: not a plain object');
    const plain = { b: 2, 10: 'ten', a: 1, [Symbol('s')]: 3 };
    Object.defineProperty(plain, 'hidden', { value: 4, enumerable: false });
    assert.deepEqual(entries(plain), [
      ['10', 'ten'],
      ['b', 2],
      ['a', 1],
    ]);
    const bare = Object.create(null);
    bare.k = 'v';
    assert.deepEqual(entries(bare), [['k', 'v']]);
    for (const other of [
      new Date(0),
      new Map([['k', 1]]),
      new (class Row {})(),
      new ArrayBuffer(1),
    ])
      assert.equal(entries(other), null);
    // A JSON-parsed __proto__ key is an own key like any other.
    assert.deepEqual(entries(JSON.parse('{"__proto__": 1}')), [['__proto__', 1]]);
    // Getters run once, in order; their exceptions and proxy traps propagate unchanged.
    const reads = [];
    const withGetters = {
      get a() {
        reads.push('a');
        return 1;
      },
      get b() {
        reads.push('b');
        return 2;
      },
    };
    assert.deepEqual(entries(withGetters), [
      ['a', 1],
      ['b', 2],
    ]);
    assert.deepEqual(reads, ['a', 'b']);
    const boom = new Error('boom');
    assert.throws(
      () =>
        entries({
          get x() {
            throw boom;
          },
        }),
      (e) => e === boom,
    );
    const trap = new Error('trap');
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw trap;
        },
      },
    );
    assert.throws(
      () => entries(proxy),
      (e) => e === trap,
    );
    assert.deepEqual(entries(new Proxy({ p: 1 }, {})), [['p', 1]]);
    // Output side: defining __proto__ creates an own property; no prototype changes.
    const out = {};
    define(out, '__proto__', { polluted: true });
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.deepEqual(Object.keys(out), ['__proto__']);
    assert.equal({}.polluted, undefined);
  });

  // ---- Declared errors (spec Throws<T, E>) ----

  const { DomainError, RnrsError, isDomainError } = rt;
  const ERRORS = [
    [0, 'Kv.get', 'KvError', 'kind'],
    [2, 'Kv.load', 'KvError', 'kind'],
    [3, 'Kv.sum', 'Overflow', null],
  ];
  /** A backend that records what install received; `retain` keeps helpers like a native root. */
  const recordingBackend = () => {
    const installs = [];
    const adapter = {
      generation: 1,
      call: () => 1,
      call0: () => 0,
      call1: () => 0,
      call2: () => 0,
      call3: () => 0,
      call4: () => 0,
      cancel: () => false,
      dispose() {},
      teardown() {},
      stats: () => ({}),
    };
    setBackend({
      platform: 'test',
      install(name, hash, maxInFlight, settle, helpers) {
        installs.push({ name, helpers, settle: new WeakRef(settle) });
        return adapter;
      },
    });
    return { installs, adapter };
  };
  const errorModule = (errors = ERRORS) =>
    class Kv extends ModuleBase {
      static descriptor = { name: 'Kv', hash: 'h', defaultMaxInFlight: 4, protocol: 4, errors };
    };

  test('declared errors: hosts with errors pass their own helpers; others the shared ones', () => {
    const { installs } = recordingBackend();
    const plain = createModuleForTesting(moduleClass('Plain', { protocol: 2 }), 4);
    assert.equal(installs[0].helpers, undefined);
    assert.equal(plain.host['rnrs:helpers'], conversionHelpers);
    const kv = createModuleForTesting(errorModule(), 4);
    const helpers = installs[1].helpers;
    assert.ok(Object.isFrozen(helpers));
    assert.notEqual(helpers, conversionHelpers);
    assert.equal(kv.host['rnrs:helpers'], helpers, 'every sync path of the host carries them');
    for (const key of Object.keys(conversionHelpers))
      if (key !== 'domainError') assert.equal(helpers[key], conversionHelpers[key], key);
    plain.teardown();
    kv.teardown();
  });

  test('declared errors: DomainError shape, message and brand', () => {
    const { installs } = recordingBackend();
    const Kv = errorModule();
    const kv = createModuleForTesting(Kv, 4);
    const raise = installs[0].helpers.domainError;
    const data = { kind: 'corrupt', offset: 3 };
    const error = raise(0, data);
    assert.ok(error instanceof DomainError && error instanceof Error);
    assert.ok(!(error instanceof RnrsError));
    assert.equal(error.name, 'KvError');
    assert.equal(error.message, 'Kv.get failed: corrupt');
    assert.equal(error.data, data);
    assert.equal(Object.isFrozen(error.data), false);
    assert.equal(error.code, undefined);
    assert.equal(error.cause, undefined);
    assert.ok(isDomainError(error, Kv.descriptor, 'KvError'));
    assert.ok(!isDomainError(error, Kv.descriptor, 'Overflow'));
    // A second copy of the wrapper (same names, another descriptor object) does not match.
    assert.ok(!isDomainError(error, errorModule().descriptor, 'KvError'));
    // Look-alikes and unbranded instances do not match.
    assert.ok(!isDomainError({ name: 'KvError', data }, Kv.descriptor, 'KvError'));
    assert.ok(!isDomainError(new DomainError('KvError', 'x', data), Kv.descriptor, 'KvError'));
    assert.ok(!isDomainError(undefined, Kv.descriptor, 'KvError'));
    // A record error has no tag; a method without an entry is an explicit framework error.
    const overflow = raise(3, { limit: 1, got: [2] });
    assert.equal(overflow.message, 'Kv.sum failed');
    assert.ok(isDomainError(overflow, Kv.descriptor, 'Overflow'));
    const unknown = raise(1, {});
    assert.ok(unknown instanceof RnrsError && unknown.code === 'failed');
    assert.match(
      unknown.message,
      /Kv method #1 reported a declared error its wrapper does not declare/,
    );
    // The shared helpers refuse explicitly.
    const shared = conversionHelpers.domainError(5, {});
    assert.ok(shared instanceof RnrsError);
    assert.match(shared.message, /wrapper declares none; regenerate/);
    // Stale: a torn-down host's errors still describe their data.
    kv.teardown();
    assert.ok(isDomainError(error, Kv.descriptor, 'KvError'));
  });

  test('declared errors: settlement status 4 rejects with the DomainError', async () => {
    const { installs, adapter } = recordingBackend();
    let next = 10;
    adapter.call = () => next++;
    const Kv = errorModule();
    const kv = createModuleForTesting(Kv, 4);
    const settle = installs[0].settle.deref();
    const load = kv.host.start(2, undefined, ['k'], undefined);
    settle(10, 4, { kind: 'notFound', key: 'k' }, '');
    const error = await load.then(
      () => assert.fail('resolved'),
      (e) => e,
    );
    assert.ok(isDomainError(error, Kv.descriptor, 'KvError'));
    assert.equal(error.message, 'Kv.load failed: notFound');
    assert.deepEqual(error.data, { kind: 'notFound', key: 'k' });
    // Status 4 for a method without a declared error: explicit failure and a violation.
    const other = kv.host.start(1, undefined, [], undefined);
    settle(11, 4, {}, '');
    await assert.rejects(other, (e) => e instanceof RnrsError && e.code === 'failed');
    assert.equal(kv.violations.length, 1);
    // Existing statuses are unchanged.
    const failed = kv.host.start(2, undefined, [], undefined);
    settle(12, 2, undefined, 'plain failure');
    await assert.rejects(failed, (e) => e instanceof RnrsError && e.message === 'plain failure');
    const cancelled = kv.host.start(2, undefined, [], undefined);
    settle(13, 1, undefined, '');
    await assert.rejects(cancelled, (e) => e.name === 'AbortError');
    kv.teardown();
  });

  test('declared errors: the helper holds no host (a torn-down host is collectable)', async () => {
    assert.equal(typeof globalThis.gc, 'function', 'run with --expose-gc');
    const { installs } = recordingBackend();
    const Kv = errorModule();
    const host = (() => {
      const kv = createModuleForTesting(Kv, 4);
      kv.teardown();
      return new WeakRef(kv.host);
    })();
    // Retained like a native root (JSI callh binding, web adapter helpers) plus an error.
    const helpers = installs[0].helpers;
    const error = helpers.domainError(0, { kind: 'x' });
    for (let i = 0; i < 10 && host.deref() !== undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      globalThis.gc();
    }
    assert.equal(host.deref(), undefined);
    assert.ok(isDomainError(error, Kv.descriptor, 'KvError'));
  });

  test('declared errors: worklet endpoints refuse methods that declare them', () => {
    recordingBackend();
    const kv = createModuleForTesting(errorModule(), 4);
    const refuse = (methods) => rt.refuseDeclaredErrorsOnWorklets(kv, methods);
    assert.throws(
      () => refuse(['size', 'get']),
      (e) =>
        e instanceof TypeError &&
        e.code === 'ERR_RNRS_WORKLET_THROWS' &&
        e.message.startsWith('get:'),
    );
    assert.doesNotThrow(() => refuse(['size', 'Snapshot.read']));
    assert.doesNotThrow(() =>
      rt.refuseDeclaredErrorsOnWorklets(createModuleForTesting(moduleClass('W', {}), 4), ['get']),
    );
    kv.teardown();
  });
}
