// Run from the repository root after npm ci, inside nix develop .#web with scripts/rust-env.sh sourced.
// --test runs three browser cases: the default launch (WebGPU unavailable: expects a terminal
// unsupported error, no fallback), the test-only SwiftShader launch (software WebGPU), and the
// rnrs::gpu reentrancy and setup-interleaving checks in a SwiftShader launch of their own.
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadPackage, plan, writeAtomic } from '../../tools/rnrs-gen/cli.mjs';
import { buildBundle, lockFile } from '../../tools/rnrs-gen/bundle.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = fileURLToPath(new URL('.', import.meta.url));
process.chdir(root);
const packages = [
  ['@rnrs/surface', 'surface'],
  ['@rnrs/example-vello2d', 'vello2d'],
  ['@rnrs/labs-webgpu-triangle', 'fixtures/webgpu-triangle'],
];
for (const [name, dir] of packages) {
  const link = path.join(root, 'node_modules', name),
    source = path.join(root, 'packages', dir);
  mkdirSync(path.dirname(link), { recursive: true });
  if (!existsSync(link)) symlinkSync(source, link, 'dir');
  else if (realpathSync(link) !== realpathSync(source))
    throw new Error('Unexpected installed package at ' + link);
}
for (const dir of ['vello2d', 'fixtures/webgpu-triangle']) {
  for (const out of plan([loadPackage(path.join(root, 'packages', dir))])) {
    if (!out.committed && out.file.endsWith('/index.ts')) writeAtomic(out.file, out.content);
  }
}
// The reentrancy checks use rnrs-surface's lab-only test hooks (feature lab-hooks), which no
// package enables; this fixture's bundle does, unless --default-exports builds it as an app would
// (then the hook must be absent; only the build and that check run).
const defaultExports = process.argv.includes('--default-exports');
if (!defaultExports) process.env.RNR_BUNDLE_FEATURES ??= 'rnrs-surface/lab-hooks';
buildBundle(fixture, 'web', {
  out: path.join(fixture, 'rnr'),
  locked: existsSync(lockFile(fixture, 'web')),
  offline: process.env.RNR_OFFLINE !== '0',
});
const bindings = readFileSync(path.join(fixture, 'rnr/pkg/rnr_bundle.js'), 'utf8');
const hasHook = /export function rnr_surface_hold_gpu_setups_for_testing\b/.test(bindings);
if (hasHook === defaultExports)
  throw new Error(
    `rnr_surface_hold_gpu_setups_for_testing is ${hasHook ? 'exported' : 'missing'} in a ${defaultExports ? 'default' : 'lab'} build`,
  );
console.log(
  `exports: rnr_surface_hold_gpu_setups_for_testing ${hasHook ? 'present (lab build)' : 'absent (default build)'}`,
);
if (defaultExports) process.exit(0);
const run = (cmd, args, env = process.env) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(cmd + ' exited ' + result.status);
};
run('esbuild', [
  path.join(fixture, 'main.ts'),
  '--bundle',
  '--format=esm',
  '--target=es2022',
  '--outfile=' + path.join(fixture, 'dist/main.js'),
]);
if (process.argv.includes('--test')) {
  const env = { ...process.env, RNR_WEB_ROOT: fixture };
  run('node', ['scripts/web-test.mjs', path.join(fixture, 'result-unsupported.json')], {
    ...env,
    RNR_WEB_QUERY: 'expect=unsupported',
  });
  run('node', ['scripts/web-test.mjs', path.join(fixture, 'result-swiftshader.json')], {
    ...env,
    RNR_WEB_QUERY: 'expect=webgpu',
    RNR_WEB_UNSAFE_WEBGPU: '1',
  });
  // Hook reentrancy and setup interleaving (rnrs::gpu), in a fresh browser.
  run('node', ['scripts/web-test.mjs', path.join(fixture, 'result-reentrancy.json')], {
    ...env,
    RNR_WEB_QUERY: 'expect=reentrancy',
    RNR_WEB_UNSAFE_WEBGPU: '1',
  });
}
