// App-owned bundle lock files, with real cargo (resolution only, offline from the local
// registry cache; nothing is compiled). Skipped when cargo is unavailable.
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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from '../cli.mjs';
import { buildBundle, lockBundle, lockFile } from '../bundle.mjs';

const local = path.join(ROOT, '.generated');
if (!process.env.CARGO_HOME && existsSync(path.join(local, 'cargo'))) {
  process.env.CARGO_HOME = path.join(local, 'cargo');
  process.env.RUSTUP_HOME ??= path.join(local, 'rustup');
  process.env.RUSTUP_TOOLCHAIN ??= '1.90.0';
}
const cargo = spawnSync(process.env.RNRS_CARGO ?? 'cargo', ['--version']);
const skip = cargo.status === 0 ? false : 'cargo is not available';

const json = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};
const NAMES = { counter: '@rnrs/example-counter', values: '@rnrs/labs-values' };
function app(deps) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rnrs-lock-'));
  json(path.join(dir, 'package.json'), {
    name: 'app',
    dependencies: Object.fromEntries(deps.map((d) => [NAMES[d], '1'])),
  });
  for (const d of ['counter', 'values']) {
    mkdirSync(path.join(dir, 'node_modules/@rnrs'), { recursive: true });
    symlinkSync(path.join(ROOT, 'packages', d), path.join(dir, 'node_modules', NAMES[d]));
  }
  return dir;
}
const packages = (lock) =>
  new Map(
    [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
const opts = (dir) => ({ out: path.join(dir, '.rnrs/web'), offline: true });

test(
  'the app lock is created, regenerated bundles keep it, and it holds no machine paths',
  { skip },
  () => {
    const dir = app(['counter']);
    const moved = mkdtempSync(path.join(tmpdir(), 'rnrs-lock-moved-'));
    try {
      // --locked without a committed lock fails before any cargo work.
      assert.throws(
        () => buildBundle(dir, 'web', { ...opts(dir), locked: true }),
        /rnrs-web.Cargo.lock is missing, and --locked \(or RNRS_LOCKED=1\) requires/,
      );
      assert.throws(
        () => lockBundle(dir, 'web', { ...opts(dir), check: true }),
        /rnrs-web.Cargo.lock is missing; run `npx rnrs lock --target web`/,
      );
      assert.equal(lockBundle(dir, 'web', opts(dir)).changed, true);
      const lock = readFileSync(lockFile(dir, 'web'), 'utf8');
      assert.match(lock, /name = "counter"/);
      assert.match(lock, /name = "rnrs-bundle"/);
      for (const p of [dir, ROOT, tmpdir(), process.env.HOME].filter(Boolean))
        assert.ok(!lock.includes(p), `lock mentions ${p}`);
      assert.equal(
        readFileSync(path.join(dir, '.rnrs/.gitignore'), 'utf8').split('\n').at(-2),
        '*',
      );
      // Deleting the generated directory keeps the app's lock; the check regenerates and passes.
      rmSync(path.join(dir, '.rnrs'), { recursive: true, force: true });
      assert.doesNotThrow(() => lockBundle(dir, 'web', { ...opts(dir), check: true }));
      assert.equal(lockBundle(dir, 'web', opts(dir)).changed, false);
      // A relocated copy of the app (another absolute path) uses the same lock unchanged.
      cpSync(dir, moved, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (src) => !src.includes(`${path.sep}.rnrs`),
      });
      assert.doesNotThrow(() => lockBundle(moved, 'web', { ...opts(moved), check: true }));
      assert.equal(readFileSync(lockFile(moved, 'web'), 'utf8'), lock);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
    }
  },
);

test(
  'a new module dependency makes the lock stale; rnrs lock adds it and keeps locked versions',
  { skip },
  () => {
    const dir = app(['counter']);
    try {
      lockBundle(dir, 'web', opts(dir));
      const before = packages(readFileSync(lockFile(dir, 'web'), 'utf8'));
      json(path.join(dir, 'package.json'), {
        name: 'app',
        dependencies: { '@rnrs/example-counter': '1', '@rnrs/labs-values': '1' },
      });
      assert.throws(
        () => lockBundle(dir, 'web', { ...opts(dir), check: true }),
        /rnrs-web.Cargo.lock does not match the app's Rust dependencies for web\. Run `npx rnrs lock --target web`/,
      );
      assert.throws(
        () => buildBundle(dir, 'web', { ...opts(dir), cargo: process.env.RNRS_CARGO ?? 'cargo' }),
        /does not match the app's Rust dependencies/,
      );
      assert.equal(lockBundle(dir, 'web', opts(dir)).changed, true);
      const after = packages(readFileSync(lockFile(dir, 'web'), 'utf8'));
      assert.ok(after.has('values'));
      for (const [name, version] of before)
        if (after.has(name)) assert.equal(after.get(name), version, name);
      assert.doesNotThrow(() => lockBundle(dir, 'web', { ...opts(dir), check: true }));
      // Android and web locks are independent files.
      assert.ok(!existsSync(lockFile(dir, 'android')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'a module whose rnrs-core requirement the framework patch cannot satisfy is rejected',
  { skip },
  () => {
    const dir = app([]);
    try {
      const pkg = path.join(dir, 'node_modules/bad-core');
      cpSync(path.join(ROOT, 'packages/counter'), pkg, {
        recursive: true,
        filter: (src) => !/[/\\]rnrs([/\\]|$)/.test(src.slice(ROOT.length)),
      });
      const manifest = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'));
      manifest.name = 'bad-core';
      manifest.rustNative.rust.crate = 'bad_core';
      json(path.join(pkg, 'package.json'), manifest);
      const cargoToml = path.join(pkg, 'rust/Cargo.toml');
      writeFileSync(
        cargoToml,
        readFileSync(cargoToml, 'utf8')
          .replace('name = "counter"', 'name = "bad_core"')
          .replace('rnrs-core = "0.4"', 'rnrs-core = "0.0.1"'),
      );
      json(path.join(dir, 'package.json'), { name: 'app', dependencies: { 'bad-core': '1' } });
      // Offline: an unsatisfiable patch fails resolution (online it could fetch an unrelated
      // crate, which the provenance check then rejects); either way nothing is built.
      assert.throws(
        () => lockBundle(dir, 'web', opts(dir)),
        /could not resolve|not the framework's/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
