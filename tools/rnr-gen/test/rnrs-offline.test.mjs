// The rnrs facade from the packed @rnrs/runtime and @rnrs/cli tarballs, offline, with real cargo:
// a headless module depending only on rnrs (renamed) builds and tests with no @rnrs/surface
// anywhere, and its app lock holds no surface or GPU crate. Enabling rnrs's "surface" feature is
// refused until @rnrs/surface is installed, and then resolves from the installed package.
// Builds only rnr-core, rnrs and the module (host).
//
// Offline, so it needs a warm registry cache in CARGO_HOME (the framework's own dependencies,
// e.g. tokio for rnr-core's native backend, come from crates.io): `cargo fetch` of the repository
// workspace warms it. The lock assertions are the proof; no surface or GPU crate is ever needed.
// Without cargo the test is skipped, unless RNR_REQUIRE_CARGO=1, which makes that a failure and
// requires CARGO_HOME to be set, so the warm-up and the test use the same cache. The strict
// command (inside `nix develop`, from the repository root):
//   source scripts/rust-env.sh && npm run test:rnrs-offline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from '../cli.mjs';

const strict = process.env.RNR_REQUIRE_CARGO === '1';
const local = path.join(ROOT, '.generated');
// Non-strict runs use the repository's isolated cache when present; strict runs only CARGO_HOME.
if (!strict && !process.env.CARGO_HOME && existsSync(path.join(local, 'cargo'))) {
  process.env.CARGO_HOME = path.join(local, 'cargo');
  process.env.RUSTUP_HOME ??= path.join(local, 'rustup');
  process.env.RUSTUP_TOOLCHAIN ??= '1.90.0';
}
const cargoOk = spawnSync(process.env.RNR_CARGO ?? 'cargo', ['--version']).status === 0;
// Strict: never skip (a missing cargo or cache location fails below).
const skip =
  strict || cargoOk ? false : 'cargo is not available (RNR_REQUIRE_CARGO=1 makes this a failure)';

/** Packages cargo resolved, by name, from a Cargo.lock: name -> source (null for paths). */
const lockPackages = (lock) =>
  new Map(
    [
      ...lock.matchAll(
        /\[\[package\]\]\nname = "([^"]+)"\nversion = "[^"]+"(?:\nsource = "([^"]+)")?/g,
      ),
    ].map((m) => [m[1], m[2] ?? null]),
  );
const SURFACE_OR_GPU =
  /^(rnr-surface|raw-window-handle|wgpu.*|naga|pollster|ash|metal|objc2.*|web-sys|js-sys|wasm-bindgen.*)$/;

test(
  'packed rnrs: a headless module needs no @rnrs/surface or GPU crate, offline; surface needs the installed library',
  { skip, timeout: 600_000 },
  () => {
    if (strict) {
      assert.ok(cargoOk, 'RNR_REQUIRE_CARGO=1: cargo is not available');
      assert.ok(
        process.env.CARGO_HOME,
        'RNR_REQUIRE_CARGO=1: set CARGO_HOME (source scripts/rust-env.sh) to the cache warmed by cargo fetch',
      );
    }
    const work = mkdtempSync(path.join(tmpdir(), 'rnrs-offline-'));
    try {
      const packDir = path.join(work, 'pack');
      const packed = spawnSync('node', [path.join(ROOT, 'scripts/pack.mjs')], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, RNR_PACK_OUT: packDir },
      });
      assert.equal(packed.status, 0, packed.stderr);
      const app = path.join(work, 'app');
      mkdirSync(app);
      writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'app', private: true }));
      // A real npm install of the tarballs, offline from the npm cache (warmed by the repository's
      // npm ci): the CLI's own dependencies (typescript, smol-toml) come from its package.json.
      // React Native peers are not needed for Rust commands (--legacy-peer-deps).
      const npm = (...args) => {
        const r = spawnSync(
          'npm',
          [
            'install',
            '--offline',
            '--no-audit',
            '--no-fund',
            '--legacy-peer-deps',
            '--ignore-scripts',
            ...args,
          ],
          { cwd: app, encoding: 'utf8' },
        );
        assert.equal(
          r.status,
          0,
          `npm install --offline ${args.join(' ')} failed (warm the npm cache: npm ci in the repository):\n${r.stderr}`,
        );
      };
      npm(path.join(packDir, 'rnrs-cli-0.1.0.tgz'), path.join(packDir, 'rnrs-runtime-0.1.0.tgz'));
      for (const dep of ['typescript', 'smol-toml'])
        assert.ok(
          existsSync(path.join(app, 'node_modules', dep, 'package.json')),
          `${dep} installed as a dependency of @rnrs/cli`,
        );
      const env = {
        ...process.env,
        CARGO_NET_OFFLINE: 'true',
        CARGO_TARGET_DIR: path.join(work, 'target'),
      };
      const rnrs = (...args) => {
        const r = spawnSync(
          'node',
          [path.join(app, 'node_modules/@rnrs/cli/bin/rnrs.mjs'), ...args],
          { cwd: app, encoding: 'utf8', env },
        );
        return { code: r.status, out: `${r.stdout}${r.stderr}` };
      };
      // The author's package, installed into the app by npm as a local (file:) dependency.
      const mod = path.join(app, 'mods/demo-headless');
      let r = rnrs('init', mod, '--name', 'demo-headless', '--targets', 'android,web');
      assert.equal(r.code, 0, r.out);
      // The scaffold depends on rnrs; rename it to cover renamed facades end to end.
      const toml = path.join(mod, 'rust/Cargo.toml');
      const scaffold = readFileSync(toml, 'utf8');
      assert.match(scaffold, /^rnrs = "0\.1"$/m);
      writeFileSync(
        toml,
        scaffold.replace(/^rnrs = "0\.1"$/m, 'fw = { package = "rnrs", version = "0.1" }'),
      );
      r = rnrs('generate', mod);
      assert.equal(r.code, 0, r.out);
      const iface = readFileSync(path.join(mod, 'rust/src/rnr_interface.rs'), 'utf8');
      assert.match(iface, /^use fw::core::bind::\{MaybeSend, NativeObject\};$/m);
      // Compiles and runs the scaffold's test against the packed framework copies, offline.
      r = rnrs('test', mod);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /test tests::greets \.\.\. ok/);
      npm('./mods/demo-headless');
      // A weak extra check: no framework crate is in the registry cache cargo used.
      const cargoHome = process.env.CARGO_HOME ?? path.join(homedir(), '.cargo');
      const cache = path.join(cargoHome, 'registry/cache');
      const cached = existsSync(cache)
        ? readdirSync(cache).flatMap((d) => readdirSync(path.join(cache, d)))
        : [];
      assert.ok(
        !cached.some((f) => /^(rnrs|rnr-surface|rnr-core)-\d/.test(f)),
        'framework crates are never in the registry cache',
      );
      for (const target of ['android', 'web']) {
        r = rnrs('lock', '--target', target, '--app', app, '--offline');
        assert.equal(r.code, 0, r.out);
        const lock = readFileSync(path.join(app, `rnr-${target}.Cargo.lock`), 'utf8');
        const pkgs = lockPackages(lock);
        for (const name of ['rnrs', 'rnr-core', 'demo-headless'])
          assert.equal(pkgs.get(name), null, `${target}: ${name} resolved from its installed path`);
        const unwanted = [...pkgs.keys()].filter(
          (n) =>
            SURFACE_OR_GPU.test(n) &&
            !(target === 'web' && /^(js-sys|wasm-bindgen.*|web-sys)$/.test(n)),
        );
        assert.deepEqual(unwanted, [], `${target}: no surface or GPU crate in the headless lock`);
        assert.doesNotMatch(lock, /patch\.unused/);
        assert.ok(!lock.includes(work), 'no machine paths');
      }
      // rnrs's "surface" feature without @rnrs/surface: refused before cargo runs.
      writeFileSync(
        toml,
        readFileSync(toml, 'utf8').replace(
          'version = "0.1" }',
          'version = "0.1", features = ["surface"] }',
        ),
      );
      r = rnrs('lock', '--target', 'android', '--app', app, '--offline');
      assert.equal(r.code, 1, r.out);
      assert.match(
        r.out,
        /app -> demo-headless: its crate enables rnrs's "surface" feature, which needs rnr-surface, which no installed package provides .*; add @rnrs\/surface to the app's dependencies/,
      );
      assert.doesNotMatch(r.out, /no matching package/);
      // Installed as a direct dependency: rnr-surface resolves from the package, and no GPU crate.
      npm(path.join(packDir, 'rnrs-surface-0.1.0.tgz'));
      r = rnrs('lock', '--target', 'android', '--app', app, '--offline');
      assert.equal(r.code, 0, r.out);
      const pkgs = lockPackages(readFileSync(path.join(app, 'rnr-android.Cargo.lock'), 'utf8'));
      assert.equal(pkgs.get('rnr-surface'), null, 'from the installed package path');
      assert.deepEqual(
        [...pkgs.keys()].filter((n) => /^(wgpu.*|naga|pollster|ash)$/.test(n)),
        [],
        'surface alone pulls in no GPU crate (rnr-surface/wgpu is off)',
      );
      // rnrs's "wgpu" feature: the adapter's wgpu enters the lock, exactly as rnr-surface pins it.
      writeFileSync(
        toml,
        readFileSync(toml, 'utf8').replace(
          'version = "0.1", features = ["surface"] }',
          'version = "0.1", features = ["wgpu"] }',
        ),
      );
      r = rnrs('lock', '--target', 'android', '--app', app, '--offline');
      assert.equal(r.code, 0, r.out);
      const gpuLock = readFileSync(path.join(app, 'rnr-android.Cargo.lock'), 'utf8');
      assert.match(
        gpuLock,
        /\[\[package\]\]\nname = "wgpu"\nversion = "30\.0\.1"\nsource = "registry\+/,
      );
      assert.equal(lockPackages(gpuLock).get('rnr-surface'), null);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
