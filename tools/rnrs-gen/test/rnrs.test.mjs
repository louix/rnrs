// The rnrs facade on the generator side, without cargo: reading Cargo manifests (renames,
// target tables, workspace inheritance), the generated interface's rnrs-core path, the
// conditional rnrs patch, and diagnostics for rnrs features whose library is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { FRAMEWORK_SPEC, ROOT, checkCoreRequirement, interfaceCore } from '../cli.mjs';
import { parseSpec } from '../parse.mjs';
import { ManifestError, activeDependencies, parseToml, readManifest } from '../cargo-manifest.mjs';
import { cargoFeatureFlags, testPackage } from '../author.mjs';
import {
  BundleError,
  explainMissing,
  generateBundle,
  selectModules,
  usesRnrs,
} from '../bundle.mjs';
import { emitInterface } from '../emit-rust.mjs';

const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const json = (file, value) => write(file, JSON.stringify(value, null, 2));
/** A parsed table as plain JSON data (tables have null prototypes). */
const plain = (v) => JSON.parse(JSON.stringify(v));

function withDir(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rnrs-gen-'));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A crate whose manifest is `[package]` plus `body`; returns a pkg-like {cratePath}. */
function crate(dir, body, name = 'm') {
  write(
    path.join(dir, 'Cargo.toml'),
    `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n${body}\n`,
  );
  write(path.join(dir, 'src/lib.rs'), ''); // a target, so cargo accepts the crate
  return { cratePath: dir };
}

test('the manifest reader handles the TOML Cargo files use', () => {
  const toml = parseToml(
    [
      '# comment',
      '[package]',
      "name = 'lit' # trailing",
      'description = """multi',
      'line"""',
      '[dependencies]',
      'a = "1"',
      'b = { version = "0.1", features = ["x", "y"], optional = true }',
      'c.package = "real-c"',
      'c.version = "2"',
      '"quoted-key" = "3"',
      '[target.\'cfg(target_os = "ios")\'.dependencies]',
      'd = { package = "rnrs", version = "0.1" }',
      '[dependencies.e]',
      'version = "4"',
      'features = [',
      '  "one", # why',
      '  "two",',
      ']',
      '[[bin]]',
      'name = "first"',
      '[[bin]]',
      'name = "second"',
      '[features]',
      'f = ["b/x", "dep:b", "e?/one"]',
    ].join('\n'),
  );
  assert.equal(toml.package.name, 'lit');
  assert.equal(toml.package.description, 'multi\nline');
  assert.deepEqual(plain(toml.dependencies.b), {
    version: '0.1',
    features: ['x', 'y'],
    optional: true,
  });
  assert.deepEqual(plain(toml.dependencies.c), { package: 'real-c', version: '2' });
  assert.equal(toml.dependencies['quoted-key'], '3');
  assert.deepEqual(plain(toml.target['cfg(target_os = "ios")'].dependencies.d), {
    package: 'rnrs',
    version: '0.1',
  });
  assert.deepEqual(plain(toml.dependencies.e.features), ['one', 'two']);
  assert.deepEqual(
    toml.bin.map((b) => b.name),
    ['first', 'second'],
  );
  assert.throws(
    () => parseToml('[dependencies]\na = "1"\na = "2"\n', 'X.toml'),
    (e) => e instanceof ManifestError && /^X\.toml:3:\d+: /.test(e.message),
  );
  assert.throws(() => parseToml('a = "open\n'), ManifestError);
});

test('dependency declarations: renames, kinds, targets, workspace inheritance and active features', () =>
  withDir((dir) => {
    write(
      path.join(dir, 'Cargo.toml'),
      '[workspace]\nmembers = ["m"]\n[workspace.dependencies]\nfw = { package = "rnrs", version = "0.1", features = ["surface"] }\n',
    );
    crate(
      path.join(dir, 'm'),
      [
        '[dependencies]',
        'fw = { workspace = true }',
        'helper = { path = "../helper" }',
        '[dev-dependencies]',
        'rnrs = "0.1"',
        '[target.\'cfg(target_arch = "wasm32")\'.build-dependencies]',
        'rnrs-x = "0.1"',
        '[features]',
        'gpu = ["fw?/wgpu"]',
      ].join('\n'),
    );
    const m = readManifest(path.join(dir, 'm/Cargo.toml'));
    const by = Object.fromEntries(m.deps.map((d) => [`${d.kind}:${d.key}`, d]));
    assert.equal(by['normal:fw'].package, 'rnrs');
    assert.equal(by['normal:fw'].version, '0.1');
    assert.equal(by['normal:helper'].path, path.join(dir, 'helper'));
    assert.equal(by['dev:rnrs'].kind, 'dev');
    assert.equal(by['build:rnrs-x'].target, 'cfg(target_arch = "wasm32")');
    // Activation: default features only enable non-optional declarations' own features; the
    // unused `gpu` feature adds nothing until it is asked for.
    crate(path.join(dir, 'helper'), '', 'helper');
    crate(path.join(dir, 'fake-rnrs'), '[features]\nsurface = []\nwgpu = ["surface"]', 'rnrs');
    const rnrsAt = (name) => (name === 'rnrs' ? path.join(dir, 'fake-rnrs/Cargo.toml') : null);
    const rnrsFeatures = (options) =>
      [
        ...activeDependencies(path.join(dir, 'm/Cargo.toml'), {
          frameworkManifest: rnrsAt,
          ...options,
        }).crates.get(path.join(dir, 'fake-rnrs/Cargo.toml')).features,
      ].sort();
    assert.deepEqual(rnrsFeatures({}), ['default', 'surface']);
    assert.deepEqual(rnrsFeatures({ features: ['gpu'] }), ['default', 'surface', 'wgpu']);
    const enabled = (options) =>
      activeDependencies(path.join(dir, 'm/Cargo.toml'), options)
        .enabled.map((e) => `${e.decl.kind}:${e.decl.key}`)
        .sort();
    assert.deepEqual(enabled({}), ['build:rnrs-x', 'normal:fw', 'normal:helper']);
    assert.deepEqual(enabled({ dev: true }), [
      'build:rnrs-x',
      'dev:rnrs',
      'normal:fw',
      'normal:helper',
    ]);
    crate(path.join(dir, 'lost'), '[dependencies]\nrnrs = { workspace = true }');
    assert.throws(
      () => readManifest(path.join(dir, 'lost/Cargo.toml')),
      /lost\/Cargo\.toml: the crate is inside the workspace .* but is not one of its members/,
    );
  }));

test('the generated interface names rnrs-core through the dependency the crate declares', () =>
  withDir((dir) => {
    const core = (body) => interfaceCore(crate(dir, body));
    assert.equal(core('[dependencies]\nrnrs-core = "0.1"'), 'rnrs_core');
    assert.equal(core('[dependencies]\nrnrs = "0.1"'), 'rnrs::core');
    assert.equal(core('[dependencies]\nfw = { package = "rnrs", version = "0.1" }'), 'fw::core');
    assert.equal(core('[dependencies.my-core]\npackage = "rnrs-core"\nversion = "0.1"'), 'my_core');
    // Both: rnrs-core, so crates that add rnrs keep their generated interface.
    assert.equal(core('[dependencies]\nrnrs = "0.1"\nrnrs-core = "0.1"'), 'rnrs_core');
    // A conditional rnrs-core does not win over an unconditional rnrs.
    assert.equal(
      core('[dependencies]\nrnrs = "0.1"\nrnrs-core = { version = "0.1", optional = true }'),
      'rnrs::core',
    );
    assert.throws(
      () => core('[dependencies]\nrnrs = { version = "0.1", optional = true }'),
      /rnrs is optional; the generated interface uses it on every target, so declare it unconditionally: add rnrs = "0\.1" to \[dependencies\]/,
    );
    assert.throws(
      () =>
        core(
          '[target.\'cfg(target_os = "android")\'.dependencies]\nfw = { package = "rnrs", version = "0.1" }',
        ),
      /fw \(package rnrs\) is declared only for cfg\(target_os = "android"\)/,
    );
    assert.throws(
      () => core('[dependencies]\nrnr-core = "0.1"'),
      /the crate must depend on the framework: add rnrs = "0\.1" to \[dependencies\] \(it depends on rnr-core, which was renamed rnrs-core; depend on rnrs or rnrs-core instead\)/,
    );
    assert.throws(
      () => core('[dev-dependencies]\nrnrs = "0.1"'),
      /the crate must depend on the framework: add rnrs = "0\.1" to \[dependencies\]/,
    );
    assert.throws(
      () => core('[dependencies]\ncore = { package = "rnrs", version = "0.1" }'),
      /named core, which the generated interface cannot use as a path root/,
    );
    assert.throws(
      () => core('[dependencies]\nrnrs = { version = "0.1"'),
      /while looking for the module's rnrs dependency/,
    );
    // Requirements are checked against the framework crate the module uses.
    crate(dir, '[dependencies]\nfw = { package = "rnrs", version = "0.2" }');
    assert.throws(
      () => checkCoreRequirement({ cratePath: dir }),
      /rnrs requirement "0\.2" is not satisfied by this framework's rnrs 0\.1\.0; use rnrs = "0\.1"/,
    );
    crate(dir, '[dependencies]\nrnrs = { path = "../rnrs" }');
    assert.doesNotThrow(() => checkCoreRequirement({ cratePath: dir }));
    // The emitted imports use that path.
    const { ir } = parseSpec(path.join(ROOT, 'packages/counter/counter.spec.ts'), {
      frameworkSpec: FRAMEWORK_SPEC,
      root: ROOT,
    });
    const out = emitInterface(ir, { core: 'fw::core' });
    assert.match(out, /^use fw::core::bind::\{MaybeSend, NativeObject\};$/m);
    assert.match(out, /^use fw::core::\{CancelToken, Native\};$/m);
    assert.doesNotMatch(out, /rnrs_core/);
  }));

/** node_modules/<name>: a copy of packages/counter whose crate depends on the framework through
 *  `requirement` instead of rnrs-core, plus `extra` manifest text. */
function moduleWith(app, name, { crate: crateName, requirement, extra = '' }) {
  const dir = path.join(app, 'node_modules', name);
  cpSync(path.join(ROOT, 'packages/counter'), dir, {
    recursive: true,
    // Only exclude the package's generated wrapper, not an ancestor checkout named rnrs.
    filter: (src) =>
      path.relative(path.join(ROOT, 'packages/counter'), src).split(path.sep)[0] !== 'rnrs',
  });
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  manifest.name = name;
  manifest.rustNative.rust.crate = crateName;
  manifest.rustNative.targets = ['android', 'web'];
  json(path.join(dir, 'package.json'), manifest);
  const toml = path.join(dir, 'rust/Cargo.toml');
  write(
    toml,
    readFileSync(toml, 'utf8')
      .replace(/^name = "[^"]+"/m, `name = "${crateName}"`)
      .replace(/^rnrs-core = "0\.1"\n/m, `${requirement}\n`) + extra,
  );
  return dir;
}

function app(dir, deps) {
  json(path.join(dir, 'package.json'), {
    name: 'app',
    dependencies: Object.fromEntries(deps.map((d) => [d, '1'])),
  });
  return dir;
}

test('the bundle patches rnrs only when a module crate, or a crate it reaches by path, uses it', () =>
  withDir((dir) => {
    app(dir, ['plain']);
    moduleWith(dir, 'plain', { crate: 'plain_mod', requirement: 'rnrs-core = "0.1"' });
    const patchOf = () => {
      const { crateDir } = generateBundle(dir, 'android', path.join(dir, '.rnrs/android'));
      return readFileSync(path.join(crateDir, 'Cargo.toml'), 'utf8').split('[patch.crates-io]')[1];
    };
    assert.equal(usesRnrs(selectModules(dir, 'android')), false);
    assert.doesNotMatch(
      patchOf(),
      /^rnrs = /m,
      'an unused patch would invalidate existing app locks',
    );
    // A path helper crate inside the module package depends on rnrs: patched.
    write(
      path.join(dir, 'node_modules/plain/helper/Cargo.toml'),
      '[package]\nname = "helper"\nversion = "0.1.0"\n\n[dependencies]\nrnrs = "0.1"\n',
    );
    const toml = path.join(dir, 'node_modules/plain/rust/Cargo.toml');
    write(
      toml,
      readFileSync(toml, 'utf8').replace(
        /^\[dependencies\]\n/m,
        '[dependencies]\nhelper = { path = "../helper" }\n',
      ),
    );
    assert.equal(usesRnrs(selectModules(dir, 'android')), true);
    assert.match(
      patchOf(),
      new RegExp(`^rnrs = \\{ path = ${JSON.stringify(path.join(ROOT, 'rust/rnrs'))} \\}$`, 'm'),
    );
  }));

test('an rnrs feature whose library package is not installed is refused before cargo runs, however it is enabled', () =>
  withDir((dir) => {
    const refused = (how) =>
      assert.throws(
        () => selectModules(dir, 'android'),
        (error) =>
          error instanceof BundleError &&
          new RegExp(
            `app -> r: its crate ${how}, which no installed package provides \\(rnrs-\\* and rnr-\\* crates are never taken from crates.io\\); add @rnrs/surface to the app's dependencies`,
          ).test(error.message),
      );
    app(dir, ['r']);
    moduleWith(dir, 'r', {
      crate: 'r_mod',
      requirement: 'rnrs = { version = "0.1", features = ["surface"] }',
    });
    refused(`enables rnrs's "surface" feature, which needs rnrs-surface`);
    // Through the crate's own feature table, under a rename.
    moduleWith(dir, 'r', {
      crate: 'r_mod',
      requirement: 'fw = { package = "rnrs", version = "0.1" }',
      extra: '\n[features]\ndefault = ["fw/surface"]\n',
    });
    refused(`enables rnrs's "surface" feature, which needs rnrs-surface`);
    // Through a path dependency.
    moduleWith(dir, 'r', {
      crate: 'r_mod',
      requirement: 'rnrs = "0.1"\nhelper = { path = "../helper" }',
    });
    write(
      path.join(dir, 'node_modules/r/helper/Cargo.toml'),
      '[package]\nname = "helper"\nversion = "0.1.0"\n\n[dependencies]\nrnrs = { version = "0.1", features = ["surface"] }\n',
    );
    refused(`enables rnrs's "surface" feature \\(through helper\\), which needs rnrs-surface`);
    // Reached from default through another feature: refused too.
    moduleWith(dir, 'r', {
      crate: 'r_mod',
      requirement: 'rnrs = "0.1"',
      extra: '\n[features]\ndefault = ["gpu"]\ngpu = ["rnrs/surface"]\n',
    });
    refused(`enables rnrs's "surface" feature, which needs rnrs-surface`);
    // An optional feature nothing enables needs no package (the bundle builds default features).
    moduleWith(dir, 'r', {
      crate: 'r_mod',
      requirement: 'rnrs = "0.1"',
      extra: '\n[features]\ngpu = ["rnrs/surface"]\n',
    });
    assert.deepEqual(
      selectModules(dir, 'android').map((p) => p.crate),
      ['r_mod'],
    );
    // Nor does a disabled optional rnrs with surface: it is not resolved, so it is not patched.
    moduleWith(dir, 'r', {
      crate: 'r_mod',
      requirement:
        'rnrs-core = "0.1"\nrnrs = { version = "0.1", optional = true, features = ["surface"] }',
    });
    assert.equal(usesRnrs(selectModules(dir, 'android')), false);
    // Headless use of rnrs needs no library package.
    moduleWith(dir, 'r', { crate: 'r_mod', requirement: 'rnrs = "0.1"' });
    assert.deepEqual(
      selectModules(dir, 'android').map((p) => p.crate),
      ['r_mod'],
    );
  }));

test("cargo's failure to find a framework crate (reached through a registry crate) is explained", () => {
  const stderr =
    'error: no matching package named `rnrs` found\nlocation searched: crates.io index\nrequired by package `helper v1.0.0`\n';
  assert.match(
    explainMissing(stderr),
    /rnrs is a framework crate, never taken from crates.io: rnrs is provided by @rnrs\/runtime .* depend on rnrs from the module crate itself\.\n$/,
  );
  assert.match(
    explainMissing('error: no matching package named `rnrs-surface` found\n'),
    /rnrs-surface comes from @rnrs\/surface: add it to the app's dependencies \(it is needed, for example, by rnrs's "surface" feature\)/,
  );
  const other = 'error: no matching package named `serde_x` found\n';
  assert.equal(explainMissing(other), other);
});

test('the manifest reader fails closed on shapes it could misread', () =>
  withDir((dir) => {
    // Syntax errors (smol-toml's) name the file, line and column.
    const toml = (text) => parseToml(text, 'X.toml');
    for (const [text, at] of [
      ['[dependencies]\na = "1"\n[dependencies]\nb = "1"\n', '3'],
      ['a = "1"\n[a.b]\n', '2'],
      ['[[bin]]\n[bin]\n', '2'],
      ['a = "\\uD800"\n', '1'],
      ['a = { b = "1" \n', '2'],
      ['[dependencies] x = 1\n', '1'],
    ])
      assert.throws(
        () => toml(text),
        (e) =>
          e instanceof ManifestError &&
          new RegExp(`^X\\.toml:${at}:\\d+: \\S`).test(e.message) &&
          !e.message.includes('\n'),
        JSON.stringify(text),
      );
    const read = (body) => readManifest(crate(dir, body) && path.join(dir, 'Cargo.toml'));
    for (const [body, why] of [
      ['[dependencies]\nrnrs = true', /dependencies\.rnrs must be a version string or a table/],
      ['[dependencies]\nrnrs = ["0.1"]', /dependencies\.rnrs must be a version string or a table/],
      ['[dependencies]\nfw = { package = 1 }', /dependencies\.fw\.package must be a string/],
      [
        '[dependencies]\nrnrs = { version = "0.1", optional = "yes" }',
        /dependencies\.rnrs\.optional must be true or false/,
      ],
      [
        '[dependencies]\nrnrs = { version = "0.1", features = "surface" }',
        /dependencies\.rnrs\.features must be an array of strings/,
      ],
      ['[[dependencies]]\nrnrs = "0.1"', /\[dependencies\] must be a table/],
      ['[features]\ngpu = "rnrs/surface"', /features\.gpu must be an array of strings/],
      ['[target]\n\'cfg(unix)\' = "x"', /target\.cfg\(unix\) must be a table/],
    ])
      assert.throws(
        () => read(body),
        (e) => e instanceof ManifestError && why.test(e.message),
        body,
      );
  }));

test('every Cargo manifest in the repository reads', () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', 'target', '.generated', '.git', '.rnrs'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'Cargo.toml') files.push(p);
    }
  };
  walk(ROOT);
  assert.ok(files.length > 20);
  for (const f of files) assert.doesNotThrow(() => readManifest(f), f);
});

test('prototype-named keys are ordinary keys and never touch Object.prototype', () =>
  withDir((dir) => {
    const m = readManifest(
      crate(
        dir,
        [
          '[package.metadata."__proto__"]',
          'optional = true',
          '[package.metadata.constructor]',
          'x = 1',
          '[dependencies]',
          'rnrs = "0.1"',
          'toString = "1"',
          'constructor = { version = "1", "__proto__" = { optional = true } }',
          'hasOwnProperty = { version = "1", features = ["__proto__"] }',
          '[features]',
          'constructor = []',
          '__proto__ = ["toString"]',
          'valueOf = ["dep:constructor"]',
        ].join('\n'),
      ).cratePath + '/Cargo.toml',
    );
    assert.equal(Object.prototype.optional, undefined, 'Object.prototype unchanged');
    assert.equal({}.optional, undefined);
    const by = Object.fromEntries(m.deps.map((d) => [d.key, d]));
    assert.equal(by.rnrs.optional, false);
    assert.equal(by.toString.version, '1');
    assert.equal(by.constructor.optional, false, 'a __proto__ field is not an inherited optional');
    assert.deepEqual(by.hasOwnProperty.features, ['__proto__']);
    assert.deepEqual(Object.keys(m.features).sort(), ['__proto__', 'constructor', 'valueOf']);
    assert.equal(interfaceCore({ cratePath: dir }), 'rnrs::core');
    const toml = parseToml('"__proto__" = "a"\n[toString]\nconstructor = 1\n');
    assert.equal(Object.getPrototypeOf(toml), null);
    assert.equal(toml.__proto__, 'a');
    assert.equal(toml.toString.constructor, 1);
  }));

test('values keep their TOML types, so numbers and dates are never read as strings', () =>
  withDir((dir) => {
    const t = parseToml(
      '\ufeffa = 1979-05-27 07:32:00Z\nb = 1979-05-27\nc = 07:32:00\nd = """x""""\ne = 1_000\nf = -3.5e2\ng = 9007199254740993\nh = "1"\n',
    );
    for (const k of ['a', 'b', 'c']) assert.equal(t[k].constructor.name, 'TomlDate', k);
    assert.equal(t.d, 'x"');
    assert.deepEqual(
      [t.e, t.f, t.g, t.h],
      [1000, -350, 9007199254740993n, '1'],
      'integers are never rounded',
    );
    // A TOML 1.1 one-line-or-not inline table is read as written (cargo decides whether to accept it).
    assert.deepEqual(plain(parseToml('a = { b = 1,\n c = "x" }\n').a), { b: 1, c: 'x' });
    // Valid: sub-tables of a dotted-key table, and a header defining an implicit table.
    assert.equal(
      parseToml('[fruit]\napple.color = "red"\n[fruit.apple.texture]\nsmooth = true\n').fruit.apple
        .texture.smooth,
      true,
    );
    assert.equal(parseToml('[a.b]\nx = 1\n[a]\ny = 2\n').a.y, 2);
    // Refused, not merged: a dotted key followed by the same table header.
    assert.throws(
      () =>
        parseToml(
          '[dependencies]\nrnrs.version = "0.1"\n[dependencies.rnrs]\nfeatures = []\n',
          'X.toml',
        ),
      /^Error: X\.toml:3:\d+: /,
    );
    // Typed fields: a number or date where cargo wants a string is refused with its path.
    for (const [body, why] of [
      ['[dependencies]\nrnrs = 0.1', /dependencies\.rnrs must be a version string or a table/],
      [
        '[dependencies]\nrnrs = { version = 1979-05-27 }',
        /dependencies\.rnrs\.version must be a string/,
      ],
      [
        '[dependencies]\nrnrs = { version = "0.1", optional = 1 }',
        /dependencies\.rnrs\.optional must be true or false/,
      ],
    ])
      assert.throws(
        () => readManifest(crate(dir, body) && path.join(dir, 'Cargo.toml')),
        why,
        body,
      );
  }));

test('workspace = true follows the workspace cargo would use, or is refused', () =>
  withDir((dir) => {
    const ws = (body) =>
      write(
        path.join(dir, 'Cargo.toml'),
        `[workspace]\n${body}\n[workspace.dependencies]\nrnrs = { version = "0.1", features = ["surface"] }\n`,
      );
    const member = crate(path.join(dir, 'crates/m'), '[dependencies]\nrnrs = { workspace = true }');
    const read = () => readManifest(path.join(member.cratePath, 'Cargo.toml')).deps[0];
    ws('members = ["crates/*"]');
    assert.deepEqual(read().features, ['surface']);
    ws('members = ["crates/**"]');
    assert.deepEqual(read().features, ['surface']);
    ws('members = ["other"]');
    assert.throws(
      read,
      /the crate is inside the workspace .*Cargo\.toml but is not one of its members; cargo would refuse to build it: add it to workspace\.members, or to workspace\.exclude/,
    );
    ws('members = ["other"]\nexclude = ["crates"]');
    assert.throws(
      read,
      /rnrs = \{ workspace = true \} has no \[workspace\.dependencies\] entry rnrs in an enclosing workspace \(none found\)/,
    );
    ws('members = ["crates/[m]"]');
    assert.throws(read, /the workspace pattern crates\/\[m\] is not supported here/);
    // An implicit member: a path dependency of the root package.
    write(
      path.join(dir, 'Cargo.toml'),
      '[package]\nname = "root"\nversion = "0.1.0"\n[dependencies]\nm = { path = "crates/m" }\n[workspace]\n[workspace.dependencies]\nrnrs = "0.1"\n',
    );
    assert.equal(read().version, '0.1');
    // package.workspace names a root elsewhere (and the nearer one is ignored).
    write(
      path.join(dir, 'elsewhere/Cargo.toml'),
      '[workspace]\nmembers = ["../crates/m"]\n[workspace.dependencies]\nrnrs = "0.1.0"\n',
    );
    write(
      path.join(member.cratePath, 'Cargo.toml'),
      '[package]\nname = "m"\nversion = "0.1.0"\nworkspace = "../../elsewhere"\n[dependencies]\nrnrs = { workspace = true }\n',
    );
    assert.equal(read().version, '0.1.0');
    write(
      path.join(member.cratePath, 'Cargo.toml'),
      '[package]\nname = "m"\nversion = "0.1.0"\nworkspace = "../../nowhere"\n[dependencies]\nrnrs = { workspace = true }\n',
    );
    assert.throws(
      read,
      /package\.workspace = "\.\.\/\.\.\/nowhere" does not name a workspace root/,
    );
    // Fields that cargo refuses next to workspace = true.
    write(
      path.join(member.cratePath, 'Cargo.toml'),
      '[package]\nname = "m"\nversion = "0.1.0"\n[dependencies]\nrnrs = { workspace = true, version = "0.1" }\n',
    );
    assert.throws(read, /dependencies\.rnrs: version cannot be combined with workspace = true/);
  }));

test('every framework declaration must be satisfiable, not only the one the interface uses', () =>
  withDir((dir) => {
    crate(dir, '[dependencies]\nrnrs-core = "0.1"\nrnrs = "0.2"');
    assert.throws(
      () => checkCoreRequirement({ cratePath: dir }),
      /dependency rnrs: rnrs requirement "0\.2" is not satisfied by this framework's rnrs 0\.1\.0/,
    );
    crate(
      dir,
      '[dependencies]\nrnrs = "0.1"\n[dev-dependencies]\nfw = { package = "rnrs", version = "1" }',
    );
    assert.throws(
      () => checkCoreRequirement({ cratePath: dir }),
      /dev-dependency fw \(package rnrs\): rnrs requirement "1"/,
    );
    crate(
      dir,
      '[dependencies]\nrnrs = "0.1"\n[target.\'cfg(unix)\'.dependencies]\nrnrs-core = "0.3"',
    );
    assert.throws(
      () => checkCoreRequirement({ cratePath: dir }),
      /dependency rnrs-core for cfg\(unix\): rnrs-core requirement "0\.3"/,
    );
    crate(dir, '[dependencies]\nrnrs = "0.1"\nrnrs-core = { path = "../core" }');
    assert.doesNotThrow(() => checkCoreRequirement({ cratePath: dir }));
  }));

test('cargo test feature flags are read as cargo reads them', () => {
  assert.deepEqual(
    cargoFeatureFlags([
      '--release',
      '--features',
      'a,b c',
      '-F',
      'd',
      '--features=e',
      '-Ff',
      '--',
      '--features',
      'no',
    ]),
    {
      features: ['a', 'b', 'c', 'd', 'e', 'f'],
      allFeatures: false,
      noDefault: false,
    },
  );
  assert.deepEqual(cargoFeatureFlags(['--all-features', '--no-default-features']), {
    features: [],
    allFeatures: true,
    noDefault: true,
  });
});

test('rnrs test patches what cargo test builds: dev-dependencies and the requested features', () =>
  withDir((dir) => {
    const pkg = moduleWith(dir, 'p', {
      crate: 'p_mod',
      requirement: 'rnrs = "0.1"',
      extra: '\n[features]\ngpu = ["rnrs/surface"]\n',
    });
    write(path.join(pkg, 'rust/src/rnrs_interface.rs'), ''); // regenerated by rnrs test
    const log = path.join(dir, 'args.json');
    const cargo = path.join(dir, 'cargo');
    write(
      cargo,
      `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(cargo, 0o755);
    const patched = () =>
      JSON.parse(readFileSync(log, 'utf8'))
        .filter((a) => a.startsWith('patch.'))
        .map((a) => a.split('.')[2]);
    assert.equal(testPackage(pkg, [], { cargo }), 0);
    assert.deepEqual(patched(), ['rnrs-core', 'rnrs']);
    // --features gpu enables rnrs/surface: it needs @rnrs/surface, which is not installed.
    assert.throws(
      () => testPackage(pkg, ['--features', 'gpu'], { cargo }),
      /the crate enables rnrs's "surface" feature, which needs rnrs-surface, which comes from @rnrs\/surface; install it next to the package \(npm install --save-dev @rnrs\/surface@0\.1\.0\)/,
    );
    // A dev-dependency enabling it is built by cargo test too.
    const toml = path.join(pkg, 'rust/Cargo.toml');
    write(
      toml,
      readFileSync(toml, 'utf8').replace(
        '[dev-dependencies]\n',
        '[dev-dependencies]\nfw = { package = "rnrs", version = "0.1", features = ["surface"] }\n',
      ),
    );
    assert.throws(
      () => testPackage(pkg, [], { cargo }),
      /enables rnrs's "surface" feature, which needs rnrs-surface, which comes from @rnrs\/surface/,
    );
    // With the library installed, it is patched to the installed copy.
    cpSync(
      path.join(ROOT, 'packages/surface/package.json'),
      path.join(dir, 'node_modules/@rnrs/surface/package.json'),
      { recursive: true },
    );
    cpSync(
      path.join(ROOT, 'packages/surface/rust'),
      path.join(dir, 'node_modules/@rnrs/surface/rust'),
      { recursive: true },
    );
    assert.equal(testPackage(pkg, [], { cargo }), 0);
    assert.deepEqual(patched(), ['rnrs-core', 'rnrs', 'rnrs-surface']);
    // An rnrs-* crate nobody provides is named, not left to crates.io.
    write(
      toml,
      readFileSync(toml, 'utf8').replace(
        '[dev-dependencies]\n',
        '[dev-dependencies]\nrnrs-mystery = "0.1"\n',
      ),
    );
    assert.throws(
      () => testPackage(pkg, [], { cargo }),
      /the crate depends on rnrs-mystery, which neither @rnrs\/runtime nor a known library package provides/,
    );
  }));

// Real cargo, when available, for the activation and workspace subsets: path-only layouts, so
// `cargo metadata --offline` needs no registry.
const cargoBin = process.env.RNRS_CARGO ?? 'cargo';
const noCargo = spawnSync(cargoBin, ['--version']).status === 0 ? false : 'cargo is not available';
function cargoMetadata(manifest, args = []) {
  const r = spawnSync(
    cargoBin,
    ['metadata', '--format-version', '1', '--offline', '--manifest-path', manifest, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, CARGO_TARGET_DIR: path.join(path.dirname(manifest), 'target') },
    },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
/** crate name -> sorted package names of its enabled (non-dev) dependencies, per cargo. */
function cargoEnabled(manifest, args) {
  const m = cargoMetadata(manifest, args);
  const name = new Map(m.packages.map((p) => [p.id, p.name]));
  return Object.fromEntries(
    m.resolve.nodes.map((n) => [
      name.get(n.id),
      n.deps
        .filter((d) => d.dep_kinds.some((k) => k.kind !== 'dev'))
        .map((d) => name.get(d.pkg))
        .sort(),
    ]),
  );
}
/** The same from activeDependencies. */
function ourEnabled(manifest, options) {
  const out = {};
  for (const { manifest: m } of activeDependencies(manifest, options).crates.values())
    out[m.name] ??= [];
  for (const { from, decl } of activeDependencies(manifest, options).enabled)
    out[from.name].push(decl.package);
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

test('activation: dep: suppresses only the implicit feature of the dependency it names (cargo 1.90 repro)', () =>
  withDir((dir) => {
    crate(path.join(dir, 'x'), '', 'x');
    crate(path.join(dir, 'helper'), '', 'helper');
    crate(
      path.join(dir, 'm'),
      '[features]\ndefault = ["x"]\nother = ["dep:helper"]\n[dependencies]\nx = { path = "../x", optional = true }\nhelper = { path = "../helper", optional = true }\n[workspace]',
    );
    const m = path.join(dir, 'm/Cargo.toml');
    assert.deepEqual(ourEnabled(m), { m: ['x'], x: [] });
    assert.deepEqual(ourEnabled(m, { features: ['other'] }), {
      m: ['helper', 'x'],
      x: [],
      helper: [],
    });
    // As a module: x = rnrs with surface is enabled by default, so it is patched and needs @rnrs/surface.
    app(dir, ['r']);
    moduleWith(dir, 'r', {
      crate: 'r_mod',
      requirement:
        'rnrs-core = "0.1"\nrnrs = { version = "0.1", optional = true, features = ["surface"] }\nhelper = { path = "../../../helper", optional = true }',
      extra: '\n[features]\ndefault = ["rnrs"]\nother = ["dep:helper"]\n',
    });
    assert.throws(
      () => selectModules(dir, 'android'),
      /app -> r: its crate enables rnrs's "surface" feature, which needs rnrs-surface/,
    );
  }));

test('activation matches cargo metadata on path-only layouts', { skip: noCargo }, () =>
  withDir((dir) => {
    crate(path.join(dir, 'x'), '', 'x');
    crate(path.join(dir, 'helper'), '', 'helper');
    crate(
      path.join(dir, 'y'),
      '[features]\nextra = ["dep:deep"]\n[dependencies]\ndeep = { path = "../deep", optional = true }',
      'y',
    );
    crate(path.join(dir, 'deep'), '', 'deep');
    crate(path.join(dir, 'z'), '[features]\nf = []', 'z');
    crate(
      path.join(dir, 'm'),
      [
        '[features]',
        'default = ["x", "a"]',
        'other = ["dep:helper"]',
        'a = ["y/extra"]',
        'b = ["z?/f"]',
        'c = ["z/f"]',
        '[dependencies]',
        'x = { path = "../x", optional = true }',
        'helper = { path = "../helper", optional = true }',
        'y = { path = "../y", optional = true }',
        'z = { path = "../z", optional = true }',
        '[workspace]',
      ].join('\n'),
    );
    const m = path.join(dir, 'm/Cargo.toml');
    for (const [options, args] of [
      [{}, []],
      [{ features: ['other'] }, ['--features', 'other']],
      [{ features: ['b'] }, ['--features', 'b']],
      [{ features: ['c'] }, ['--features', 'c']],
      [{ noDefault: true }, ['--no-default-features']],
      [{ allFeatures: true }, ['--all-features']],
    ])
      assert.deepEqual(ourEnabled(m, options), cargoEnabled(m, args), JSON.stringify(args));
  }),
);

test('workspace = true in an implicit member reached from a glob member (cargo 1.90 repro)', () =>
  withDir((dir) => {
    write(
      path.join(dir, 'Cargo.toml'),
      '[workspace]\nmembers = ["packages/*"]\nresolver = "2"\n[workspace.dependencies]\nx = { path = "x" }\n',
    );
    crate(path.join(dir, 'x'), '', 'x');
    crate(
      path.join(dir, 'packages/a'),
      '[dependencies]\nhelp = { path = "../../shared/help" }',
      'a',
    );
    crate(path.join(dir, 'shared/help'), '[dependencies]\nx = { workspace = true }', 'help');
    const help = readManifest(path.join(dir, 'shared/help/Cargo.toml'));
    assert.equal(help.deps[0].path, path.join(dir, 'x'));
    if (!noCargo) {
      const meta = cargoMetadata(path.join(dir, 'Cargo.toml'));
      const members = meta.packages
        .filter((p) => meta.workspace_members.includes(p.id))
        .map((p) => p.name)
        .sort();
      assert.deepEqual(members, ['a', 'help', 'x']);
    }
    // Not reachable from any member: still refused.
    crate(path.join(dir, 'shared/lonely'), '[dependencies]\nx = { workspace = true }', 'lonely');
    assert.throws(
      () => readManifest(path.join(dir, 'shared/lonely/Cargo.toml')),
      /is not one of its members/,
    );
  }));
