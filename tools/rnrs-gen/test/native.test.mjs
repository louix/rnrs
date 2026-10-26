// Binary-first linking (`rnrs link`, Node only): source/prebuilt selection, the checks on each
// prebuilt manifest (ABI, symbol, spec, shipped Rust sources, ABIs, minSdk) and the generated
// registry and CMake list. Module packages are copies of packages/{counter,meter} with a fake
// manifest and archive (no Rust is built here; the ABI constants are compared with the C++ and
// Rust sources).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from '../cli.mjs';
import { NATIVE_ABI, tableSymbol } from '../bundle.mjs';
import {
  ANDROID_ABIS,
  MANIFEST,
  checkPackageBinaries,
  invalidateTarget,
  linkModules,
} from '../native.mjs';

const json = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** packages/<pkg> installed as `name`, with a prebuilt manifest for arm64-v8a unless `prebuilt` is false. */
function install(
  app,
  name,
  pkg,
  { prebuilt = true, abi = NATIVE_ABI, minSdk = 24, module = name, wrapper = true } = {},
) {
  const src = path.join(ROOT, 'packages', pkg);
  const dir = path.join(app, 'node_modules', name);
  cpSync(src, dir, {
    recursive: true,
    filter: (f) => !['rnrs', 'target', '.rnrs'].includes(path.relative(src, f).split(path.sep)[0]),
  });
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  manifest.name = name;
  json(path.join(dir, 'package.json'), manifest);
  if (!prebuilt) return dir;
  const crate = manifest.rustNative.rust.crate;
  if (wrapper) {
    mkdirSync(path.join(dir, 'rnrs'), { recursive: true });
    writeFileSync(path.join(dir, 'rnrs/index.ts'), '// @generated\n// IR hash: h\n');
  }
  const archive = `rnrs/native/android/arm64-v8a/librnrs_${crate}.a`;
  mkdirSync(path.dirname(path.join(dir, archive)), { recursive: true });
  writeFileSync(path.join(dir, archive), '!<arch>\n');
  const files = ['rust/Cargo.toml', ...['lib.rs', 'rnrs_interface.rs'].map((f) => `rust/src/${f}`)];
  json(path.join(dir, MANIFEST), {
    abi,
    module,
    hash: 'h',
    crate,
    symbol: tableSymbol(crate),
    android: { minSdk, linkLibraries: ['log', 'dl', 'm'], abis: { 'arm64-v8a': archive } },
    sourceFiles: Object.fromEntries(files.map((f) => [f, sha256(path.join(dir, f))])),
  });
  return dir;
}

function withApp(config, build, body) {
  const app = mkdtempSync(path.join(tmpdir(), 'rnrs-link-'));
  try {
    json(path.join(app, 'package.json'), {
      name: 'app',
      dependencies: { '@x/counter': '*', '@x/meter': '*' },
      ...(config ? { rustNativeApp: config } : {}),
    });
    build(app);
    return body(app);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}

const out = (app) => path.join(app, '.rnrs/android');

test('the generator, the C++ header and rnrs-android agree on the ABI number', () => {
  assert.match(
    readFileSync(path.join(ROOT, 'packages/runtime/cpp/RnrsAbi.h'), 'utf8'),
    new RegExp(`#define RNRS_ABI ${NATIVE_ABI}\\n`),
  );
  assert.match(
    readFileSync(path.join(ROOT, 'rust/rnrs-android/src/lib.rs'), 'utf8'),
    new RegExp(`pub const RNRS_ABI: u32 = ${NATIVE_ABI};`),
  );
  assert.equal(tableSymbol('my-mod'), `rnrs_module_v${NATIVE_ABI}_my_mod`);
});

test('prebuilt modules only: registry and archive list, no source bundle', () =>
  withApp(
    undefined,
    (app) => {
      install(app, '@x/counter', 'counter');
      install(app, '@x/meter', 'meter');
    },
    (app) => {
      const { prebuilt, source } = linkModules(app, 'android', {
        out: out(app),
        abis: ['arm64-v8a'],
        minSdk: 24,
      });
      assert.deepEqual(
        prebuilt.map((p) => p.crate),
        ['counter', 'meter'],
      );
      assert.equal(source.size, 0);
      const registry = readFileSync(path.join(out(app), 'rnrs_registry.inc'), 'utf8');
      assert.match(registry, /extern "C" const RnrsModuleV1\* rnrs_module_v1_counter\(\);/);
      assert.match(
        registry,
        /\{"rnrs_module_v1_meter", rnrs_module_v1_meter\},\n    \{nullptr, nullptr\},/,
      );
      const cmake = readFileSync(path.join(out(app), 'modules.cmake'), 'utf8');
      assert.match(cmake, /set\(RNRS_SOURCE_BUNDLE OFF\)/);
      assert.match(
        cmake,
        /if\(ANDROID_ABI STREQUAL "arm64-v8a"\)\n  set\(RNRS_MODULE_ARCHIVES ".*\/librnrs_counter\.a;.*\/librnrs_meter\.a"\)/,
      );
      assert.match(cmake, /set\(RNRS_MODULE_LINK_LIBRARIES "log;dl;m"\)/);
    },
  ));

test('a source override is per module, and its prebuilt archive is not linked', () =>
  withApp(
    { sourceBuild: ['@x/counter'] },
    (app) => {
      install(app, '@x/counter', 'counter');
      install(app, '@x/meter', 'meter');
    },
    (app) => {
      const { prebuilt, source } = linkModules(app, 'android', {
        out: out(app),
        abis: ['arm64-v8a'],
      });
      assert.deepEqual(
        prebuilt.map((p) => p.crate),
        ['meter'],
      );
      assert.deepEqual(
        [...source].map((p) => p.crate),
        ['counter'],
      );
      const cmake = readFileSync(path.join(out(app), 'modules.cmake'), 'utf8');
      assert.match(cmake, /set\(RNRS_SOURCE_BUNDLE ON\)/);
      assert.doesNotMatch(cmake, /librnrs_counter/);
      // Both tables are registered: counter's from the source bundle.
      assert.match(
        readFileSync(path.join(out(app), 'rnrs_registry.inc'), 'utf8'),
        /rnrs_module_v1_counter[\s\S]*rnrs_module_v1_meter/,
      );
    },
  ));

test('missing binaries, edited Rust sources, other ABIs, minSdk and unknown overrides are refused, never skipped', () => {
  withApp(
    undefined,
    (app) => {
      install(app, '@x/counter', 'counter', { prebuilt: false });
      install(app, '@x/meter', 'meter', { abi: NATIVE_ABI + 1 });
    },
    (app) =>
      assert.throws(
        () => linkModules(app, 'android', { out: out(app), abis: ['arm64-v8a'] }),
        (e) =>
          /@x\/counter: ships no prebuilt native binary \(rnrs\/native\/manifest\.json\); add its package name to rustNativeApp\.sourceBuild/.test(
            e.message,
          ) &&
          new RegExp(`@x/meter: its prebuilt binary is for rnrs ABI ${NATIVE_ABI + 1}`).test(
            e.message,
          ),
      ),
  );
  withApp(
    undefined,
    (app) => {
      const counter = install(app, '@x/counter', 'counter');
      // A patch-package style edit of the shipped Rust source, and an added file.
      appendFileSync(path.join(counter, 'rust/src/lib.rs'), '\n// patched\n');
      writeFileSync(path.join(counter, 'rust/src/extra.rs'), '');
      install(app, '@x/meter', 'meter', { minSdk: 30 });
    },
    (app) =>
      assert.throws(
        () =>
          linkModules(app, 'android', { out: out(app), abis: ['arm64-v8a', 'x86_64'], minSdk: 24 }),
        (e) =>
          /@x\/counter: its Rust sources differ from the ones its prebuilt binary was built from: rust\/src\/extra\.rs \(added\), rust\/src\/lib\.rs \(modified\)/.test(
            e.message,
          ) &&
          /@x\/meter: its prebuilt binary needs Android API 30, the app's minSdk is 24/.test(
            e.message,
          ) &&
          /@x\/meter: its prebuilt binary has no x86_64 archive/.test(e.message),
      ),
  );
  withApp(
    undefined,
    (app) => {
      install(app, '@x/counter', 'counter', { wrapper: false, module: 'Same' });
      install(app, '@x/meter', 'meter', { module: 'Same' });
    },
    (app) =>
      assert.throws(
        () => linkModules(app, 'android', { out: out(app) }),
        (e) =>
          /@x\/counter: has a prebuilt binary but no generated JS wrapper with an IR hash/.test(
            e.message,
          ) &&
          /module Same is defined by both app -> @x\/counter and app -> @x\/meter/.test(e.message),
      ),
  );
  withApp(
    { sourceBuild: ['@x/countr'] },
    (app) => {
      install(app, '@x/counter', 'counter');
      install(app, '@x/meter', 'meter');
    },
    (app) =>
      assert.throws(
        () => linkModules(app, 'android', { out: out(app) }),
        /rustNativeApp\.sourceBuild names @x\/countr, which is not among the app's Rust modules \(@x\/counter, @x\/meter\)/,
      ),
  );
});

test('iOS: prebuilt XCFramework slices per SDK are linked; a missing slice is refused', () =>
  withApp(
    { sourceBuild: ['@x/meter'] },
    (app) => {
      for (const [name, pkg, sim] of [
        ['@x/counter', 'counter', true],
        ['@x/meter', 'meter', false],
      ]) {
        const dir = install(app, name, pkg);
        const manifest = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));
        const xc = `rnrs/native/ios/rnrs_${pkg}.xcframework`;
        const slices = { iphoneos: { path: `${xc}/ios-arm64/librnrs_${pkg}.a` } };
        if (sim)
          slices.iphonesimulator = { path: `${xc}/ios-arm64_x86_64-simulator/librnrs_${pkg}.a` };
        for (const s of Object.values(slices)) {
          mkdirSync(path.dirname(path.join(dir, s.path)), { recursive: true });
          writeFileSync(path.join(dir, s.path), '!<arch>\n');
        }
        manifest.ios = {
          deploymentTarget: '15.1',
          exports: [`rnrs_module_v1_${pkg}`, `rnrs_eh_personality_${pkg}`],
          xcframework: xc,
          slices,
        };
        json(path.join(dir, MANIFEST), manifest);
      }
      const p = JSON.parse(
        readFileSync(path.join(app, 'node_modules/@x/counter/package.json'), 'utf8'),
      );
      p.rustNative.targets = ['android', 'ios'];
      json(path.join(app, 'node_modules/@x/counter/package.json'), p);
      const q = JSON.parse(
        readFileSync(path.join(app, 'node_modules/@x/meter/package.json'), 'utf8'),
      );
      q.rustNative.targets = ['android', 'ios'];
      json(path.join(app, 'node_modules/@x/meter/package.json'), q);
    },
    (app) => {
      const out = path.join(app, '.rnrs/ios');
      const { prebuilt, source, slices } = linkModules(app, 'ios', { out });
      assert.deepEqual(
        prebuilt.map((p) => p.crate),
        ['counter'],
      );
      assert.deepEqual(
        [...source].map((p) => p.crate),
        ['meter'],
      );
      assert.match(slices.iphoneos[0], /rnrs_counter\.xcframework\/ios-arm64\/librnrs_counter\.a$/);
      assert.match(slices.iphonesimulator[0], /ios-arm64_x86_64-simulator\/librnrs_counter\.a$/);
      assert.match(
        readFileSync(path.join(out, 'rnrs_registry.inc'), 'utf8'),
        /rnrs_module_v1_counter[\s\S]*rnrs_module_v1_meter/,
      );
      // meter (no simulator slice) as a prebuilt module is refused.
      const pj = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8'));
      delete pj.rustNativeApp;
      json(path.join(app, 'package.json'), pj);
      assert.throws(
        () => linkModules(app, 'ios', { out }),
        /@x\/meter: its prebuilt binary has no iOS iphonesimulator slice/,
      );
      // A slice built for a newer iOS than the app's deployment target is refused.
      assert.throws(
        () => linkModules(app, 'ios', { out, iosDeploymentTarget: '15.0' }),
        /@x\/counter: its prebuilt binary needs iOS 15\.1, the app's deployment target is 15\.0/,
      );
    },
  ));

test('rebuilding a target first drops its manifest entry, then its binaries; the other target stays', () =>
  withApp(
    undefined,
    (app) => install(app, '@x/counter', 'counter'),
    (app) => {
      const dir = path.join(app, 'node_modules/@x/counter');
      const file = path.join(dir, MANIFEST);
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifest.ios = { deploymentTarget: '15.1', slices: {} };
      json(file, manifest);
      mkdirSync(path.join(dir, 'rnrs/native/ios'), { recursive: true });
      invalidateTarget(dir, 'ios');
      const after = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(after.ios, undefined);
      assert.deepEqual(after.android, manifest.android);
      assert.equal(existsSync(path.join(dir, 'rnrs/native/ios')), false);
      assert.equal(existsSync(path.join(dir, after.android.abis['arm64-v8a'])), true);
      // An app meeting the package now refuses the target instead of trusting old metadata.
      const p = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      p.rustNative.targets = ['android', 'ios'];
      json(path.join(dir, 'package.json'), p);
      json(path.join(app, 'package.json'), { name: 'app', dependencies: { '@x/counter': '*' } });
      assert.throws(
        () => linkModules(app, 'ios', { out: path.join(app, '.rnrs/ios') }),
        /@x\/counter: its prebuilt binary has no iOS iphoneos slice/,
      );
    },
  ));

test('web: the registry imports each prebuilt instance; an overridden module is imported from the source bundle only', () =>
  withApp(
    undefined,
    (app) => {
      for (const [name, pkg] of [
        ['@x/counter', 'counter'],
        ['@x/meter', 'meter'],
      ]) {
        const dir = install(app, name, pkg);
        const file = path.join(dir, MANIFEST);
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        manifest.web = {
          abi: 1,
          wasmBindgen: '0.2.129',
          js: `rnrs/native/web/rnrs_${pkg}.js`,
          wasm: `rnrs/native/web/rnrs_${pkg}_bg.wasm`,
        };
        for (const f of [manifest.web.js, manifest.web.wasm]) {
          mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
          writeFileSync(path.join(dir, f), '');
        }
        json(file, manifest);
      }
    },
    (app) => {
      const out = path.join(app, '.rnrs/web');
      linkModules(app, 'web', { out });
      const registry = readFileSync(path.join(out, 'rnrs.js'), 'utf8');
      assert.match(
        registry,
        /import \* as m_counter from "\.\.\/\.\.\/node_modules\/@x\/counter\/rnrs\/native\/web\/rnrs_counter\.js";/,
      );
      assert.match(
        registry,
        /export const instances = \[m_counter, m_meter\];\n[^\n]*\nexport const source = null;/,
      );
      assert.doesNotMatch(registry, /pkg\/rnrs_bundle/);
      const pj = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8'));
      pj.rustNativeApp = { sourceBuild: ['@x/counter'] };
      json(path.join(app, 'package.json'), pj);
      const { source } = linkModules(app, 'web', { out });
      assert.deepEqual(
        [...source].map((p) => p.crate),
        ['counter'],
      );
      const mixed = readFileSync(path.join(out, 'rnrs.js'), 'utf8');
      assert.match(
        mixed,
        /export const instances = \[source_bundle, m_meter\];\n[^\n]*\nexport const source = source_bundle;/,
      );
      assert.doesNotMatch(mixed, /rnrs_counter\.js/);
      const meterManifest = path.join(app, 'node_modules/@x/meter', MANIFEST);
      const m = JSON.parse(readFileSync(meterManifest, 'utf8'));
      json(meterManifest, { ...m, web: { ...m.web, abi: 2 } });
      assert.throws(
        () => linkModules(app, 'web', { out }),
        /@x\/meter: its prebuilt Wasm module is for web ABI 2, this @rnrs\/runtime needs 1/,
      );
      json(meterManifest, m);
      rmSync(path.join(app, 'node_modules/@x/meter/rnrs/native/web/rnrs_meter_bg.wasm'));
      assert.throws(
        () => linkModules(app, 'web', { out }),
        /@x\/meter: its prebuilt binary has no web Wasm file/,
      );
    },
  ));

test('author guard: binaries must match the package; missing ones warn when packing and fail publishing', () =>
  withApp(
    undefined,
    (app) => install(app, '@x/counter', 'counter'),
    (app) => {
      const dir = path.join(app, 'node_modules/@x/counter');
      // A publishable package (the repository's example is private).
      const { private: _, ...publishable } = JSON.parse(
        readFileSync(path.join(dir, 'package.json'), 'utf8'),
      );
      json(path.join(dir, 'package.json'), publishable);
      const file = path.join(dir, MANIFEST);
      const m = JSON.parse(readFileSync(file, 'utf8'));
      // The real spec identity, and all four default ABIs.
      Object.assign(m, { module: 'CounterModule', hash: '5573e8f1e32912aa' });
      for (const abi of ANDROID_ABIS) {
        m.android.abis[abi] = `rnrs/native/android/${abi}/librnrs_counter.a`;
        mkdirSync(path.join(dir, 'rnrs/native/android', abi), { recursive: true });
        writeFileSync(path.join(dir, m.android.abis[abi]), '!<arch>\n');
      }
      json(file, m);
      // The package declares android, ios and web: ios and web binaries are missing.
      const packing = checkPackageBinaries(dir);
      assert.deepEqual(packing.errors, []);
      assert.match(
        packing.warnings.join('\n'),
        /no prebuilt ios binaries; run `rnrs build-native --target ios` before publishing/,
      );
      assert.match(packing.warnings.join('\n'), /no prebuilt web binaries/);
      const publishing = checkPackageBinaries(dir, { require: true });
      assert.equal(publishing.errors.length, 2);
      // One platform per machine: only the given targets are required.
      assert.deepEqual(
        checkPackageBinaries(dir, { require: true, targets: ['android'] }).errors,
        [],
      );
      // A private package (never published) packs without warnings.
      const priv = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      json(path.join(dir, 'package.json'), { ...priv, private: true });
      assert.deepEqual(checkPackageBinaries(dir).warnings, []);
      json(path.join(dir, 'package.json'), priv);
      // Android only: publishable once the declared targets match.
      const p = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      p.rustNative.targets = ['android'];
      json(path.join(dir, 'package.json'), p);
      assert.deepEqual(checkPackageBinaries(dir, { require: true }).errors, []);
      // A missing default ABI fails publishing.
      rmSync(path.join(dir, m.android.abis.x86));
      assert.match(
        checkPackageBinaries(dir, { require: true }).errors.join('\n'),
        /no prebuilt Android x86 archive/,
      );
      writeFileSync(path.join(dir, m.android.abis.x86), '!<arch>\n');
      // Rust edited after build-native: stale, refused even when packing.
      appendFileSync(path.join(dir, 'rust/src/lib.rs'), '\n// edited\n');
      assert.match(
        checkPackageBinaries(dir).errors.join('\n'),
        /the Rust sources changed after the binaries were built: rust\/src\/lib\.rs \(modified\); rebuild every target/,
      );
    },
  ));

test('author guard: a module that needs rnrs-surface is source-only and says apps must build it from source', () => {
  const { notes, errors } = checkPackageBinaries(path.join(ROOT, 'packages/vello2d'), {
    require: true,
  });
  assert.deepEqual(errors, []);
  assert.match(
    notes.join('\n'),
    /no prebuilt binaries \(its crate needs rnrs-surface, which cannot be prebuilt yet\): every app using it must list it in rustNativeApp\.sourceBuild and build it with Rust/,
  );
});
