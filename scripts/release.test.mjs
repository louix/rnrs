import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  PUBLIC,
  REPOSITORY_URL,
  ReleaseError,
  cargoAllows,
  checkTag,
  checkTarballs,
  frameworkDeps,
  integrity,
  readTarball,
  registryState,
  verifyArtifacts,
  versionLiterals,
  writeArtifacts,
} from './release.mjs';

/** A gzipped ustar archive of { path: content } under package/. */
function tarball(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0);
    header.write('0000644\0', 100);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('0', 156);
    header.write('ustar\0' + '00', 257);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const LICENSE = 'MIT License\n';
function manifests(version = '1.2.3') {
  const common = {
    version,
    license: 'MIT',
    repository: { type: 'git', url: REPOSITORY_URL },
    publishConfig: { access: 'public' },
  };
  return {
    '@rnrs/cli': {
      name: '@rnrs/cli',
      ...common,
      dependencies: { 'smol-toml': '1.9.0' },
      peerDependencies: { '@rnrs/runtime': version },
    },
    '@rnrs/runtime': {
      name: '@rnrs/runtime',
      ...common,
      dependencies: { '@rnrs/cli': version },
      peerDependencies: { 'react-native': '^0.88.0' },
    },
    '@rnrs/surface': {
      name: '@rnrs/surface',
      ...common,
      peerDependencies: { '@rnrs/runtime': version, 'react-native': '^0.88.0' },
      peerDependenciesMeta: { 'react-native': { optional: true } },
    },
  };
}
function packages(edit = () => {}, extra = {}) {
  const ms = manifests();
  edit(ms);
  return Object.values(ms).map((m) => {
    const bytes = tarball({
      'package.json': JSON.stringify(m),
      LICENSE,
      'README.md': '# x\n',
      ...extra[m.name],
    });
    return {
      file: `${m.name.slice(1).replace('/', '-')}-${m.version}.tgz`,
      bytes,
      files: readTarball(bytes),
      manifest: m,
    };
  });
}
const rejects = (pkgs, re) => assert.throws(() => checkTarballs(pkgs, LICENSE), re);

test('cargo requirements', () => {
  for (const [req, v, ok] of [
    ['0.1', '0.1.0', true],
    ['0.1', '0.1.7', true],
    ['0.1', '0.2.0', false],
    ['0.1.2', '0.1.1', false],
    ['^0.1.0', '0.1.9', true],
    ['=0.1.0', '0.1.0', true],
    ['=0.1.0', '0.1.1', false],
    ['1', '1.4.0', true],
    ['1.2', '2.0.0', false],
    ['0.0.3', '0.0.4', false],
    ['~0.1.2', '0.1.5', true],
    ['~0.1.2', '0.2.0', false],
    ['>=0.1, <0.2', '0.1.0', false], // unsupported: reported, never silently accepted
  ])
    assert.equal(cargoAllows(req, v), ok, `${req} vs ${v}`);
});

test('framework dependencies, including renamed and target-specific ones', () => {
  const deps = frameworkDeps({
    dependencies: { 'rnrs-core': '0.1', serde: '1', fw: { package: 'rnrs', version: '0.1' } },
    target: {
      'cfg(target_os = "android")': { dependencies: { 'rnrs-surface': { version: '0.1' } } },
    },
    'dev-dependencies': { rnrs: { path: '../rnrs' } },
  });
  assert.deepEqual(deps, [
    ['rnrs-core', '0.1'],
    ['rnrs', '0.1'],
    ['rnrs-surface', '0.1'],
  ]);
});

test('accepts the three framework tarballs', () => {
  assert.equal(checkTarballs(packages(), LICENSE), '1.2.3');
});

test('never releases another package, a private one or a partial set', () => {
  const labs = packages();
  const m = { ...labs[0].manifest, name: '@rnrs/example-counter', private: true };
  labs.push({ ...labs[0], manifest: m });
  rejects(labs, /exactly @rnrs\/cli, @rnrs\/runtime, @rnrs\/surface/);
  rejects(packages().slice(1), /exactly/);
  rejects(
    packages((ms) => (ms['@rnrs/surface'].private = true)),
    /@rnrs\/surface@1\.2\.3: private/,
  );
});

test('rejects mismatched versions and inter-package requirements', () => {
  rejects(
    packages((ms) => (ms['@rnrs/surface'].version = '1.2.4')),
    /version differs/,
  );
  rejects(
    packages((ms) => (ms['@rnrs/runtime'].dependencies['@rnrs/cli'] = '^1.2.3')),
    /depend on @rnrs\/cli 1\.2\.3 exactly/,
  );
  rejects(
    packages((ms) => (ms['@rnrs/cli'].peerDependencies['@rnrs/runtime'] = '1.2.2')),
    /@rnrs\/cli must peer-depend/,
  );
  rejects(
    packages((ms) => delete ms['@rnrs/surface'].peerDependenciesMeta),
    /optional peer/,
  );
});

test('rejects metadata the registry or trusted publishing would get wrong', () => {
  rejects(
    packages((ms) => (ms['@rnrs/cli'].license = 'UNLICENSED')),
    /license UNLICENSED/,
  );
  rejects(
    packages((ms) => (ms['@rnrs/cli'].repository.url = 'https://example.invalid')),
    /repository\.url/,
  );
  rejects(
    packages((ms) => delete ms['@rnrs/runtime'].publishConfig),
    /access is not public/,
  );
  rejects(
    packages((ms) => (ms['@rnrs/cli'].dependencies.typescript = '^6.0.3')),
    /not an exact version/,
  );
  rejects(
    packages((ms) => (ms['@rnrs/runtime'].scripts = { postinstall: 'x' })),
    /postinstall script/,
  );
});

test('rejects a missing or different LICENSE, a missing README and stale crate versions', () => {
  const pkgs = packages();
  pkgs[0].files = pkgs[0].files.filter((f) => f.path !== 'README.md');
  rejects(pkgs, /no README\.md/);
  assert.throws(() => checkTarballs(packages(), 'Apache'), /LICENSE differs/);
  const crate = {
    '@rnrs/runtime': {
      'rust/rnrs-core/Cargo.toml': '[package]\nname = "rnrs-core"\nversion = "1.2.2"\n',
    },
  };
  rejects(
    packages(() => {}, crate),
    /rust\/rnrs-core\/Cargo\.toml has version 1\.2\.2/,
  );
});

test('finds framework version literals in scripts and generator texts', () => {
  const text = [
    '"$P/rnrs-cli-0.1.0.tgz"',
    'tarballs+=("$C/../pack/rnrs-$m-0.1.0.tgz")',
    'for p in ${PACKS:-}; do tarballs+=("$C/../pack/$p-0.1.0.tgz"); done',
    "path.join(root, '.generated/pack', n + '-0.1.0.tgz')",
    'cp "$tarball" "$C/demo-crc-0.1.0.tgz"', // an author's own package: not the framework's
    'react-native-community-template-0.88.0.tgz',
    '# Modules depend on rnrs-core = "0.1" or rnrs = "0.1"',
  ].join('\n');
  assert.deepEqual(
    versionLiterals(text).map((l) => l.version ?? `req ${l.requirement}`),
    ['0.1.0', '0.1.0', '0.1.0', '0.1.0', 'req 0.1', 'req 0.1'],
  );
});

test('artifacts: tampering, renaming and the tag are verified', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rnrs-release-'));
  const pkgs = packages();
  for (const p of pkgs) writeFileSync(path.join(dir, p.file), p.bytes);
  const release = writeArtifacts(dir, pkgs, '1.2.3', 'abc', false);
  assert.equal(verifyArtifacts(dir).release.version, '1.2.3');
  checkTag(release, 'v1.2.3', 'abc');
  assert.throws(() => checkTag(release, 'v1.2.4', 'abc'), /does not match/);
  assert.throws(() => checkTag(release, 'v1.2.3', 'def'), /built from abc/);
  assert.throws(() => checkTag({ ...release, dirty: true }, 'v1.2.3'), /uncommitted/);
  writeFileSync(path.join(dir, pkgs[1].file), pkgs[0].bytes);
  assert.throws(() => verifyArtifacts(dir), ReleaseError);
});

test('registry state compares the exact tarball integrity', async () => {
  const pkgs = packages();
  const release = {
    version: '1.2.3',
    packages: PUBLIC.map(({ name }) => ({
      name,
      integrity: integrity(pkgs.find((p) => p.manifest.name === name).bytes),
    })),
  };
  const docs = {
    '@rnrs/cli': { versions: { '1.2.3': { dist: { integrity: release.packages[0].integrity } } } },
    '@rnrs/runtime': { versions: { '1.2.3': { dist: { integrity: 'sha512-other' } } } },
    '@rnrs/surface': null,
  };
  const states = await registryState(release, async (name) => docs[name]);
  assert.deepEqual(
    states.map((s) => s.state),
    ['identical', 'different', 'absent'],
  );
  const older = await registryState(release, async () => ({ versions: { '1.2.2': {} } }));
  assert.ok(older.every((s) => s.state === 'absent'));
});
