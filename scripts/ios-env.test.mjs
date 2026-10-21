// The iOS bundle script phase (packages/runtime/ios/build-rust-bundle.sh) sources the app's
// ios/.xcode.env and .xcode.env.local like React Native's own loader does: user lines that read
// unset variables or run a missing optional nvm.sh must not abort it. Runs with a stub node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve('packages/runtime/ios/build-rust-bundle.sh');
// Absolute bash from the caller's PATH: the test's own PATH is deliberately minimal.
const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();

function run({ xcodeEnv, xcodeEnvLocal, env = {} }) {
  const app = mkdtempSync(path.join(tmpdir(), 'rnrs-ios-env-'));
  try {
    mkdirSync(path.join(app, 'ios/Pods'), { recursive: true });
    const stub = path.join(app, 'stub-node');
    const argsFile = path.join(app, 'args.txt');
    writeFileSync(stub, `#!${BASH}\nprintf '%s\\n' "$@" > "${argsFile}"\n`);
    chmodSync(stub, 0o755);
    if (xcodeEnv !== undefined)
      writeFileSync(path.join(app, 'ios/.xcode.env'), xcodeEnv.replaceAll('$STUB', stub));
    if (xcodeEnvLocal !== undefined)
      writeFileSync(
        path.join(app, 'ios/.xcode.env.local'),
        xcodeEnvLocal.replaceAll('$STUB', stub),
      );
    const result = spawnSync(BASH, [SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: '/nonexistent',
        HOME: app,
        PODS_ROOT: path.join(app, 'ios/Pods'),
        PODS_TARGET_SRCROOT: '/framework',
        PLATFORM_NAME: 'iphoneos',
        ARCHS: 'arm64',
        ...env,
      },
    });
    let args = null;
    try {
      args = readFileSync(argsFile, 'utf8').trim().split('\n');
    } catch {}
    return { status: result.status, stderr: result.stderr, args, app };
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}

test('unset NVM_BIN and a missing optional nvm.sh in .xcode.env do not abort the script phase', () => {
  const r = run({
    xcodeEnv: '. "/nonexistent/nvm/nvm.sh" --no-use\nexport NODE_BINARY=$NVM_BIN/node\n',
    xcodeEnvLocal: 'export NODE_BINARY=$STUB\n',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.args, [
    '/framework/cli/run.mjs',
    'build',
    '--target',
    'ios',
    '--app',
    path.dirname(path.dirname(path.join(r.app, 'ios/Pods'))),
    '--sdk',
    'iphoneos',
    '--arch',
    'arm64',
  ]);
});

test('strict mode is restored after sourcing, and architectures are comma-separated', () => {
  const r = run({
    xcodeEnvLocal: 'export NODE_BINARY=$STUB\n',
    env: { ARCHS: 'arm64 x86_64', PLATFORM_NAME: 'iphonesimulator' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.args.slice(-4), ['--sdk', 'iphonesimulator', '--arch', 'arm64,x86_64']);
});

test('no usable node is an actionable error', () => {
  const r = run({ xcodeEnv: 'export NODE_BINARY=$NVM_BIN/node\n', env: { PATH: '/nonexistent' } });
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /rnrs: node not found \(NODE_BINARY='\/node'\); set NODE_BINARY in ios\/\.xcode\.env\.local/,
  );
});
