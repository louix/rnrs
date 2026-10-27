// Rust library packages (rustNative.library): manifest schema, reserved names, Cargo package
// name agreement, refusal by module commands, and real cargo resolution (offline, from the
// local registry cache; nothing is compiled) of a module crate that depends on a library by
// version. Cargo tests are skipped when cargo is unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT, loadPackage, main } from '../cli.mjs';
import { BundleError, lockBundle, lockFile, selectModules } from '../bundle.mjs';

const local = path.join(ROOT, '.generated');
if (!process.env.CARGO_HOME && existsSync(path.join(local, 'cargo'))) {
  process.env.CARGO_HOME = path.join(local, 'cargo');
  process.env.RUSTUP_HOME ??= path.join(local, 'rustup');
  process.env.RUSTUP_TOOLCHAIN ??= '1.90.0';
}
const skip =
  spawnSync(process.env.RNRS_CARGO ?? 'cargo', ['--version']).status === 0
    ? false
    : 'cargo is not available';

const json = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};

/** node_modules/<name>: a library package whose crate is `crate` at `version`. */
function library(app, name, { crate, version = '0.4.0', cargoName = crate, rustNative }) {
  const dir = path.join(app, 'node_modules', name);
  json(path.join(dir, 'package.json'), {
    name,
    version: '0.4.0',
    rustNative: rustNative ?? { targets: ['android', 'web'], library: { crate, path: 'rust' } },
  });
  mkdirSync(path.join(dir, 'rust/src'), { recursive: true });
  writeFileSync(
    path.join(dir, 'rust/Cargo.toml'),
    `[package]\nname = "${cargoName}"\nversion = "${version}"\nedition = "2021"\n\n[dependencies]\n`,
  );
  writeFileSync(path.join(dir, 'rust/src/lib.rs'), '');
  return dir;
}

/** node_modules/<name>: a copy of packages/counter whose crate also requires `requirement`. */
function moduleUsing(app, name, { crate, requirement, dependsOn }) {
  const dir = path.join(app, 'node_modules', name);
  cpSync(path.join(ROOT, 'packages/counter'), dir, {
    recursive: true,
    // Only exclude the package's generated wrapper, not an ancestor checkout named rnrs.
    filter: (src) =>
      path.relative(path.join(ROOT, 'packages/counter'), src).split(path.sep)[0] !== 'rnrs',
  });
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  manifest.name = name;
  manifest.rustNative.rust.crate = crate;
  manifest.rustNative.targets = ['android', 'web'];
  manifest.dependencies = dependsOn;
  json(path.join(dir, 'package.json'), manifest);
  const toml = path.join(dir, 'rust/Cargo.toml');
  writeFileSync(
    toml,
    readFileSync(toml, 'utf8')
      .replace(/^name = "[^"]+"/m, `name = "${crate}"`)
      .replace(/^\[dependencies\]\n/m, `[dependencies]\n${requirement}\n`),
  );
  return dir;
}

function withApp(build, body) {
  const app = mkdtempSync(path.join(tmpdir(), 'rnrs-lib-'));
  try {
    build(app);
    return body(app);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}

async function cliErrors(argv) {
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    return { status: await main(argv), errors: errors.join('\n') };
  } finally {
    console.error = original;
  }
}

test('library manifests: schema, reserved names, Cargo package name and path containment', () =>
  withApp(
    (app) => {
      library(app, 'ok', { crate: 'lib-ok' });
      library(app, 'reserved', { crate: 'rnrs-core' });
      library(app, 'reserved-underscore', { crate: 'rnrs_log' });
      library(app, 'mismatch', { crate: 'lib-a', cargoName: 'lib-b' });
      library(app, 'unknown-key', {
        crate: 'lib-u',
        rustNative: {
          targets: ['android'],
          library: { crate: 'lib-u', path: 'rust', features: [] },
        },
      });
      library(app, 'not-object', {
        crate: 'lib-n',
        rustNative: { targets: ['android'], library: 'rust' },
      });
      library(app, 'escape', {
        crate: 'lib-e',
        rustNative: { targets: ['android'], library: { crate: 'lib-e', path: '../ok/rust' } },
      });
    },
    (app) => {
      const dir = (name) => path.join(app, 'node_modules', name);
      assert.equal(loadPackage(dir('ok')).crate, 'lib-ok');
      assert.throws(
        () => loadPackage(dir('reserved')),
        /rustNative.library.crate rnrs-core is reserved for the framework/,
      );
      assert.throws(
        () => loadPackage(dir('reserved-underscore')),
        /rnrs_log is reserved for the framework/,
      );
      assert.throws(
        () => loadPackage(dir('mismatch')),
        /rustNative.library.crate is lib-a, but rust\/Cargo.toml declares package lib-b/,
      );
      assert.throws(
        () => loadPackage(dir('unknown-key')),
        /rustNative.library: unknown key\(s\) features; allowed: crate, path/,
      );
      assert.throws(() => loadPackage(dir('not-object')), /rustNative.library must be an object/);
      assert.throws(
        () => loadPackage(dir('escape')),
        /rustNative.library.path must stay inside the package/,
      );
    },
  ));

test('a module crate may not use a framework crate name either', () =>
  withApp(
    (app) => {
      json(path.join(app, 'package.json'), { name: 'app', dependencies: { 'fake-log': '1' } });
      moduleUsing(app, 'fake-log', { crate: 'rnrs-log', requirement: '', dependsOn: {} });
    },
    (app) => {
      assert.throws(
        () => selectModules(app, 'android'),
        (error) =>
          error instanceof BundleError &&
          /app -> fake-log: the Rust crate name rnrs-log is reserved for the framework/.test(
            error.message,
          ),
      );
    },
  ));

test('generate, check and pack-js refuse library packages', async () => {
  const app = mkdtempSync(path.join(tmpdir(), 'rnrs-lib-'));
  try {
    const dir = library(app, 'lib-cli', { crate: 'lib-cli' });
    for (const command of ['generate', 'check', 'pack-js']) {
      const { status, errors } = await cliErrors([command, dir]);
      assert.equal(status, 1, command);
      assert.match(
        errors,
        new RegExp(`rnrs ${command} applies to module packages; this is a Rust library package`),
      );
    }
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test(
  'a module crate depending on a library by version resolves to the installed package, also after relocation',
  { skip },
  () => {
    const app = mkdtempSync(path.join(tmpdir(), 'rnrs-lib-'));
    const moved = mkdtempSync(path.join(tmpdir(), 'rnrs-lib-moved-'));
    try {
      json(path.join(app, 'package.json'), { name: 'app', dependencies: { 'uses-lib': '1' } });
      moduleUsing(app, 'uses-lib', {
        crate: 'uses_lib',
        requirement: 'shared-lib = "0.4"',
        dependsOn: { '@scope/shared-lib': '1' },
      });
      library(app, '@scope/shared-lib', { crate: 'shared-lib', version: '0.4.4' });
      const opts = (dir) => ({ out: path.join(dir, '.rnrs/web'), offline: true });
      const result = lockBundle(app, 'web', opts(app));
      assert.deepEqual(
        result.modules.map((m) => m.crate),
        ['uses_lib'],
      );
      const lock = readFileSync(lockFile(app, 'web'), 'utf8');
      // Resolved once, from the path (no registry source), at the installed version.
      const entries = [
        ...lock.matchAll(
          /\[\[package\]\]\nname = "shared-lib"\nversion = "([^"]+)"(\nsource = [^\n]+)?/g,
        ),
      ];
      assert.equal(entries.length, 1);
      assert.equal(entries[0][1], '0.4.4');
      assert.equal(entries[0][2], undefined, 'no registry source');
      for (const p of [app, ROOT, tmpdir()]) assert.ok(!lock.includes(p), `lock mentions ${p}`);
      // A relocated app (another absolute path) checks against the same lock unchanged.
      cpSync(app, moved, { recursive: true, filter: (src) => !src.includes(`${path.sep}.rnrs`) });
      assert.doesNotThrow(() => lockBundle(moved, 'web', { ...opts(moved), check: true }));
      assert.equal(readFileSync(lockFile(moved, 'web'), 'utf8'), lock);
      // The installed library changes to an incompatible version: the committed lock is stale,
      // and fresh resolution cannot satisfy "0.4" from the package (offline: no registry
      // fallback; online, provenance would refuse a crates.io crate of that name).
      library(moved, '@scope/shared-lib', { crate: 'shared-lib', version: '0.5.0' });
      assert.throws(
        () => lockBundle(moved, 'web', { ...opts(moved), check: true }),
        /does not match the app's Rust dependencies/,
      );
      rmSync(lockFile(moved, 'web'));
      assert.throws(
        () => lockBundle(moved, 'web', opts(moved)),
        /cargo could not resolve the bundle's dependencies/,
      );
    } finally {
      rmSync(app, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
    }
  },
);

test(
  'packed @rnrs/surface and @rnrs/example-vello2d tarballs: the library must be a direct app dependency, and then resolves from the installed package',
  { skip },
  () => {
    const work = mkdtempSync(path.join(tmpdir(), 'rnrs-lib-pack-'));
    try {
      const app = path.join(work, 'app');
      mkdirSync(app);
      // npm pack only (no pack-js): the bundle needs the manifest, spec, crate and committed interface.
      const pack = (dir) =>
        JSON.parse(
          spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], {
            cwd: dir,
            encoding: 'utf8',
          }).stdout,
        )[0].filename;
      const surface = pack(path.join(ROOT, 'packages/surface'));
      const vello = pack(path.join(ROOT, 'packages/vello2d'));
      const extract = (tgz, name) => {
        const dir = path.join(app, 'node_modules', name);
        mkdirSync(dir, { recursive: true });
        assert.equal(
          spawnSync('tar', ['-xzf', path.join(work, tgz), '-C', dir, '--strip-components=1'])
            .status,
          0,
        );
      };
      extract(surface, '@rnrs/surface');
      extract(vello, '@rnrs/example-vello2d');
      // Only transitive (through vello2d): Cargo could resolve it, but autolinking would not
      // link its view manager and codegen component.
      json(path.join(app, 'package.json'), {
        name: 'app',
        dependencies: { '@rnrs/example-vello2d': '0.4.0' },
      });
      assert.throws(
        () => selectModules(app, 'android'),
        /app -> @rnrs\/example-vello2d -> @rnrs\/surface: @rnrs\/surface contains native platform code, which React Native autolinking links only for the app's direct dependencies; add @rnrs\/surface/,
      );
      json(path.join(app, 'package.json'), {
        name: 'app',
        dependencies: { '@rnrs/example-vello2d': '0.4.0', '@rnrs/surface': '0.4.0' },
      });
      const result = lockBundle(app, 'android', {
        out: path.join(app, '.rnrs/android'),
        offline: true,
      });
      assert.deepEqual(
        result.modules.map((m) => m.crate),
        ['rnrs-vello2d'],
      );
      const lock = readFileSync(lockFile(app, 'android'), 'utf8');
      const entry = lock.match(
        /\[\[package\]\]\nname = "rnrs-surface"\nversion = "([^"]+)"(\nsource = [^\n]+)?/,
      );
      assert.ok(entry, 'rnrs-surface resolved');
      assert.equal(entry[2], undefined, 'from the installed package path, not a registry');
      assert.ok(!lock.includes(work), 'no machine paths');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

test('a module crate needing an rnrs-* library that no installed package provides is refused before cargo runs', () =>
  withApp(
    (app) => {
      json(path.join(app, 'package.json'), { name: 'app', dependencies: { renderer: '1' } });
      moduleUsing(app, 'renderer', {
        crate: 'renderer_mod',
        requirement: 'rnrs-surface = "0.4"',
        dependsOn: {},
      });
    },
    (app) => {
      assert.throws(
        () => selectModules(app, 'android'),
        (error) =>
          error instanceof BundleError &&
          /app -> renderer: its crate depends on rnrs-surface, which no installed package provides \(rnrs-\* and rnr-\* crates are never taken from crates.io\); add @rnrs\/surface to the app's dependencies/.test(
            error.message,
          ),
      );
    },
  ));

test('rnrs-* and former rnr-* crates resolved from a registry or git are refused even if no package declared them', async () => {
  const { checkProvenance } = await import('../bundle.mjs');
  for (const source of [
    'registry+https://github.com/rust-lang/crates.io-index',
    'git+https://example.invalid/x#abc',
  ]) {
    const foreign = (name) => ({
      name,
      version: '0.4.0',
      source,
      manifest_path: '/elsewhere/Cargo.toml',
    });
    // Framework crates: compared with this framework's copies.
    for (const name of ['rnrs', 'rnrs-core', 'rnrs-android', 'rnrs-web', 'rnrs-log'])
      assert.throws(
        () => checkProvenance({ packages: [foreign(name)] }),
        new RegExp(`\\b${name} 0\\.4\\.0 resolved from .*, not the framework's`),
      );
    // Anything else in the namespace, current or former, declared by a package or not.
    for (const name of [
      'rnrs-surface',
      'rnrs-unknown',
      'rnrs_unknown',
      'rnr-core',
      'rnr-surface',
      'rnr_log',
    ])
      assert.throws(
        () => checkProvenance({ packages: [foreign(name)] }),
        new RegExp(
          `\\b${name} 0\\.4\\.0 resolved from .*\\nCrates named rnrs-\\* \\(and the former rnr-\\* names\\) are reserved for the framework`,
        ),
      );
  }
  for (const name of ['rnrx', 'rnrsx', 'xrnrs-core'])
    assert.doesNotThrow(() =>
      checkProvenance({
        packages: [{ name, version: '1.0.0', source: 'registry+x', manifest_path: '/x' }],
      }),
    );
});

test('a module crate depending on a former rnr-* framework name is refused with the new name', () =>
  withApp(
    (app) => {
      json(path.join(app, 'package.json'), { name: 'app', dependencies: { old: '1' } });
      moduleUsing(app, 'old', {
        crate: 'old_mod',
        requirement: 'rnr-surface = "0.4"',
        dependsOn: {},
      });
    },
    (app) => {
      assert.throws(
        () => selectModules(app, 'android'),
        (error) =>
          error instanceof BundleError &&
          /app -> old: its crate depends on rnr-surface, which no installed package provides \(rnrs-\* and rnr-\* crates are never taken from crates.io\); rnr-surface was renamed rnrs-surface/.test(
            error.message,
          ),
      );
    },
  ));

test('rnrs-* and rnr-* dependency scanning covers dependency tables, renames and target tables, not dev-dependencies', async () => {
  const { rnrsCrateDependencies } = await import('../bundle.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'rnrs-deps-'));
  try {
    const file = path.join(dir, 'Cargo.toml');
    writeFileSync(
      file,
      [
        '[package]',
        'name = "x"',
        '',
        '[dependencies]',
        'rnrs-core = "0.4"',
        'surface = { package = "rnrs-surface", version = "0.4" }',
        'serde = "1"',
        '',
        '[target.\'cfg(target_os = "android")\'.dependencies]',
        'rnr_extra = "0.4"',
        'rnrs_other = "0.4"',
        '',
        '[dependencies.rnr-table]',
        'version = "0.4"',
        '',
        '[dev-dependencies]',
        'rnr-test-only = "0.4"',
        '',
        '[build-dependencies]',
        'rnrs-build = "0.4"',
      ].join('\n'),
    );
    assert.deepEqual(rnrsCrateDependencies(file).sort(), [
      'rnr-table',
      'rnr_extra',
      'rnrs-build',
      'rnrs-core',
      'rnrs-surface',
      'rnrs_other',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
