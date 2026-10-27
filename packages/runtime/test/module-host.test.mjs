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
      [FLAG, '--no-warnings', '--test', '--test-reporter=tap', fileURLToPath(import.meta.url)],
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
      /Future was generated for call protocol 4, but this @rnrs\/runtime implements up to 3/,
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
}
