// Run from the repository root after npm ci (root) and npm ci in this fixture, inside
// nix develop .#web, with the isolated Bevy toolchain (Bevy 0.20 needs Rust 1.97.1):
//   RUSTUP_HOME=$PWD/.generated/rust-1.97.1/rustup CARGO_HOME=$PWD/.generated/rust-1.97.1/cargo \
//   RUSTUP_TOOLCHAIN=1.97.1 node fixtures/web-bevy/build.mjs [--test]
// The app is fixtures/bevy-consumer/App.tsx and smoke.ts, copied unchanged (hash-checked) and
// rendered with React Native Web. --test runs the default launch (WebGPU unavailable) and the
// test-only SwiftShader launch (software WebGPU; setup and lifecycle only).
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadPackage, plan, writeAtomic } from '../../tools/rnrs-gen/cli.mjs';
import { buildBundle, lockFile } from '../../tools/rnrs-gen/bundle.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = fileURLToPath(new URL('.', import.meta.url));
const app = path.join(fixture, 'bundle');
process.chdir(root);
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (cmd, args, env = process.env) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(cmd + ' exited ' + result.status);
};
for (const [name, dir] of [
  ['@rnrs/surface', 'surface'],
  ['@rnrs/example-bevy3d', 'bevy3d'],
]) {
  const link = path.join(root, 'node_modules', name),
    source = path.join(root, 'packages', dir);
  mkdirSync(path.dirname(link), { recursive: true });
  if (!existsSync(link)) symlinkSync(source, link, 'dir');
  else if (realpathSync(link) !== realpathSync(source))
    throw new Error('Unexpected installed package at ' + link);
}
for (const out of plan([loadPackage(path.join(root, 'packages/bevy3d'))])) {
  if (!out.committed && out.file.endsWith('/index.ts')) writeAtomic(out.file, out.content);
}
// The consumer app, unchanged.
const sources = {};
mkdirSync(path.join(fixture, '.generated/app'), { recursive: true });
for (const file of ['App.tsx', 'smoke.ts']) {
  const from = path.join(root, 'fixtures/bevy-consumer', file),
    to = path.join(fixture, '.generated/app', file);
  copyFileSync(from, to);
  if (hash(from) !== hash(to)) throw new Error('consumer source copy differs: ' + file);
  sources[file] = hash(to);
}
buildBundle(app, 'web', {
  out: path.join(fixture, 'rnr'),
  locked: existsSync(lockFile(app, 'web')),
  offline: process.env.RNR_OFFLINE !== '0',
});
// Aliases resolve from the working directory: one React (the fixture's) for react-dom,
// react-native-web and the @rnr packages; react-native is React Native Web.
const npm = path.relative(root, path.join(fixture, 'node_modules'));
run('esbuild', [
  path.join(fixture, 'main.tsx'),
  '--bundle',
  '--format=esm',
  '--target=es2022',
  '--conditions=browser',
  `--alias:react=./${npm}/react`,
  `--alias:react-dom=./${npm}/react-dom`,
  `--alias:react-native=./${npm}/react-native-web`,
  `--alias:@rnrs/example-bevy3d=./.generated/rnr/rnrs_bevy3d/index.ts`,
  '--define:process.env.NODE_ENV="development"',
  '--outfile=' + path.join(fixture, 'dist/main.js'),
]);
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const info = {
  commit: git(['rev-parse', 'HEAD']),
  dirty: git(['status', '--porcelain', '--untracked-files=no']) !== '', // tracked changes only (results are written here)
  rustc: execFileSync('rustc', ['-V'], { encoding: 'utf8' }).trim(),
  wasmSha256: hash(path.join(fixture, 'rnr/pkg/rnr_bundle_bg.wasm')),
  mainJsSha256: hash(path.join(fixture, 'dist/main.js')),
  consumerSources: sources,
};
writeFileSync(path.join(fixture, 'dist/build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log('build', JSON.stringify(info));
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
    RNR_WEB_TIMEOUT_MS: '120000',
  });
}
