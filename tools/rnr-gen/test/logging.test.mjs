// App-level Rust logging configuration (rustNativeApp.logging): validation, what the generated
// bundle contains in each mode, log-always detection, and a real cargo check showing that an
// invalid filter fails the bundle build (offline; skipped when cargo is unavailable).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ROOT} from '../cli.mjs';
import {appLogging, generateBundle, logAlwaysEnablers} from '../bundle.mjs';

const json = (file, value) => { mkdirSync(path.dirname(file), {recursive: true}); writeFileSync(file, JSON.stringify(value, null, 2)); };

function app(logging) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rnr-logging-'));
  json(path.join(dir, 'package.json'), {name: 'app', dependencies: {'@rnrs/example-counter': '1'}, ...(logging === undefined ? {} : {rustNativeApp: {logging}})});
  mkdirSync(path.join(dir, 'node_modules/@rnrs'), {recursive: true});
  symlinkSync(path.join(ROOT, 'packages/counter'), path.join(dir, 'node_modules/@rnrs/example-counter'));
  return dir;
}

function withApp(logging, body) {
  const dir = app(logging);
  try {
    return body(dir);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

test('logging config: default off, managed defaults, external, and actionable errors', () => {
  withApp(undefined, dir => assert.equal(appLogging(dir), null));
  withApp({}, dir => assert.deepEqual(appLogging(dir), {mode: 'managed', filter: 'info', iosPrivacy: 'private'}));
  withApp({filter: 'warn,app=debug', iosPrivacy: 'public'}, dir => assert.deepEqual(appLogging(dir), {mode: 'managed', filter: 'warn,app=debug', iosPrivacy: 'public'}));
  withApp({mode: 'external'}, dir => assert.deepEqual(appLogging(dir), {mode: 'external'}));
  const cases = [
    ['info', /must be an object/],
    [{mode: 'auto'}, /"mode" must be "managed" \(default\) or "external"/],
    [{mode: 'external', filter: 'info'}, /filter cannot be used with "mode": "external"/],
    [{level: 'info'}, /unknown key\(s\) level/],
    [{filter: 'info"); evil(); ("'}, /printable ASCII without quotes or backslashes/],
    [{filter: 'info\n'}, /printable ASCII/],
    [{iosPrivacy: 'secret'}, /"iosPrivacy" must be "private" \(default\) or "public"/],
  ];
  for (const [logging, error] of cases) withApp(logging, dir => assert.throws(() => appLogging(dir), error, JSON.stringify(logging)));
});

test('generated bundles: nothing for default off; rnr-log, build check and install for managed; link only for external', () => {
  for (const target of ['android', 'ios', 'web']) {
    withApp(undefined, dir => {
      const {crateDir} = generateBundle(dir, target, path.join(dir, '.rnr', target));
      const cargo = readFileSync(path.join(crateDir, 'Cargo.toml'), 'utf8');
      assert.doesNotMatch(cargo, /rnr-log|build-dependencies/);
      assert.equal(existsSync(path.join(crateDir, 'build.rs')), false);
      assert.doesNotMatch(readFileSync(path.join(crateDir, 'src/lib.rs'), 'utf8'), /rnr_log/);
    });
    withApp({filter: 'info,sled=warn', iosPrivacy: 'public'}, dir => {
      const {crateDir} = generateBundle(dir, target, path.join(dir, '.rnr', target));
      const cargo = readFileSync(path.join(crateDir, 'Cargo.toml'), 'utf8');
      assert.match(cargo, /^rnr-log = \{ path = ".*rust\/rnr-log" \}$/m);
      assert.match(cargo, /\[build-dependencies\]\ntracing-subscriber = \{ version = "0.3", default-features = false, features = \["registry", "std"\] \}/);
      assert.match(readFileSync(path.join(crateDir, 'build.rs'), 'utf8'), /let filter = "info,sled=warn";\n\s+if let Err\(error\) = filter.parse::<tracing_subscriber::filter::Targets>\(\)/);
      const lib = readFileSync(path.join(crateDir, 'src/lib.rs'), 'utf8');
      // Installed before the modules are registered, so before any module code runs.
      assert.match(lib, /rnr_log::install_for_bundle\("info,sled=warn", rnr_log::Privacy::Public\);\n\s+rnr_(android|web)::register\(MODULES\);/);
    });
    withApp({mode: 'external'}, dir => {
      const {crateDir} = generateBundle(dir, target, path.join(dir, '.rnr', target));
      assert.match(readFileSync(path.join(crateDir, 'Cargo.toml'), 'utf8'), /^rnr-log = /m);
      assert.equal(existsSync(path.join(crateDir, 'build.rs')), false);
      assert.doesNotMatch(readFileSync(path.join(crateDir, 'src/lib.rs'), 'utf8'), /install_for_bundle/);
    });
  }
  // Turning logging off again removes the generated build script.
  withApp({}, dir => {
    const out = path.join(dir, '.rnr/android');
    generateBundle(dir, 'android', out);
    assert.equal(existsSync(path.join(out, 'bundle/build.rs')), true);
    json(path.join(dir, 'package.json'), {name: 'app', dependencies: {'@rnrs/example-counter': '1'}});
    generateBundle(dir, 'android', out);
    assert.equal(existsSync(path.join(out, 'bundle/build.rs')), false);
  });
});

test('log-always detection names the dependency that enables it', () => {
  const pkg = (name, extra = {}) => ({id: `${name}-id`, name, version: '1.0.0', dependencies: [], features: {}, ...extra});
  const metadata = (tracingFeatures, packages, nodeFeatures = {}) => ({
    packages: [pkg('tracing'), ...packages],
    resolve: {nodes: [{id: 'tracing-id', features: tracingFeatures}, ...packages.map(p => ({id: p.id, features: nodeFeatures[p.name] ?? []}))]},
  });
  assert.equal(logAlwaysEnablers(metadata(['std', 'log'], [pkg('a')])), null);
  assert.deepEqual(logAlwaysEnablers(metadata(['log', 'log-always'], [pkg('noisy', {dependencies: [{name: 'tracing', features: ['log-always']}]}), pkg('quiet')])), ['noisy 1.0.0']);
  assert.deepEqual(logAlwaysEnablers(metadata(['log-always'], [pkg('lib', {features: {compat: ['tracing/log-always']}})], {lib: ['compat']})), ['lib 1.0.0 (its feature compat)']);
  assert.deepEqual(logAlwaysEnablers(metadata(['log-always'], [pkg('x')])), ['(not attributable to a dependency declaration)']);
});

const local = path.join(ROOT, '.generated');
if (!process.env.CARGO_HOME && existsSync(path.join(local, 'cargo'))) {
  process.env.CARGO_HOME = path.join(local, 'cargo');
  process.env.RUSTUP_HOME ??= path.join(local, 'rustup');
  process.env.RUSTUP_TOOLCHAIN ??= '1.90.0';
}
const cargo = process.env.RNR_CARGO ?? 'cargo';
const skip = spawnSync(cargo, ['--version']).status === 0 ? false : 'cargo is not available';

test('an invalid filter fails the bundle build in its build script; a valid one builds', {skip}, () => {
  for (const [filter, ok] of [['info,app=loud', false], ['info,sled=warn', true]]) {
    withApp({filter}, dir => {
      const {crateDir} = generateBundle(dir, 'android', path.join(dir, '.rnr/android'));
      // The root workspace lock pins the same dependency versions; cargo stays offline.
      writeFileSync(path.join(crateDir, 'Cargo.lock'), readFileSync(path.join(ROOT, 'Cargo.lock'), 'utf8'));
      const result = spawnSync(cargo, ['check', '--offline', '--manifest-path', path.join(crateDir, 'Cargo.toml'), '--target-dir', path.join(local, 'logging-test-target')], {encoding: 'utf8'});
      if (ok) assert.equal(result.status, 0, result.stderr.slice(-2000));
      else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /rustNativeApp\.logging\.filter "info,app=loud" in the app's package\.json is not a valid tracing Targets filter/);
      }
    });
  }
});
