// Run from the repository root after npm ci, inside nix develop .#web with scripts/rust-env.sh sourced.
import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadPackage, plan, writeAtomic } from '../../tools/rnrs-gen/cli.mjs';
import { buildBundle } from '../../tools/rnrs-gen/bundle.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = fileURLToPath(new URL('.', import.meta.url));
process.chdir(root);
for (const [name, dir] of [
  ['@rnrs/surface', 'surface'],
  ['@rnrs/example-vello2d', 'vello2d'],
]) {
  const link = path.join(root, 'node_modules', name),
    source = path.join(root, 'packages', dir);
  mkdirSync(path.dirname(link), { recursive: true });
  if (!existsSync(link)) symlinkSync(source, link, 'dir');
  else if (realpathSync(link) !== realpathSync(source))
    throw new Error('Unexpected installed package at ' + link);
}
for (const out of plan([loadPackage(path.join(root, 'packages/vello2d'))])) {
  if (!out.committed && out.file.endsWith('/index.ts')) writeAtomic(out.file, out.content);
}
buildBundle(fixture, 'web', {
  out: path.join(fixture, 'rnrs'),
  locked: true,
  offline: process.env.RNRS_OFFLINE !== '0',
});
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
if (process.argv.includes('--test'))
  run('node', ['scripts/web-test.mjs', path.join(fixture, 'result.json')], {
    ...process.env,
    RNRS_WEB_ROOT: fixture,
  });
