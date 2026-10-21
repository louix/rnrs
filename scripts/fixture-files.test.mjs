// scripts/consumer/fixture-files.sh (FIXTURE_FILES for rn-app.sh): only plain JS/TS names from
// directly inside the fixture are copied; escapes, globs, reserved names and symlinks are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'consumer/fixture-files.sh',
);

function copy(names, setup = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'rnrs-fixture-files-'));
  try {
    const fixture = path.join(root, 'fixtures/x');
    const app = path.join(root, 'app');
    mkdirSync(fixture, { recursive: true });
    mkdirSync(app);
    writeFileSync(path.join(fixture, 'game.ts'), 'export {};\n');
    writeFileSync(path.join(fixture, 'util.tsx'), 'export {};\n');
    writeFileSync(path.join(root, 'fixtures/secret.ts'), 'outside\n');
    writeFileSync(path.join(fixture, 'metro.config.js'), 'module.exports = {};\n');
    setup(fixture, root);
    const r = spawnSync(
      'bash',
      ['-c', `source "${HELPER}" && copy_fixture_files "$1" "$2" "$3"`, 'x', fixture, app, names],
      { encoding: 'utf8', cwd: fixture },
    );
    return {
      status: r.status,
      stderr: r.stderr,
      copied: ['game.ts', 'util.tsx', 'secret.ts', 'metro.config.js', 'link.ts'].filter((f) =>
        existsSync(path.join(app, f)),
      ),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('plain names inside the fixture are copied; empty is a no-op', () => {
  assert.deepEqual(copy('game.ts util.tsx'), {
    status: 0,
    stderr: '',
    copied: ['game.ts', 'util.tsx'],
  });
  assert.deepEqual(copy(''), { status: 0, stderr: '', copied: [] });
});

test('path escapes, globs, other extensions and reserved names are refused before anything is copied', () => {
  for (const names of [
    '../secret.ts',
    'sub/game.ts',
    '*.ts',
    'game.ts *',
    'game.sh',
    'metro.config.js',
    'App.tsx',
    'smoke.ts',
    'package.json',
    'index.js',
    '.babelrc.js',
    'app.tsx',
    'APP.TSX',
    'Smoke.ts',
    'Package.JSON',
    'Metro.Config.js',
  ]) {
    const r = copy(`game.ts ${names}`);
    assert.equal(r.status, 1, names);
    assert.deepEqual(r.copied, [], `${names}: nothing copied`);
  }
});

test('symlinks and missing files are refused', () => {
  const linked = copy('link.ts', (fixture, root) =>
    symlinkSync(path.join(root, 'fixtures/secret.ts'), path.join(fixture, 'link.ts')),
  );
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /no symlinks/);
  assert.equal(copy('missing.ts').status, 1);
});
