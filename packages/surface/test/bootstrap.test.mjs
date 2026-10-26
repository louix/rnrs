// The browser surface bootstrap (packages/surface/src/browser/bootstrap.ts, loaded through Node's
// TypeScript transform) over fake Wasm instances: owner binding per instance, routing of keys
// whose local parts collide, refusals (unknown owner, partial exports, another surface ABI) with
// no side effect before every instance is checked, owners kept across re-installation, and
// disposal detaching every mount before any instance's release listener is cleared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const FLAG = '--experimental-transform-types';

if (!process.execArgv.includes(FLAG)) {
  // Re-run this file with the transform, so `npm test` needs no extra flags.
  test('surface bootstrap (bootstrap.ts under the Node type transform)', () => {
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
  registerHooks({
    resolve: (specifier, context, next) =>
      next(
        specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)
          ? `${specifier}.ts`
          : specifier,
        context,
      ),
  });
  const { createSurfaceBootstrap, SURFACE_ABI } = await import('../src/browser/bootstrap.ts');
  const SPAN = 2 ** 32;

  /** A fake instance of `name` (its module list) logging into `log`. */
  const instance = (name, log, { abi = SURFACE_ABI, omit } = {}) => {
    let bound = 0,
      listener,
      nextToken = 1;
    const w = {
      rnrs_web_modules: () => [name],
      rnrs_surface_abi: () => abi,
      // rnrs-surface bind_web: binds once, returns the owner it is bound to.
      rnrs_surface_bind: (owner) => {
        if (!bound && owner >= 1 && owner < 2 ** 21) bound = owner;
        return bound;
      },
      rnrs_surface_set_release_listener: (l) => {
        listener = l;
        log.push([name, l ? 'listen' : 'unlisten']);
      },
      rnrs_surface_attach: (key) => {
        log.push([name, 'attach', key]);
        return nextToken++;
      },
      rnrs_surface_resize: () => 'ok',
      rnrs_surface_detach: (key, token) => {
        log.push([name, 'detach', key, token]);
        listener?.(key, token);
      },
      rnrs_surface_render: () => ({ status: 'unchanged' }),
      rnrs_surface_presentation: (key) => (log.push([name, 'presentation', key]), 'webgpu'),
      rnrs_surface_bind_canvas: () => 'ok',
      rnrs_surface_touch: (key) => (log.push([name, 'touch', key]), true),
      owner: () => bound,
      listening: () => listener !== undefined,
    };
    if (omit) delete w[omit];
    return w;
  };
  const env = {
    requestFrame: () => 1,
    cancelFrame() {},
    delay: () => 1,
    cancelDelay() {},
    now: () => 0,
    observe: () => () => {},
    measure: () => ({ width: 10, height: 10 }),
    dpr: () => 1,
    visible: () => true,
    listenVisibility: () => () => {},
    listenPage: () => () => {},
  };
  const canvas = () => ({
    width: 0,
    height: 0,
    getContext: () => ({}),
    addEventListener() {},
    removeEventListener() {},
  });
  const element = { hasPointerCapture: () => false };

  test('each instance gets its own owner; keys with the same local part route to their own instance', () => {
    const log = [];
    const a = instance('A', log),
      b = instance('B', log);
    const headless = { rnrs_web_modules: () => ['H'] };
    const boot = createSurfaceBootstrap([headless, a, b], undefined, env);
    const [oa, ob] = [a.owner(), b.owner()];
    assert.ok(oa >= 1 && ob >= 1 && oa !== ob, `distinct owners ${oa} ${ob}`);
    assert.ok(a.listening() && b.listening());
    const [ka, kb] = [oa * SPAN + 1, ob * SPAN + 1];
    assert.equal(boot.bridge.attach(ka, { width: 1, height: 1, scale: 1 }), 1);
    assert.equal(boot.bridge.attach(kb, { width: 1, height: 1, scale: 1 }), 1);
    assert.equal(boot.bridge.touch(kb, 1, 0, 1, 0, 0, 0), true);
    assert.deepEqual(
      log.filter(([, op]) => op === 'attach' || op === 'touch'),
      [
        ['A', 'attach', ka],
        ['B', 'attach', kb],
        ['B', 'touch', kb],
      ],
    );
    // Unknown owners (and owner 0) match nothing; invalid keys are refused before decoding.
    const unknown = (Math.max(oa, ob) + 1) * SPAN + 1;
    for (const key of [unknown, 5]) {
      assert.equal(boot.bridge.attach(key, { width: 1, height: 1, scale: 1 }), 'closed');
      assert.equal(boot.bridge.presentation(key), 'closed');
      assert.equal(boot.bridge.resize(key, 1, { width: 1, height: 1, scale: 1 }), 'closed');
      assert.deepEqual(boot.bridge.render(key, 1, true), { status: 'closed' });
      assert.equal(boot.bridge.bindCanvas(key, 1, canvas()), 'closed');
      assert.equal(boot.bridge.touch(key, 1, 0, 1, 0, 0, 0), false);
      boot.bridge.detach(key, 1);
    }
    for (const key of [0, -1, 1.5, 2 ** 53, Number.NaN])
      assert.throws(
        () => boot.bridge.attach(key, { width: 1, height: 1, scale: 1 }),
        /invalid surface key/,
      );
    assert.equal(
      log.filter(([, op]) => op === 'attach').length,
      2,
      'no refused key reached an instance',
    );
    boot.dispose();
  });

  test('releases from every instance reach the host with full keys; dispose detaches every mount before any listener is cleared', () => {
    const log = [];
    const a = instance('A', log),
      b = instance('B', log);
    const boot = createSurfaceBootstrap([a, b], undefined, env);
    const released = [];
    boot.bridge.onRelease((key, token) => released.push([key, token]));
    const [ka, kb] = [a.owner() * SPAN + 1, b.owner() * SPAN + 1];
    const ca = canvas();
    boot.host.mount(ca, element, ka);
    boot.host.mount(canvas(), element, kb);
    assert.throws(() => boot.host.mount(ca, element, kb), /canvas already mounted/);
    log.length = 0;
    boot.dispose();
    const order = log.map(([n, op]) => `${n} ${op}`);
    assert.deepEqual(order, ['A detach', 'B detach', 'A unlisten', 'B unlisten']);
    assert.deepEqual(released, [
      [ka, 1],
      [kb, 1],
    ]);
    assert.ok(!a.listening() && !b.listening());
  });

  test('a mismatching or partial surface instance fails the installation before any instance is bound or listened to', () => {
    const log = [];
    const good = instance('Good', log);
    assert.throws(
      () =>
        createSurfaceBootstrap(
          [good, instance('Old', log, { abi: SURFACE_ABI + 1 })],
          undefined,
          env,
        ),
      new RegExp(
        `the Wasm instance of Old implements surface ABI ${SURFACE_ABI + 1}, this @rnrs/surface needs ${SURFACE_ABI}`,
      ),
    );
    assert.equal(good.owner(), 0, 'not bound');
    assert.equal(good.listening(), false, 'no listener left');
    assert.throws(
      () =>
        createSurfaceBootstrap(
          [good, instance('Partial', log, { omit: 'rnrs_surface_bind' })],
          undefined,
          env,
        ),
      /the Wasm instance of Partial lacks the surface export rnrs_surface_bind/,
    );
    assert.equal(good.owner(), 0);
    assert.deepEqual(log, []);
    assert.throws(
      () => createSurfaceBootstrap([{ rnrs_web_modules: () => ['H'] }], undefined, env),
      /Surface exports missing/,
    );
  });

  test('installing an instance again (also through another JS object for it) keeps its owner; a new instance gets a new one', () => {
    const log = [];
    const a = instance('A', log),
      b = instance('B', log);
    createSurfaceBootstrap([a, b], undefined, env).dispose();
    const [oa, ob] = [a.owner(), b.owner()];
    const c = instance('C', log);
    // A copy of a's namespace object: the same Wasm instance (its state), another JS object.
    const again = createSurfaceBootstrap([{ ...a }, b, c], undefined, env);
    assert.deepEqual([a.owner(), b.owner()], [oa, ob]);
    assert.ok(c.owner() > Math.max(oa, ob));
    assert.equal(
      again.bridge.attach(oa * SPAN + 1, { width: 1, height: 1, scale: 1 }),
      1,
      'routes to a',
    );
    again.dispose();
    assert.throws(
      () => createSurfaceBootstrap([a, { ...a }], undefined, env),
      new RegExp(`the Wasm instance of A is listed twice \\(surface owner ${oa}\\)`),
    );
  });

  test('an instance bound to an owner this page never issued is refused', () => {
    const d = instance('D', []);
    d.rnrs_surface_bind(2 ** 20);
    assert.throws(
      () => createSurfaceBootstrap([d], undefined, env),
      /the Wasm instance of D is bound to surface owner 1048576, which this page never issued/,
    );
  });

  test('owners are exhausted at 2^21, never wrapped', () => {
    globalThis[Symbol.for('rnrs.surface.owners')].next = 2 ** 21 - 1;
    const last = instance('Last', []);
    createSurfaceBootstrap([last], undefined, env).dispose();
    assert.equal(last.owner(), 2 ** 21 - 1);
    assert.throws(
      () => createSurfaceBootstrap([instance('Over', [])], undefined, env),
      /surface owners exhausted/,
    );
  });
}
