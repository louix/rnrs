// Run inside nix develop. All toolchains/builds stay in this worktree's .generated.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, '.generated/consumer');
const app = path.join(out, 'bevy-worklets');
const env = {
  ...process.env,
  RUSTUP_HOME: path.join(root, '.generated/rustup'),
  CARGO_HOME: path.join(root, '.generated/cargo'),
  RUSTUP_TOOLCHAIN: '1.97.1',
  GRADLE_USER_HOME: path.join(root, '.generated/gradle'),
};
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, env, stdio: 'inherit' });
const capture = (cmd, args) => execFileSync(cmd, args, { cwd: root, env, encoding: 'utf8' }).trim();
const head = capture('git', ['rev-parse', 'HEAD']);
const status = capture('git', ['status', '--porcelain=v1', '--untracked-files=all']);
if (status) throw new Error('commit source before building this evidence fixture');
mkdirSync(out, { recursive: true });
run('node', ['scripts/pack.mjs']);
const template = path.join(out, 'react-native-community-template-0.88.0.tgz');
if (!existsSync(template)) run('npm', ['pack', '@react-native-community/template@0.88.0'], out);
const unpack = path.join(out, 'bevy-worklets-template');
mkdirSync(unpack, { recursive: true });
run('tar', ['-xzf', template, '-C', unpack]);
if (!existsSync(app)) cpSync(path.join(unpack, 'package/template'), app, { recursive: true });
for (const file of ['App.tsx', 'babel.config.js'])
  cpSync(path.join(root, 'fixtures/bevy-worklets', file), path.join(app, file));
const gradle = path.join(app, 'android/build.gradle');
writeFileSync(
  gradle,
  readFileSync(gradle, 'utf8').replace('minSdkVersion = 24', 'minSdkVersion = 26'),
);
const pins = [
  'react-native-worklets@0.13.0',
  'react-native-reanimated@4.7.1',
  'react-native-gesture-handler@3.3.0',
];
run(
  'npm',
  [
    'install',
    '--no-audit',
    '--no-fund',
    '--save-exact',
    ...pins,
    ...['rnrs-cli', 'rnrs-runtime', 'rnrs-surface', 'rnrs-example-bevy3d'].map((n) =>
      path.join(root, '.generated/pack', n + '-0.2.0.tgz'),
    ),
  ],
  app,
);
for (const pin of pins) {
  const at = pin.lastIndexOf('@'),
    name = pin.slice(0, at),
    version = pin.slice(at + 1);
  if (
    JSON.parse(readFileSync(path.join(app, 'node_modules', name, 'package.json'))).version !==
    version
  )
    throw new Error('pin mismatch: ' + pin);
}
run('node', [path.join(app, 'node_modules/typescript/bin/tsc'), '--noEmit'], app);
run(
  './gradlew',
  [
    '--no-daemon',
    '--init-script',
    path.join(root, 'scripts/consumer/nix-sdk.init.gradle'),
    'assembleRelease',
    '-PreactNativeArchitectures=arm64-v8a',
  ],
  path.join(app, 'android'),
);
const apk = path.join(app, 'android/app/build/outputs/apk/release/app-release.apk');
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
// The only native-tree configuration change is the already-required Bevy minSdk 26.
const reference = path.join(unpack, 'package/template');
writeFileSync(
  path.join(reference, 'android/build.gradle'),
  readFileSync(path.join(reference, 'android/build.gradle'), 'utf8').replace(
    'minSdkVersion = 24',
    'minSdkVersion = 26',
  ),
);
for (const tree of ['android', 'ios'])
  run('diff', [
    '-r',
    '-q',
    '--exclude=build',
    '--exclude=.gradle',
    '--exclude=.cxx',
    '--exclude=.kotlin',
    '--exclude=local.properties',
    path.join(reference, tree),
    path.join(app, tree),
  ]);
writeFileSync(
  path.join(out, 'bevy-worklets.build.json'),
  JSON.stringify(
    {
      sourceHead: head,
      sourceClean: true,
      apkSha256: hash(apk),
      templateSha256: hash(template),
      pins,
      androidMinSdk: 26,
      nativeTreesOtherwiseIdentical: true,
      rust: capture('rustc', ['--version']),
    },
    null,
    2,
  ) + '\n',
);
console.log(apk);
