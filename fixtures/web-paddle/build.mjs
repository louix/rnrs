// Packaged-consumer verification. No workspace package aliases/symlinks.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../..', import.meta.url)),
  fixture = fileURLToPath(new URL('.', import.meta.url));
const run = (cmd, args, cwd = fixture, env = process.env) =>
  execFileSync(cmd, args, { cwd, env, stdio: 'inherit' });
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
run('node', [path.join(root, 'scripts/pack.mjs')], root);
mkdirSync(path.join(fixture, 'vendor'), { recursive: true });
const archives = [
  'rnrs-cli-0.3.0.tgz',
  'rnrs-runtime-0.3.0.tgz',
  'rnrs-surface-0.3.0.tgz',
  'rnrs-example-vello2d-0.3.0.tgz',
];
for (const archive of archives)
  copyFileSync(path.join(root, '.generated/pack', archive), path.join(fixture, 'vendor', archive));
run('npm', [
  'install',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  ...archives.map((a) => './vendor/' + a),
]);
for (const [name, file] of [
  ['@rnrs/surface', 'src/index.web.tsx'],
  ['@rnrs/runtime', 'src/runtime.ts'],
]) {
  const pkg = name === '@rnrs/surface' ? 'surface' : 'runtime';
  const installed = path.join(fixture, 'node_modules', name, file);
  if (
    !realpathSync(installed).startsWith(fixture) ||
    hash(installed) !== hash(path.join(root, 'packages', pkg, file))
  )
    throw new Error('Installed tarball does not match current source: ' + name);
}
const gameFiles = ['App.tsx', 'game.ts', 'contention.ts', 'smoke.ts'],
  sourceHashes = {};
mkdirSync(path.join(fixture, '.generated/game'), { recursive: true });
for (const file of gameFiles) {
  const from = path.join(root, 'fixtures/paddle-game', file),
    to = path.join(fixture, '.generated/game', file);
  copyFileSync(from, to);
  sourceHashes[file] = hash(to);
  if (hash(from) !== sourceHashes[file]) throw new Error('Game source copy differs');
}
const resolve = (name, ...conditions) =>
  path.relative(
    fixture,
    fileURLToPath(
      execFileSync(
        'node',
        [
          ...conditions.map((condition) => '--conditions=' + condition),
          '--input-type=module',
          '-e',
          'console.log(import.meta.resolve(' + JSON.stringify(name) + '))',
        ],
        { cwd: fixture, encoding: 'utf8' },
      ).trim(),
    ),
  );
const resolution = {
  browser: resolve('@rnrs/surface', 'browser'),
  native: resolve('@rnrs/surface', 'react-native'),
  both: resolve('@rnrs/surface', 'browser', 'react-native'),
};
if (
  !resolution.browser.endsWith('/src/index.web.tsx') ||
  !resolution.native.endsWith('/src/index.ts') ||
  !resolution.both.endsWith('/src/index.web.tsx')
)
  throw new Error('Package conditions selected unexpected files');
const runtimeResolution = {
  browser: resolve('@rnrs/runtime', 'browser'),
  native: resolve('@rnrs/runtime', 'react-native'),
  both: resolve('@rnrs/runtime', 'browser', 'react-native'),
};
if (
  !runtimeResolution.browser.endsWith('/src/web.ts') ||
  !runtimeResolution.native.endsWith('/src/native.ts') ||
  !runtimeResolution.both.endsWith('/src/web.ts')
)
  throw new Error('Runtime package conditions selected unexpected files');
if (!existsSync(path.join(fixture, 'rnrs-web.Cargo.lock')))
  copyFileSync(
    path.join(root, 'fixtures/web-surface/rnrs-web.Cargo.lock'),
    path.join(fixture, 'rnrs-web.Cargo.lock'),
  );
const { buildBundle } = await import(
  pathToFileURL(path.join(fixture, 'node_modules/@rnrs/cli/generator/bundle.mjs'))
);
buildBundle(fixture, 'web', {
  out: path.join(fixture, '.rnrs/web'),
  locked: true,
  offline: process.env.RNRS_OFFLINE !== '0',
});
run('node', [path.join(fixture, 'node_modules/typescript/bin/tsc'), '--noEmit']);
for (const conditions of ['browser', 'browser,react-native']) {
  run('esbuild', [
    'main.tsx',
    '--conditions=' + conditions,
    '--bundle',
    '--format=esm',
    '--target=es2022',
    '--alias:react-native=react-native-web',
    '--define:process.env.NODE_ENV="development"',
    '--outfile=dist/main.js',
    '--metafile=.generated/metafile.json',
  ]);
  const meta = JSON.parse(readFileSync(path.join(fixture, '.generated/metafile.json'), 'utf8'));
  for (const input of Object.keys(meta.inputs))
    if (!path.resolve(fixture, input).startsWith(fixture))
      throw new Error('Browser bundle escaped packaged consumer: ' + input);
  if (
    !Object.keys(meta.inputs).some((p) => p.endsWith('@rnrs/surface/src/index.web.tsx')) ||
    Object.keys(meta.inputs).some((p) => p.includes('RnrsSurfaceViewNativeComponent'))
  )
    throw new Error('Wrong SurfaceView entry in browser bundle: ' + conditions);
}
writeFileSync(
  path.join(fixture, 'provenance.json'),
  JSON.stringify(
    {
      sourceHashes,
      resolution,
      runtimeResolution,
      tarballs: Object.fromEntries(archives.map((a) => [a, hash(path.join(fixture, 'vendor', a))])),
      packageLock: hash(path.join(fixture, 'package-lock.json')),
      cargoLock: hash(path.join(fixture, 'rnrs-web.Cargo.lock')),
      packagedOnly: true,
      pins: { react: '19.3.0', reactDOM: '19.3.0', reactNativeWeb: '0.21.4' },
    },
    null,
    2,
  ) + '\n',
);
if (process.argv.includes('--test'))
  run('node', [path.join(root, 'scripts/web-test.mjs'), path.join(fixture, 'result.json')], root, {
    ...process.env,
    RNRS_WEB_ROOT: fixture,
    RNRS_WEB_DRIVER: path.join(fixture, 'driver.mjs'),
    RNRS_WEB_TIMEOUT_MS: '120000',
  });
