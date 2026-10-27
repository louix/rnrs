// The emitted TS wrapper of the values fixture, run against the real runtime.ts with a
// scripted backend: native handles nested in results (records, unions, arrays, optional and
// nullable values, sync and async) become wrapper objects; nested inputs pass through
// unchanged for the native side, which reads a wrapper's `handle` itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appPackages, plan, ROOT } from '../cli.mjs';
import { emitTs } from '../emit-ts.mjs';

const FLAG = '--experimental-transform-types';

// `Record<string, T>` results holding handles (IR kind `map`, parsed by the Record slice):
// written as IR here. MapProbe has no record or union, so only its map results need the
// wrapping helpers; HolderProbe holds a map inside a record.
const item = { k: 'native', name: 'Item' };
const probe = (module, records, methods) => ({
  spec: 'native-composition fixture',
  module,
  hash: 'test',
  objects: [{ name: 'Item' }],
  records,
  unions: [],
  methods: [{ name: 'label', owner: 'Item', params: [], returns: { k: 'string' } }, ...methods],
});
const PROBES = {
  MapProbe: probe(
    'MapProbe',
    [],
    [
      { name: 'items', params: [], returns: { k: 'map', of: item } },
      { name: 'itemsLater', async: true, params: [], returns: { k: 'map', of: item } },
    ],
  ),
  HolderProbe: probe(
    'HolderProbe',
    [
      {
        name: 'Holder',
        fields: [
          { name: 'byName', type: { k: 'map', of: { k: 'nullable', of: item } }, optional: false },
        ],
      },
    ],
    [{ name: 'holder', params: [], returns: { k: 'record', name: 'Holder' } }],
  ),
};

if (!process.execArgv.includes(FLAG)) {
  test('native handles nested in results become wrappers (emitted TS under the type transform)', () => {
    const dir = path.join(ROOT, '.generated/native-composition');
    mkdirSync(dir, { recursive: true });
    const pkg = appPackages().find((p) => p.crate === 'values');
    const runtimeImport = pathToFileURL(path.join(ROOT, 'packages/runtime/src/runtime.ts')).href;
    const ts = plan([pkg]).find((o) => o.kind === 'ts');
    // Same generator call as the plan, importing the runtime by file URL (with extension).
    writeFileSync(
      path.join(dir, 'values.ts'),
      ts.content.replace(/from '[^']*packages\/runtime\/src\/runtime'/, `from '${runtimeImport}'`),
    );
    for (const [name, ir] of Object.entries(PROBES))
      writeFileSync(path.join(dir, `${name}.ts`), emitTs(ir, { runtimeImport, maxInFlight: 8 }));
    const run = spawnSync(
      process.execPath,
      [FLAG, '--no-warnings', '--test', '--test-reporter=tap', fileURLToPath(import.meta.url)],
      { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^# pass [1-9]/m, run.stdout);
    assert.match(run.stdout, /^# fail 0$/m, run.stdout);
  });
} else {
  const rt = await import('../../../packages/runtime/src/runtime.ts');
  const generated = path.join(ROOT, '.generated/native-composition/values.ts');
  const values = await import(pathToFileURL(generated).href);
  const methods = (await import('../cli.mjs'))
    .plan(appPackages().filter((p) => p.crate === 'values'))
    .find((o) => o.kind === 'ir');
  const ir = JSON.parse(methods.content);
  const index = (name) =>
    ir.methods.findIndex((m) => (m.owner ? `${m.owner}.${m.name}` : m.name) === name);

  // Handles are opaque objects to JS; the scripted adapter answers per method.
  const handle = (label) => ({ label });
  let answer = () => undefined;
  const seen = [];
  const respond = (i, receiver, args) => {
    seen.push({ i, receiver, args });
    return answer(i, receiver, args);
  };
  rt.setBackend({
    platform: 'test',
    install: () => ({
      generation: 1,
      call: (i, r, args) => respond(i, r, args),
      call0: (i, r) => respond(i, r, []),
      call1: (i, r, a) => respond(i, r, [a]),
      call2: (i, r, a, b) => respond(i, r, [a, b]),
      call3: (i, r, a, b, c) => respond(i, r, [a, b, c]),
      call4: (i, r, a, b, c, d) => respond(i, r, [a, b, c, d]),
      entry: () => () => 0,
      cancel: () => false,
      dispose() {},
      teardown() {},
      stats: () => ({}),
    }),
  });
  const module = values.createValuesModuleForTesting(8);
  const db = new values.Database(module.host, handle('db'));

  test('records: required, optional and array fields; absent optional fields stay absent', () => {
    const [s, sh, o] = [handle('s'), handle('sh'), handle('o')];
    answer = () => ({ statement: s, sql: 'q', shader: sh, others: [o] });
    const p = db.prepared('q');
    assert.ok(p.statement instanceof values.Statement && p.statement.handle === s);
    assert.ok(p.shader instanceof values.Shader && p.shader.handle === sh);
    assert.ok(p.others[0] instanceof values.Statement && p.others[0].handle === o);
    assert.equal(p.sql, 'q');
    // A polluted prototype is not mistaken for an omitted optional field.
    Object.prototype.shader = handle('polluted');
    try {
      answer = () => ({ statement: s, sql: 'q', others: [] });
      const bare = db.prepared('q');
      assert.equal(Object.hasOwn(bare, 'shader'), false);
    } finally {
      delete Object.prototype.shader;
    }
  });

  test('unions, arrays and nullable values', () => {
    const [a, b] = [handle('a'), handle('b')];
    answer = () => [
      { kind: 'one', statement: a },
      { kind: 'many', statements: [a, b], first: null },
      { kind: 'many', statements: [], first: b },
      { kind: 'empty' },
    ];
    const slots = module.statementSlots(db);
    assert.equal(slots[0].statement.handle, a);
    assert.deepEqual(
      slots[1].statements.map((s) => s instanceof values.Statement && s.handle.label),
      ['a', 'b'],
    );
    assert.equal(slots[1].first, null);
    assert.equal(slots[2].first.handle, b);
    assert.deepEqual(slots[3], { kind: 'empty' });
    answer = () => null;
    assert.equal(module.maybePrepared(null), null);
    assert.equal(db.pick(null), null);
    answer = () => a;
    assert.equal(db.pick(null).handle, a);
  });

  test('each result is read once', () => {
    let calls = 0;
    answer = () => (calls++, handle('one'));
    db.pick(null);
    assert.equal(calls, 1);
  });

  test('nested inputs reach the adapter unchanged; top-level wrappers pass their handle', () => {
    const shader = new values.Shader(module.host, handle('sh'));
    const record = {
      statement: new values.Statement(module.host, handle('s')),
      sql: 'q',
      shader,
      others: [],
    };
    answer = () => 'ok';
    db.describePrepared(record);
    assert.equal(seen.at(-1).args[0], record);
    assert.equal(seen.at(-1).receiver, db.handle);
    answer = () => ({ statement: handle('s'), sql: 'q', others: [] });
    db.prepared('q', shader);
    assert.equal(seen.at(-1).args[1], shader.handle);
    assert.equal(seen.at(-1).i, index('Database.prepared'));
  });

  test('async results are wrapped at settlement', async () => {
    const s = handle('s');
    answer = () => 7;
    const later = module.preparedLater(db, 'q', 1);
    module.host.settle(7, 0, { statement: s, sql: 'q', others: [s] }, '');
    const p = await later;
    assert.ok(p.statement instanceof values.Statement && p.others[0].handle === s);
    answer = () => 8;
    const all = db.prepareAll(['a']);
    module.host.settle(8, 0, [s], '');
    assert.equal((await all)[0].handle, s);
  });

  test('values Record methods (real parser): handles wrapped directly and inside records', async () => {
    const [a, b] = [handle('a'), handle('b')];
    answer = () => ({ x: a });
    const direct = module.echoStatementsByName({});
    assert.ok(direct.x instanceof values.Statement && direct.x.handle === a);
    answer = () => ({ p: { statement: a, sql: 'a', others: [b] }, n: null });
    const nested = module.echoPreparedByName({});
    assert.ok(nested.p.statement instanceof values.Statement && nested.p.statement.handle === a);
    assert.ok(nested.p.others[0] instanceof values.Statement && nested.p.others[0].handle === b);
    assert.equal(nested.n, null);
    answer = () => 11;
    const later = module.statementsByNameLater(db, ['y'], 1);
    module.host.settle(11, 0, { y: b }, '');
    assert.equal((await later).y.handle, b);
    // Inputs pass through for the native side to read.
    const input = { x: new values.Statement(module.host, a) };
    answer = () => ({});
    module.echoStatementsByName(input);
    assert.equal(seen.at(-1).args[0], input);
  });

  const dir = path.join(ROOT, '.generated/native-composition');
  const mapProbe = await import(pathToFileURL(path.join(dir, 'MapProbe.ts')).href);
  const holderProbe = await import(pathToFileURL(path.join(dir, 'HolderProbe.ts')).href);
  /** A map result as the adapter builds it: own data properties of a fresh object. */
  const mapOf = (entries) => {
    const out = {};
    for (const [key, value] of entries) rt.conversionHelpers.define(out, key, value);
    return out;
  };

  test('Record results: every own key is wrapped, including __proto__ and integer-like keys', () => {
    const m = mapProbe.createMapProbeForTesting(8);
    const [a, p, one] = [handle('a'), handle('p'), handle('1')];
    let calls = 0;
    answer = () => (
      calls++,
      mapOf([
        ['a', a],
        ['__proto__', p],
        ['1', one],
      ])
    );
    const items = m.items();
    assert.equal(calls, 1, 'the result is read once');
    assert.equal(Object.getPrototypeOf(items), Object.prototype);
    assert.deepEqual(Object.keys(items).sort(), ['1', '__proto__', 'a']);
    for (const [key, h] of [
      ['a', a],
      ['__proto__', p],
      ['1', one],
    ]) {
      const value = Object.getOwnPropertyDescriptor(items, key).value;
      assert.ok(value instanceof mapProbe.Item && value.handle === h, key);
    }
  });

  test('Record results: async, and nullable values inside a record field', async () => {
    const m = mapProbe.createMapProbeForTesting(8);
    const h = handle('later');
    answer = () => 9;
    const later = m.itemsLater();
    m.host.settle(9, 0, mapOf([['x', h]]), '');
    const items = await later;
    assert.ok(items.x instanceof mapProbe.Item && items.x.handle === h);
    const holders = holderProbe.createHolderProbeForTesting(8);
    answer = () => ({
      byName: mapOf([
        ['a', h],
        ['b', null],
      ]),
    });
    const holder = holders.holder();
    assert.ok(holder.byName.a instanceof holderProbe.Item && holder.byName.a.handle === h);
    assert.equal(holder.byName.b, null);
  });
}
