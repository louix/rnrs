// Generation: determinism, hash semantics, committed-interface staleness, Counter/Meter IR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appPackages, main, plan, FRAMEWORK_SPEC, ROOT } from '../cli.mjs';
import { emitGlue } from '../emit-rust.mjs';
import { emitTs } from '../emit-ts.mjs';
import { irHash, parseSpec } from '../parse.mjs';

test('generation is deterministic', () => {
  const a = plan(appPackages()).map((o) => [o.file, o.content]);
  const b = plan(appPackages()).map((o) => [o.file, o.content]);
  assert.deepEqual(a, b);
});

test('numeric input arrays select the fused reader while generic containers remain', () => {
  const pkg = appPackages().find((p) => p.crate === 'values');
  assert.ok(pkg);
  const generated = plan([pkg])
    .map((o) => o.content)
    .join('\n');
  assert.match(generated, /env\.number_array\(/);
  assert.match(generated, /array_from_js_with\(/);
  assert.match(generated, /array_into_js_with\(/);
});

test('numeric output arrays select the bulk writer at every nesting level', () => {
  const dir = path.join(ROOT, '.generated/rnrs-test-specs/number-output');
  mkdirSync(dir, { recursive: true });
  const spec = path.join(dir, 'number-output.spec.ts');
  writeFileSync(
    spec,
    `import type { NativeModule } from '@rnrs/runtime/spec';
export interface Row { xs: number[]; maybe: number[] | null; note?: number[] }
export type Pick = { kind: 'some'; xs: number[] } | { kind: 'none' };
export interface NumbersModule extends NativeModule {
  flat(): number[];
  grid(): number[][];
  maybe(): number[] | null;
  row(): Row;
  pick(): Pick;
  later(): Promise<number[]>;
  strings(): string[];
  sum(xs: number[]): number;
}
`,
  );
  const { ir, diagnostics } = parseSpec(spec, { frameworkSpec: FRAMEWORK_SPEC, root: ROOT });
  assert.deepEqual(diagnostics, []);
  const glue = emitGlue(ir, { crate: 'test', moduleType: 'Numbers' });
  const bulk = (v) => `number_array_into_js(${v}, env)`;
  assert.ok(glue.includes(bulk('result')), 'top-level and async results');
  assert.equal(
    glue.split(`Ok(pending(move |env: &mut dyn Env| ${bulk('result')}))`).length,
    2,
    'async',
  );
  assert.ok(
    glue.includes(`array_into_js_with(result, env, &mut |value, env| ${bulk('value')})`),
    'number[][]',
  );
  assert.ok(
    glue.includes(`nullable_into_js_with(result, env, &mut |value, env| ${bulk('value')})`),
    'number[] | null',
  );
  assert.ok(glue.includes(`let value = ${bulk('record.xs')}?;`), 'record field');
  assert.ok(
    glue.includes(`nullable_into_js_with(record.maybe, env, &mut |value, env| ${bulk('value')})?;`),
    'nullable field',
  );
  assert.ok(glue.includes(`let value = ${bulk('value')}?;`), 'optional field');
  assert.ok(glue.includes(`let value = ${bulk('field_xs')}?;`), 'union variant field');
  // Element-wise output remains for other element types; numeric input keeps its fused reader.
  assert.ok(
    glue.includes('array_into_js_with(result, env, &mut |value, env| IntoJs::into_js(value, env))'),
  );
  assert.match(glue, /env\.number_array\(/);
});

test('scalar entries select only required synchronous module primitives', () => {
  const method = (name, params, returns = 'number', extra = {}) => ({
    name,
    params: params.map((k, i) => ({ name: `a${i}`, type: { k } })),
    returns: { k: returns },
    ...extra,
  });
  const ir = {
    module: 'Test',
    hash: 'test',
    objects: [],
    records: [],
    unions: [],
    methods: [
      method('zero', [], 'void'),
      method('one', ['boolean'], 'boolean'),
      method('two', ['number', 'number']),
      method('three', ['number', 'boolean', 'number']),
      method('four', ['boolean', 'number', 'boolean', 'number']),
      method('five', Array(5).fill('number')),
      method('text', ['string']),
      method('later', ['number'], 'number', { async: true }),
      method('object', ['number'], 'number', { owner: 'Thing' }),
      method('optional', [], 'number', {
        params: [{ name: 'a', optional: true, type: { k: 'number' } }],
      }),
    ],
  };
  const glue = emitGlue(ir, { crate: 'test', moduleType: 'Test' });
  const scalars = glue.slice(glue.indexOf('scalars: &['), glue.indexOf('native_types: &['));
  assert.deepEqual(
    [...scalars.matchAll(/method: (\d+),/g)].map((m) => Number(m[1])),
    [0, 1, 2, 3, 4],
  );
  assert.match(
    scalars,
    /receiver\.four\(args\[0\] != 0.0, args\[1\], args\[2\] != 0.0, args\[3\]\)/,
  );
  assert.doesNotMatch(scalars, /Env|clone\(|from_js|into_js/);

  // The TS wrapper calls the prepared entry for exactly the same methods (one shared rule).
  const ts = emitTs(ir, { runtimeImport: '@rnrs/runtime', maxInFlight: 8 });
  assert.match(ts, /protocol: 3, direct: \[\[0, 0\], \[1, 1\], \[2, 2\], \[3, 3\], \[4, 4\]\]\}/);
  assert.match(ts, /zero\(\): void \{\n    this\.host\.m0\(\);/);
  assert.match(ts, /return this\.host\.m2\(a0, a1\) as number;/);
  assert.match(ts, /return this\.host\.m4\(a0, a1, a2, a3\) as number;/);
  assert.match(ts, /this\.host\.call\(5, undefined, \[/);
  assert.match(ts, /this\.host\.call1\(6, undefined, a0\)/);
  assert.match(ts, /this\.host\.start\(7, undefined/);
  assert.match(ts, /this\.host\.call1\(9, undefined, a\)/);
  // A module without scalar methods keeps protocol 2 (older runtimes still accept it).
  const plain = emitTs(
    { ...ir, methods: ir.methods.filter((m) => m.name === 'text') },
    { runtimeImport: '@rnrs/runtime', maxInFlight: 8 },
  );
  assert.match(plain, /protocol: 2\}/);
  assert.doesNotMatch(plain, /direct|host\.m\d/);
});

test('committed interfaces are up to date (rnrs-gen check)', async () => {
  assert.equal(await main(['check']), 0);
});

test('a stale committed interface fails check and build-outputs', async () => {
  const file = path.join(ROOT, 'packages/meter/rust/src/rnrs_interface.rs');
  const original = readFileSync(file, 'utf8');
  try {
    writeFileSync(file, original + '// edited by hand\n');
    assert.equal(await main(['check']), 1);
    assert.equal(await main(['build-outputs']), 1);
  } finally {
    writeFileSync(file, original);
  }
  assert.equal(await main(['check']), 0);
});

test('IR hash ignores positions but not types', () => {
  const { ir } = parseSpec(path.join(ROOT, 'packages/counter/counter.spec.ts'), {
    frameworkSpec: FRAMEWORK_SPEC,
    root: ROOT,
  });
  const moved = structuredClone(ir);
  moved.methods.forEach((m) => (m.line += 10));
  moved.spec = 'elsewhere.spec.ts';
  assert.equal(irHash(moved), ir.hash);
  const changed = structuredClone(ir);
  changed.methods[0].params[0].type = { k: 'string' };
  assert.notEqual(irHash(changed), ir.hash);
});

test('Counter IR: method order is the call index, NativeObject maps to an associated type', () => {
  const pkg = appPackages().find((p) => p.crate === 'counter');
  const { ir, diagnostics } = parseSpec(pkg.spec, { frameworkSpec: FRAMEWORK_SPEC, root: ROOT });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(
    ir.methods.map((m) => `${m.owner ?? ''}.${m.name}${m.async ? '!' : ''}`),
    ['.create', 'Counter.increment', 'Counter.add', 'Counter.value', 'Counter.addLater!'],
  );
  const iface = plan([pkg]).find((o) => o.committed).content;
  assert.match(
    iface,
    /pub trait CounterModule: NativeObject \+ Default \{\n    type CounterImpl: Counter;/,
  );
  assert.match(
    iface,
    /fn add_later\(&self, delta: f64, delay_ms: f64, uncancellable: bool, cancel: CancelToken\) -> impl Future<Output = Result<f64, String>> \+ MaybeSend;/,
  );
  assert.match(
    iface,
    /fn validate_add_later\(&self, _delta: &f64, _delay_ms: &f64, _uncancellable: &bool\) -> Result<\(\), String> \{\n        Ok\(\(\)\)/,
  );
});

test('bundles list modules per declared target', () => {
  const outputs = plan(appPackages());
  const android = outputs.find((o) => o.file.endsWith('bundle-android.rs')).content;
  assert.match(
    android,
    /MODULES: &\[&rnrs_core::bind::ModuleDef\] = &\[&counter::MODULE, &meter::MODULE, &values::MODULE, &rnrs_blake3::MODULE, &rnrs_http::MODULE, &rnrs_kv::MODULE, &rnrs_bench::MODULE\]/,
  );
});

test('bundle crates must depend on exactly the module crates of their target', async () => {
  const { checkBundleManifest } = await import('../cli.mjs');
  const { mkdtempSync, writeFileSync: write } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(path.join(tmpdir(), 'rnrs-manifest-'));
  const manifest = (deps) => {
    const file = path.join(dir, `Cargo-${Math.abs(deps.length)}-${deps.join('_')}.toml`);
    write(
      file,
      `[package]\nname = "b"\n\n[dependencies]\n${deps.map((d) => `${d} = { path = "x" }`).join('\n')}\nrnrs-core = "1"\n\n[build-dependencies]\nmeter = "1"\n`,
    );
    return file;
  };
  const packages = appPackages().map((p) => ({ ...p, crateIdent: p.crate.replace(/-/g, '_') }));
  assert.deepEqual(
    checkBundleManifest(
      manifest(['counter', 'meter', 'values', 'rnrs-blake3', 'rnrs-http', 'rnrs-kv', 'rnrs-bench']),
      'android',
      packages,
    ),
    [],
  );
  const missing = checkBundleManifest(
    manifest(['counter', 'values', 'rnrs-blake3', 'rnrs-http', 'rnrs-kv', 'rnrs-bench']),
    'android',
    packages,
  );
  assert.equal(missing.length, 1);
  assert.match(missing[0], /module crate meter .* is bundled for android but is not a dependency/);
  const fakeAndroidOnly = packages.map((p) =>
    p.crate === 'values' ? { ...p, targets: ['android'] } : p,
  );
  const extra = checkBundleManifest(
    manifest(['counter', 'meter', 'values', 'rnrs-blake3', 'rnrs-http', 'rnrs-kv', 'rnrs-bench']),
    'web',
    fakeAndroidOnly,
  );
  assert.match(
    extra.join('\n'),
    /module crate values does not declare target web \(targets android\); remove the dependency/,
  );
});

test('build-outputs writes one target bundle into the given directory only', async () => {
  const { mkdtempSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const out = mkdtempSync(path.join(tmpdir(), 'rnrs-out-'));
  assert.equal(await main(['build-outputs', '--target', 'web', '--out', out]), 0);
  assert.deepEqual(readdirSync(path.join(out, 'rnrs')).sort(), [
    'bundle-web.rs',
    'counter',
    'meter',
    'rnrs_bench',
    'rnrs_blake3',
    'rnrs_http',
    'values',
  ]);
});

test('concurrent generators never leave partial files', async () => {
  const { spawn } = await import('node:child_process');
  const cli = path.join(ROOT, 'tools/rnrs-gen/cli.mjs');
  const runs = Array.from(
    { length: 6 },
    () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, 'generate'], { cwd: ROOT, stdio: 'ignore' });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      }),
  );
  await Promise.all(runs);
  for (const o of plan(appPackages()))
    assert.equal(readFileSync(o.file, 'utf8'), o.content, o.file);
  const { readdirSync } = await import('node:fs');
  const leftovers = readdirSync(path.join(ROOT, '.generated/rnrs'), { recursive: true }).filter(
    (f) => String(f).includes('.tmp-'),
  );
  assert.deepEqual(leftovers, []);
});
