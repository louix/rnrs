// Consumer bundling: discovery from the app's dependency graph, target selection errors,
// and the generated per-app crate. Apps are built in a temp dir with node_modules entries
// that symlink to (or copy) the repository's module packages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from '../cli.mjs';
import { BundleError, discoverModules, generateBundle, selectModules } from '../bundle.mjs';

const json = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};
const link = (app, name, pkg) => {
  const dir = path.join(app, 'node_modules', name);
  mkdirSync(path.dirname(dir), { recursive: true });
  symlinkSync(path.join(ROOT, 'packages', pkg), dir);
};
/** A copy of packages/counter under another name, crate and target list. */
const counterCopy = (app, name, { targets, crate }) => {
  const dir = path.join(app, 'node_modules', name);
  cpSync(path.join(ROOT, 'packages/counter'), dir, {
    recursive: true,
    // Only exclude the package's generated wrapper, not an ancestor checkout named rnrs.
    filter: (src) =>
      path.relative(path.join(ROOT, 'packages/counter'), src).split(path.sep)[0] !== 'rnrs',
  });
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  manifest.name = name;
  manifest.rustNative.targets = targets;
  manifest.rustNative.rust.crate = crate;
  json(path.join(dir, 'package.json'), manifest);
};

function withApp(build, body) {
  const app = mkdtempSync(path.join(tmpdir(), 'rnrs-app-'));
  const cleanup = () => rmSync(app, { recursive: true, force: true });
  let result;
  try {
    build(app);
    result = body(app);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result instanceof Promise) return result.finally(cleanup);
  cleanup();
  return result;
}

test('discovery follows dependencies transitively, dedupes, and ignores dev/peer dependencies', () =>
  withApp(
    (app) => {
      json(path.join(app, 'package.json'), {
        name: 'app',
        dependencies: { wrapper: '1', '@rnrs/example-counter': '1' },
        devDependencies: { '@rnrs/labs-meter': '1' },
        peerDependencies: { '@rnrs/example-blake3': '1' },
      });
      link(app, '@rnrs/example-counter', 'counter');
      link(app, '@rnrs/labs-meter', 'meter');
      link(app, '@rnrs/example-blake3', 'blake3');
      link(app, '@rnrs/labs-values', 'values');
      json(path.join(app, 'node_modules/wrapper/package.json'), {
        name: 'wrapper',
        dependencies: { '@rnrs/labs-values': '1', '@rnrs/example-counter': '1' },
        optionalDependencies: { 'not-installed': '1' },
      });
    },
    (app) => {
      const found = discoverModules(app).map((m) => m.chain.join(' -> '));
      assert.deepEqual(found, [
        'app -> wrapper -> @rnrs/labs-values',
        'app -> wrapper -> @rnrs/example-counter',
      ]);
      const { crateDir, modules } = generateBundle(app, 'android', path.join(app, '.rnrs/android'));
      assert.deepEqual(modules.map((m) => m.crate).sort(), ['counter', 'values']);
      const cargo = readFileSync(path.join(crateDir, 'Cargo.toml'), 'utf8');
      assert.match(cargo, /^counter = \{ path = /m);
      assert.match(cargo, /^values = \{ path = /m);
      assert.doesNotMatch(cargo, /meter|blake3/);
      assert.match(cargo, /crate-type = \["staticlib"\]/);
      const lib = readFileSync(path.join(crateDir, 'src/lib.rs'), 'utf8');
      assert.match(
        lib,
        /static MODULES: &\[&rnrs_core::bind::ModuleDef\] = &\[&glue::values::MODULE, &glue::counter::MODULE\];/,
      );
      assert.match(lib, /rnrs_bundle_init/);
    },
  ));

test('a selected module without the requested target fails with its dependency chain', () =>
  withApp(
    (app) => {
      json(path.join(app, 'package.json'), { name: 'app', dependencies: { wrapper: '1' } });
      json(path.join(app, 'node_modules/wrapper/package.json'), {
        name: 'wrapper',
        dependencies: { 'android-only': '1' },
      });
      counterCopy(app, 'android-only', { targets: ['android'], crate: 'android_only' });
    },
    (app) => {
      assert.equal(selectModules(app, 'android').length, 1);
      assert.throws(
        () => selectModules(app, 'web'),
        (error) =>
          error instanceof BundleError &&
          /app -> wrapper -> android-only: android-only declares rustNative.targets \[android\] and cannot be bundled for web/.test(
            error.message,
          ),
      );
      assert.throws(
        () => selectModules(app, 'ios'),
        /app -> wrapper -> android-only: android-only declares rustNative.targets \[android\] and cannot be bundled for ios/,
      );
    },
  ));

test('a missing required dependency is an error; a missing optional one is skipped', () =>
  withApp(
    (app) => {
      json(path.join(app, 'package.json'), {
        name: 'app',
        dependencies: { absent: '1' },
        optionalDependencies: { 'also-absent': '1' },
      });
    },
    (app) => {
      assert.throws(
        () => discoverModules(app),
        /app -> absent: dependency absent is not installed/,
      );
      json(path.join(app, 'package.json'), {
        name: 'app',
        optionalDependencies: { 'also-absent': '1' },
      });
      assert.deepEqual(discoverModules(app), []);
    },
  ));

test('two packages with the same crate or module name are rejected', () =>
  withApp(
    (app) => {
      json(path.join(app, 'package.json'), {
        name: 'app',
        dependencies: { '@rnrs/example-counter': '1', 'copy-a': '1', 'copy-b': '1' },
      });
      link(app, '@rnrs/example-counter', 'counter');
      counterCopy(app, 'copy-a', { targets: ['android', 'web'], crate: 'counter' });
      counterCopy(app, 'copy-b', { targets: ['android', 'web'], crate: 'counter_b' });
    },
    (app) => {
      assert.throws(
        () => selectModules(app, 'android'),
        /two modules use the Rust crate name counter: app -> @rnrs\/example-counter and app -> copy-a/,
      );
      json(path.join(app, 'package.json'), {
        name: 'app',
        dependencies: { '@rnrs/example-counter': '1', 'copy-b': '1' },
      });
      assert.throws(
        () => generateBundle(app, 'android', path.join(app, '.rnrs/android')),
        /app -> copy-b: module name CounterModule is already used by app -> @rnrs\/example-counter/,
      );
    },
  ));

test('a module whose committed interface is stale is rejected', () =>
  withApp(
    (app) => {
      json(path.join(app, 'package.json'), { name: 'app', dependencies: { stale: '1' } });
      counterCopy(app, 'stale', { targets: ['android', 'web'], crate: 'stale' });
      const iface = path.join(app, 'node_modules/stale/rust/src/rnrs_interface.rs');
      writeFileSync(iface, readFileSync(iface, 'utf8') + '// edited\n');
    },
    (app) => {
      assert.throws(
        () => generateBundle(app, 'web', path.join(app, '.rnrs/web')),
        /app -> stale: rust\/src\/rnrs_interface.rs does not match its spec/,
      );
    },
  ));

test('ios packages generate, check and bundle as a native staticlib', async () => {
  const { main } = await import('../cli.mjs');
  for (const targets of [['ios'], ['android', 'ios']]) {
    await withApp(
      (app) => {
        json(path.join(app, 'package.json'), { name: 'app', dependencies: { 'ios-pkg': '1' } });
        counterCopy(app, 'ios-pkg', { targets, crate: 'ios_pkg' });
      },
      async (app) => {
        const dir = path.join(app, 'node_modules/ios-pkg');
        const log = console.log;
        console.log = () => {};
        try {
          for (const command of ['check', 'pack-js'])
            assert.equal(await main([command, dir]), 0, command);
        } finally {
          console.log = log;
        }
        const { crateDir } = generateBundle(app, 'ios', path.join(app, '.rnrs/ios'));
        const cargo = readFileSync(path.join(crateDir, 'Cargo.toml'), 'utf8');
        assert.match(cargo, /crate-type = \["staticlib"\]/);
        assert.match(cargo, /rnrs-core = \{ path = .*, features = \["tokio"\] \}/);
        assert.match(cargo, /^rnrs-android = \{ path = /m);
        assert.match(
          readFileSync(path.join(crateDir, 'src/lib.rs'), 'utf8'),
          /pub extern "C" fn rnrs_bundle_init\(\)/,
        );
        if (!targets.includes('android'))
          assert.throws(
            () => selectModules(app, 'android'),
            /app -> ios-pkg: ios-pkg declares rustNative.targets \[ios\] and cannot be bundled for android/,
          );
      },
    );
  }
});

test('a declared but unimplemented known target fails with an actionable error', async () => {
  const { implementedTargets } = await import('../targets.mjs');
  const manifest = { name: 'pkg', rustNative: { targets: ['android', 'ios'] } };
  assert.deepEqual(implementedTargets(manifest), ['android', 'ios']);
  assert.throws(
    () => implementedTargets(manifest, 'package.json', ['android', 'web']),
    /pkg: rustNative.targets in package.json declares "ios", which rnrs does not implement yet \(implemented: android, web\)/,
  );
});

test('iOS SDK/architecture selection and the cargo environment', async () => {
  const { iosTriples, iosCargoEnv } = await import('../bundle.mjs');
  assert.deepEqual(iosTriples('iphoneos', ['arm64']), ['aarch64-apple-ios']);
  assert.deepEqual(iosTriples('iphonesimulator', ['arm64', 'x86_64']), [
    'aarch64-apple-ios-sim',
    'x86_64-apple-ios',
  ]);
  assert.throws(
    () => iosTriples('iphoneos', ['armv7']),
    /unsupported architecture "armv7" for iphoneos/,
  );
  assert.throws(() => iosTriples('macosx', ['arm64']), /unsupported iOS SDK "macosx"/);
  const xcode = '/Applications/Xcode.app/Contents/Developer';
  const env = iosCargoEnv({
    SDKROOT: '/sdk/iPhoneOS.sdk',
    DEVELOPER_DIR: xcode,
    PLATFORM_NAME: 'iphoneos',
    ARCHS: 'arm64',
    RUSTUP_TOOLCHAIN: '1.90.0',
    PATH: `${xcode}/Toolchains/XcodeDefault.xctoolchain/usr/bin:${xcode}/usr/bin:/nix/bin:/usr/bin`,
  });
  assert.equal(env.SDKROOT, undefined);
  assert.equal(env.PLATFORM_NAME, undefined);
  assert.equal(env.ARCHS, undefined);
  assert.equal(env.RUSTUP_TOOLCHAIN, '1.90.0');
  assert.equal(env.DEVELOPER_DIR, xcode);
  assert.equal(env.PATH, '/nix/bin:/usr/bin');
  assert.equal(env.IPHONEOS_DEPLOYMENT_TARGET, '15.1');
  assert.equal(
    iosCargoEnv({ IPHONEOS_DEPLOYMENT_TARGET: '16.0' }).IPHONEOS_DEPLOYMENT_TARGET,
    '16.0',
  );
});

test('framework crates resolved from anywhere but the framework copy are rejected', async () => {
  const { checkProvenance } = await import('../bundle.mjs');
  const registry = {
    name: 'rnrs-core',
    version: '0.1.9',
    source: 'registry+https://github.com/rust-lang/crates.io-index',
    manifest_path: '/elsewhere/Cargo.toml',
  };
  assert.throws(
    () => checkProvenance({ packages: [registry] }),
    /rnrs-core 0\.1\.9 resolved from registry\+https:\/\/github.com\/rust-lang\/crates.io-index, not the framework's/,
  );
  assert.doesNotThrow(() =>
    checkProvenance({
      packages: [{ name: 'blake3', version: '1.8.7', source: 'registry+x', manifest_path: '/x' }],
    }),
  );
});

test('module crates must require an rnrs-core version the framework provides', async () => {
  const { checkCoreRequirement } = await import('../cli.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'rnrs-core-req-'));
  const pkg = { cratePath: dir };
  const with_ = (line) =>
    writeFileSync(
      path.join(dir, 'Cargo.toml'),
      `[package]\nname = "m"\nversion = "0.1.0"\n\n[dependencies]\n${line}\n`,
    );
  try {
    for (const ok of [
      'rnrs-core = "0.1"',
      'rnrs-core = "^0.1.0"',
      'rnrs-core = { version = "0.1", features = ["tokio"] }',
      'rnrs-core = { path = "../core" }',
    ]) {
      with_(ok);
      assert.doesNotThrow(() => checkCoreRequirement(pkg), ok);
    }
    for (const bad of [
      'rnrs-core = "0.2"',
      'rnrs-core = "1"',
      'rnrs-core = "0.1.7"',
      'rnrs-core = ">=0.1"',
      'rnrs-core = "*"',
    ]) {
      with_(bad);
      assert.throws(
        () => checkCoreRequirement(pkg),
        /is not satisfied by this framework's rnrs-core 0\.1\.0/,
        bad,
      );
    }
    with_('serde = "1"');
    assert.throws(
      () => checkCoreRequirement(pkg),
      /must depend on the framework: add rnrs = "0\.1" to \[dependencies\]/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI run directly (not through bin/rnrs.mjs) completes consumer commands', async () => {
  const { spawnSync } = await import('node:child_process');
  await withApp(
    (app) => {
      json(path.join(app, 'package.json'), {
        name: 'app',
        dependencies: { '@rnrs/example-counter': '1' },
      });
      link(app, '@rnrs/example-counter', 'counter');
    },
    (app) => {
      const run = spawnSync(
        'node',
        [path.join(ROOT, 'tools/rnrs-gen/cli.mjs'), 'bundle', '--target', 'web', '--app', app],
        { encoding: 'utf8', timeout: 30_000 },
      );
      assert.equal(run.status, 0, run.stderr);
      assert.match(
        run.stdout,
        /rnrs: web bundle with 1 module\(s\): CounterModule \(app -> @rnrs\/example-counter\)/,
      );
    },
  );
});

/** A Rust library package (rustNative.library): a crate other module crates depend on. */
const libraryPackage = (app, name, { targets, crate, extra = {} }) => {
  const dir = path.join(app, 'node_modules', name);
  json(path.join(dir, 'package.json'), {
    name,
    rustNative: { targets, library: { crate, path: 'rust' }, ...extra },
  });
  mkdirSync(path.join(dir, 'rust/src'), { recursive: true });
  writeFileSync(
    path.join(dir, 'rust/Cargo.toml'),
    `[package]\nname = "${crate}"\nversion = "0.1.0"\nedition = "2021"\n`,
  );
  writeFileSync(path.join(dir, 'rust/src/lib.rs'), '');
  return dir;
};

test('library packages are selected and target-checked, patched by crate name, and register no module', () =>
  withApp(
    (app) => {
      json(path.join(app, 'package.json'), {
        name: 'app',
        dependencies: { '@rnrs/example-counter': '1', renderer: '1' },
      });
      link(app, '@rnrs/example-counter', 'counter');
      json(path.join(app, 'node_modules/renderer/package.json'), {
        name: 'renderer',
        dependencies: { '@rnrs/surface-test': '1' },
      });
      libraryPackage(app, '@rnrs/surface-test', {
        targets: ['android'],
        crate: 'rnrs-surface-test',
      });
    },
    (app) => {
      const { crateDir, modules, libraries } = generateBundle(
        app,
        'android',
        path.join(app, '.rnrs/android'),
      );
      assert.deepEqual(
        modules.map((m) => m.crate),
        ['counter'],
      );
      assert.deepEqual(
        libraries.map((l) => l.chain.join(' -> ')),
        ['app -> renderer -> @rnrs/surface-test'],
      );
      const cargo = readFileSync(path.join(crateDir, 'Cargo.toml'), 'utf8');
      const patch = cargo.slice(cargo.indexOf('[patch.crates-io]'));
      assert.match(
        patch,
        /^rnrs-surface-test = \{ path = ".*\/node_modules\/@rnrs\/surface-test\/rust" \}$/m,
      );
      // Not a dependency of the bundle itself: only module crates that use it pull it in.
      assert.doesNotMatch(cargo.slice(0, cargo.indexOf('[patch.crates-io]')), /rnrs-surface-test/);
      const lib = readFileSync(path.join(crateDir, 'src/lib.rs'), 'utf8');
      assert.match(
        lib,
        /^\/\/ Library crates: rnrs-surface-test \(app -> renderer -> @rnrs\/surface-test\)$/m,
      );
      assert.match(
        lib,
        /static MODULES: &\[&rnrs_core::bind::ModuleDef\] = &\[&glue::counter::MODULE\];/,
      );
      assert.throws(
        () => selectModules(app, 'web'),
        /app -> renderer -> @rnrs\/surface-test: surface-test declares rustNative.targets \[android\] and cannot be bundled for web/,
      );
    },
  ));

test('library packages declare only targets and library, and are refused by module commands', async () => {
  const { loadPackage, main } = await import('../cli.mjs');
  await withApp(
    (app) => {
      libraryPackage(app, 'lib-ok', { targets: ['android'], crate: 'lib-ok' });
      libraryPackage(app, 'lib-bad', {
        targets: ['android'],
        crate: 'lib-bad',
        extra: { spec: 'x.spec.ts' },
      });
    },
    async (app) => {
      const ok = loadPackage(path.join(app, 'node_modules/lib-ok'));
      assert.equal(ok.library, true);
      assert.equal(ok.crate, 'lib-ok');
      assert.throws(
        () => loadPackage(path.join(app, 'node_modules/lib-bad')),
        /rustNative.library cannot be combined with spec/,
      );
      const errors = [];
      const original = console.error;
      console.error = (message) => errors.push(String(message));
      try {
        assert.equal(await main(['pack-js', path.join(app, 'node_modules/lib-ok')]), 1);
      } finally {
        console.error = original;
      }
      assert.match(
        errors.join('\n'),
        /rnrs pack-js applies to module packages; this is a Rust library package/,
      );
    },
  );
});

test('library crates resolved from anywhere but the installed package are rejected', async () => {
  const { checkProvenance } = await import('../bundle.mjs');
  const lib = {
    crate: 'rnrs-surface',
    cratePath: path.join(ROOT, 'packages/surface/rust'),
    chain: ['app', '@rnrs/surface'],
  };
  const registry = {
    name: 'rnrs-surface',
    version: '0.1.3',
    source: 'registry+https://github.com/rust-lang/crates.io-index',
    manifest_path: '/elsewhere/Cargo.toml',
  };
  assert.throws(
    () => checkProvenance({ packages: [registry] }, [lib]),
    /rnrs-surface 0\.1\.3 resolved from registry\+.*, not the installed library package app -> @rnrs\/surface/,
  );
  // Without the library package installed it is still refused: rnrs-* is a reserved namespace.
  assert.throws(
    () => checkProvenance({ packages: [registry] }),
    /Crates named rnrs-\* \(and the former rnr-\* names\) are reserved for the framework/,
  );
});

test('web surface is a direct bundle dependency and retained export; headless/native bundles omit the hook', () => {
  for (const [target, surface] of [
    ['web', true],
    ['web', false],
    ['android', true],
  ]) {
    withApp(
      (app) => {
        json(path.join(app, 'package.json'), {
          name: 'app',
          dependencies: {
            '@rnrs/example-counter': '1',
            ...(surface ? { '@rnrs/surface': '1' } : {}),
          },
        });
        link(app, '@rnrs/example-counter', 'counter');
        if (surface) link(app, '@rnrs/surface', 'surface');
      },
      (app) => {
        const { crateDir } = generateBundle(app, target, path.join(app, '.rnrs', target));
        const cargo = readFileSync(path.join(crateDir, 'Cargo.toml'), 'utf8');
        const direct = cargo.split('[patch.crates-io]')[0];
        const lib = readFileSync(path.join(crateDir, 'src/lib.rs'), 'utf8');
        if (target === 'web' && surface) {
          assert.match(direct, /^rnrs-surface = \{ path = /m);
          assert.match(lib, /rnrs_surface::web_exports::keep_exports\(\)/);
        } else {
          assert.doesNotMatch(direct, /^rnrs-surface = /m);
          assert.doesNotMatch(lib, /keep_exports/);
        }
      },
    );
  }
});
