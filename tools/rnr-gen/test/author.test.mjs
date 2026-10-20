// Author commands: CLI help and usage errors, `rnrs init` (scaffold, merge, never overwrite),
// the package.json contract lint of `rnrs check`, `rnrs test` argument/exit-status forwarding
// (with a stand-in cargo), and the wasm-bindgen CLI version check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FRAMEWORK_RUST, main } from '../cli.mjs';
import { checkWasmBindgen, wasmBindgenVersion } from '../bundle.mjs';

const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
async function withDir(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rnr author ')); // a space on purpose
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** Runs main with console output captured. */
async function run(argv) {
  const out = [];
  const saved = [console.log, console.error];
  console.log = console.error = (...a) => out.push(a.join(' '));
  try {
    return { code: await main(argv), out: out.join('\n') };
  } finally {
    [console.log, console.error] = saved;
  }
}

test('help, unknown commands and a missing ir argument print usage instead of app errors', async () => {
  for (const argv of [['help'], ['--help']]) {
    const r = await run(argv);
    assert.equal(r.code, 0);
    assert.match(r.out, /init \[dir\]/);
  }
  for (const argv of [[], ['bogus']]) {
    const r = await run(argv);
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.out, /rustNativeApp/);
  }
  assert.equal((await run(['ir'])).code, 2);
});

test('init scaffolds a package that generates and passes check', async () => {
  await withDir(async (root) => {
    const dir = path.join(root, 'crc');
    const r = await run(['init', dir, '--name', '@demo/crc']);
    assert.equal(r.code, 0, r.out);
    const m = json(path.join(dir, 'package.json'));
    assert.deepEqual(m.rustNative, {
      targets: ['android', 'ios', 'web'],
      spec: 'crc.spec.ts',
      rust: { crate: 'demo-crc', path: 'rust', module: 'Module' },
    });
    assert.match(
      readFileSync(path.join(dir, 'rust/src/rnr_interface.rs'), 'utf8'),
      /pub trait CrcModule/,
    );
    assert.match(
      readFileSync(path.join(dir, '.gitignore'), 'utf8'),
      /^rust\/src\/rnr_interface\.rs$/m,
    );
    assert.match(r.out, /declaration of support/);
    assert.equal((await run(['check', dir])).code, 0);
    // A second init refuses, and changes nothing.
    const before = readFileSync(path.join(dir, 'package.json'), 'utf8');
    assert.equal((await run(['init', dir])).code, 1);
    assert.equal(readFileSync(path.join(dir, 'package.json'), 'utf8'), before);
  });
});

test('init merges into an existing package.json and refuses conflicts without writing', async () => {
  await withDir(async (dir) => {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'my-lib', devDependencies: { '@rnrs/runtime': 'file:x.tgz' } }),
    );
    assert.equal((await run(['init', dir, '--targets', 'android,web'])).code, 0);
    const m = json(path.join(dir, 'package.json'));
    assert.equal(m.devDependencies['@rnrs/runtime'], 'file:x.tgz');
    assert.deepEqual(m.rustNative.targets, ['android', 'web']);
    assert.equal(m.rustNative.rust.crate, 'my-lib');
  });
  await withDir(async (dir) => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', main: 'index.js' }));
    mkdirSync(path.join(dir, 'rust/src'), { recursive: true });
    writeFileSync(path.join(dir, 'rust/src/lib.rs'), '// mine\n');
    const r = await run(['init', dir]);
    assert.equal(r.code, 1);
    assert.match(r.out, /nothing was written/);
    assert.match(r.out, /main is "index\.js"/);
    assert.match(r.out, /rust\/src\/lib\.rs already exists/);
    assert.equal(readFileSync(path.join(dir, 'rust/src/lib.rs'), 'utf8'), '// mine\n');
    assert.ok(!existsSync(path.join(dir, 'x.spec.ts')));
    assert.deepEqual(json(path.join(dir, 'package.json')), { name: 'x', main: 'index.js' });
  });
});

test('init validates names and targets', async () => {
  await withDir(async (dir) => {
    assert.match((await run(['init', dir, '--name', 'Bad Name'])).out, /invalid package name/);
    assert.match(
      (await run(['init', dir, '--name', 'ok', '--targets', 'android,desktop'])).out,
      /unknown target "desktop"/,
    );
    assert.match(
      (await run(['init', dir, '--name', 'ok', '--crate', 'rnr-core'])).out,
      /reserved for the framework/,
    );
    assert.ok(!existsSync(path.join(dir, 'package.json')));
  });
});

test('check accepts other working layouts and rejects packages apps cannot use', async () => {
  await withDir(async (root) => {
    const dir = path.join(root, 'p');
    assert.equal((await run(['init', dir, '--name', 'p', '--targets', 'android'])).code, 0);
    const file = path.join(dir, 'package.json');
    const base = json(file);
    const check = async (edit) => {
      writeFileSync(file, JSON.stringify(edit(structuredClone(base))));
      return run(['check', dir]);
    };
    // No exports, legacy fields only; files as a glob.
    assert.equal(
      (
        await check((m) => {
          delete m.exports;
          m.files = ['*.spec.ts', 'rust/**', 'rnr'];
          return m;
        })
      ).code,
      0,
    );
    // exports with a react-native condition and a subpath map.
    assert.equal(
      (
        await check((m) => ({
          ...m,
          exports: { '.': { 'react-native': './rnr/index.ts', default: './lib.js' } },
        }))
      ).code,
      0,
    );
    let r = await check((m) => ({ ...m, files: [m.files[0], 'rust/src', 'rnr'] }));
    assert.equal(r.code, 1);
    assert.match(r.out, /npm pack would leave out rust\/Cargo\.toml/);
    // npm's own rules: a negation in files, and an unanchored .gitignore pattern without files.
    r = await check((m) => ({ ...m, files: [...m.files, '!rust/src/lib.rs'] }));
    assert.match(r.out, /leave out rust\/src\/lib\.rs/);
    writeFileSync(path.join(dir, '.npmignore'), '*.rs\n');
    r = await check((m) => {
      delete m.files;
      return m;
    });
    assert.match(r.out, /leave out rust\/src\/lib\.rs, rust\/src\/rnr_interface\.rs/);
    rmSync(path.join(dir, '.npmignore'));
    // Metro without exports reads react-native, then browser, then main.
    r = await check((m) => {
      delete m.exports;
      delete m['react-native'];
      m.browser = 'rnr/web.ts';
      return m;
    });
    assert.match(r.out, /React Native resolves the package \(via browser\) to rnr\/web\.ts/);
    // A gitignored interface that was not generated yet (fresh clone) is reported as such.
    writeFileSync(file, JSON.stringify(base));
    rmSync(path.join(dir, 'rust/src/rnr_interface.rs'));
    r = await run(['check', dir]);
    assert.match(r.out, /interface not generated/);
    assert.ok(!existsSync(path.join(dir, 'rust/src/rnr_interface.rs'))); // check does not write
    assert.equal((await run(['generate', dir])).code, 0);
    r = await check((m) => ({ ...m, exports: { '.': './index.js' } }));
    assert.match(r.out, /React Native resolves the package \(via exports\["\."\]\) to index\.js/);
    r = await check((m) => {
      delete m.files;
      return m;
    }); // .gitignore excludes rnr/ and the interface
    assert.match(r.out, /leave out rust\/src\/rnr_interface\.rs \(/); // npm always packs main (rnr/index.ts)
  });
});

test('rnrs test patches rnr-core to the framework, forwards arguments and the exit status', async () => {
  await withDir(async (root) => {
    const dir = path.join(root, 'p');
    assert.equal((await run(['init', dir, '--name', 'p'])).code, 0);
    rmSync(path.join(dir, 'rust/src/rnr_interface.rs')); // regenerated by rnrs test
    const log = path.join(root, 'args.json');
    const cargo = path.join(root, 'fake cargo');
    writeFileSync(
      cargo,
      `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({args: process.argv.slice(2), target: process.env.CARGO_TARGET_DIR}));\nprocess.exit(3);\n`,
    );
    chmodSync(cargo, 0o755);
    process.env.RNR_CARGO = cargo;
    try {
      assert.equal((await run(['test', dir, '--release', '--', '--nocapture'])).code, 3);
    } finally {
      delete process.env.RNR_CARGO;
    }
    // A test-name filter in the directory position is a usage error, not a stack trace.
    const bad = await run(['test', path.join(root, 'greets')]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /has no package\.json.*rnrs test \. my_test/s);
    const { args, target } = json(log);
    assert.deepEqual(args.slice(0, 3), [
      'test',
      '--manifest-path',
      path.join(dir, 'rust/Cargo.toml'),
    ]);
    assert.equal(
      args[4],
      `patch.crates-io.rnr-core.path=${JSON.stringify(path.join(FRAMEWORK_RUST, 'rnr-core'))}`,
    );
    assert.deepEqual(args.slice(5), ['--release', '--', '--nocapture']);
    assert.equal(target, path.join(dir, '.rnr/target'));
    assert.ok(existsSync(path.join(dir, 'rust/src/rnr_interface.rs')));
  });
});

test('the web build requires the pinned wasm-bindgen CLI version', async () => {
  const want = wasmBindgenVersion();
  assert.match(
    readFileSync(path.join(FRAMEWORK_RUST, 'rnr-web/Cargo.toml'), 'utf8'),
    new RegExp(`wasm-bindgen = "=${want.replace(/\./g, '\\.')}"`),
  );
  await withDir((dir) => {
    const fake = path.join(dir, 'wasm-bindgen');
    writeFileSync(fake, '#!/bin/sh\necho "wasm-bindgen 0.2.1"\n');
    chmodSync(fake, 0o755);
    assert.throws(
      () => checkWasmBindgen(fake),
      new RegExp(
        `needs the wasm-bindgen CLI ${want}.*is 0\\.2\\.1.*cargo install wasm-bindgen-cli --version ${want}`,
      ),
    );
    writeFileSync(fake, `#!/bin/sh\necho "wasm-bindgen ${want}"\n`);
    checkWasmBindgen(fake);
    assert.throws(() => checkWasmBindgen(path.join(dir, 'missing')), /could not be run/);
  });
});

test('a spec outside the package is rejected without writing outside the scratch copy', async () => {
  await withDir(async (root) => {
    const dir = path.join(root, 'p');
    assert.equal((await run(['init', dir, '--name', 'p', '--targets', 'android'])).code, 0);
    const file = path.join(dir, 'package.json');
    const m = json(file);
    writeFileSync(path.join(root, 'outside.spec.ts'), readFileSync(path.join(dir, 'p.spec.ts')));
    m.rustNative.spec = '../outside.spec.ts';
    writeFileSync(file, JSON.stringify(m));
    assert.equal((await run(['generate', dir])).code, 0);
    const before = new Set(readdirSync(path.dirname(root)));
    const r = await run(['check', dir]);
    assert.deepEqual(new Set(readdirSync(path.dirname(root))), before); // nothing written next to the scratch copies
    assert.equal(r.code, 1);
    assert.match(r.out, /\.\.\/outside\.spec\.ts is outside the package directory/);
  });
});
