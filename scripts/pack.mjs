// Builds npm tarballs (no publishing) for the framework and the module packages:
//   @rnrs/runtime: staged from its canonical sources (packages/rnr-runtime incl. cpp/ and ios/,
//                 rust/rnr-{core,android,web,log}, rust/rnrs) into one self-contained package.
//   @rnrs/cli:     the rnrs CLI, staged from packages/rnr-cli and the generator (tools/rnr-gen).
//   modules:      `rnrs pack-js` writes each package's JS wrapper, then `npm pack` (its
//                 package.json `files` list) takes manifest, spec, Rust crate and wrapper.
//   @rnrs/surface: framework rendering surface (Rust library package + Android view), `npm pack`.
// Each tarball's file list is checked. Output: .generated/pack/*.tgz (or $RNR_PACK_OUT)
// Usage (inside `nix develop`): node scripts/pack.mjs
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// RNR_PACK_OUT: another output directory (tests pack into a scratch directory).
const OUT = process.env.RNR_PACK_OUT
  ? path.resolve(process.env.RNR_PACK_OUT)
  : path.join(ROOT, '.generated/pack');
const STAGE = path.join(OUT, 'stage');
const MODULES = [
  'counter',
  'blake3',
  'meter',
  'values',
  'http',
  'kv',
  'bench',
  'fixtures/log-probe',
  'fixtures/worklets-probe',
  'fixtures/teardown-probe',
  'fixtures/touch-probe',
  'fixtures/webgpu-triangle',
  'vello2d',
  'bevy3d',
];
const sh = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, encoding: 'utf8' });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// --- @rnrs/runtime --------------------------------------------------------------------
const rt = path.join(STAGE, 'rnr-runtime');
const copy = (from, to, filter) =>
  cpSync(path.join(ROOT, from), path.join(rt, to), { recursive: true, filter });
copy('packages/rnr-runtime/package.json', 'package.json');
copy('packages/rnr-runtime/react-native.config.js', 'react-native.config.js');
copy('packages/rnr-runtime/src', 'src');
copy('packages/rnr-runtime/cli', 'cli');
copy('packages/rnr-runtime/android/build.gradle', 'android/build.gradle');
copy('packages/rnr-runtime/android/CMakeLists.txt', 'android/CMakeLists.txt');
copy('packages/rnr-runtime/android/src', 'android/src');
copy('packages/rnr-runtime/cpp', 'cpp');
copy('packages/rnr-runtime/ios', 'ios');
copy('packages/rnr-runtime/RnrRuntime.podspec', 'RnrRuntime.podspec');
for (const crate of ['rnr-core', 'rnr-android', 'rnr-web', 'rnr-log', 'rnrs']) {
  copy(`rust/${crate}/Cargo.toml`, `rust/${crate}/Cargo.toml`);
  copy(`rust/${crate}/src`, `rust/${crate}/src`);
}
// rnr-log compiles its Apple unified-logging writer (src/apple_log.c) in a build script.
copy('rust/rnr-log/build.rs', 'rust/rnr-log/build.rs');

function pack(dir) {
  const json = JSON.parse(
    sh('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', OUT], dir),
  );
  return json[0];
}

function expectFiles(name, files, allowed) {
  const bad = files.filter((f) => !allowed.some((re) => re.test(f)));
  if (bad.length)
    throw new Error(`${name}: unexpected files in the tarball:\n  ${bad.join('\n  ')}`);
}

const results = [];
const runtime = pack(rt);
expectFiles(
  '@rnrs/runtime',
  runtime.files.map((f) => f.path),
  [
    /^package\.json$/,
    /^react-native\.config\.js$/,
    /^src\/[\w-]+\.ts$/,
    /^src\/specs\/NativeRnrRuntime\.ts$/,
    /^cli\/run\.mjs$/,
    /^rust\/(rnr-(core|android|web|log)|rnrs)\/(Cargo\.toml|src\/[\w/-]+\.rs)$/,
    /^rust\/rnr-log\/(build\.rs|src\/apple_log\.c)$/,
    /^android\/(build\.gradle|CMakeLists\.txt)$/,
    /^android\/src\/main\/(java\/dev\/rustjsilab\/rnr\/\w+\.kt|jni\/\w+\.(cpp|h))$/,
    /^cpp\/\w+\.(cpp|h)$/,
    /^ios\/(\w+\.(h|mm)|build-rust-bundle\.sh)$/,
    /^RnrRuntime\.podspec$/,
  ],
);
results.push(runtime);

// --- @rnrs/cli: the bin and the generator, nothing else (the framework spec and Rust crates
// are its peer @rnrs/runtime's).
const cli = path.join(STAGE, 'rnr-cli');
cpSync(path.join(ROOT, 'packages/rnr-cli/package.json'), path.join(cli, 'package.json'));
cpSync(path.join(ROOT, 'packages/rnr-cli/bin'), path.join(cli, 'bin'), { recursive: true });
mkdirSync(path.join(cli, 'generator'), { recursive: true });
for (const f of readdirSync(path.join(ROOT, 'tools/rnr-gen')).filter((f) => f.endsWith('.mjs')))
  cpSync(path.join(ROOT, 'tools/rnr-gen', f), path.join(cli, 'generator', f));
const cliPack = pack(cli);
expectFiles(
  '@rnrs/cli',
  cliPack.files.map((f) => f.path),
  [/^package\.json$/, /^bin\/rnrs\.mjs$/, /^generator\/[\w-]+\.mjs$/],
);
results.push(cliPack);

// --- @rnrs/surface: a Rust library package (no spec, no JS wrapper) with an Android library
// whose JNI entry points are Rust (no C++ or CMake of its own), and an iOS pod (the Fabric
// component view; its C entry points are Rust too).
const surface = pack(path.join(ROOT, 'packages/rnr-surface'));
expectFiles(
  '@rnrs/surface',
  surface.files.map((f) => f.path),
  [
    /^package\.json$/,
    /^react-native\.config\.js$/,
    /^src\/index(?:\.web)?\.tsx?$/,
    /^src\/browser\/[\w-]+\.ts$/,
    /^src\/specs\/RnrSurfaceViewNativeComponent\.ts$/,
    /^rust\/Cargo\.toml$/,
    /^rust\/src\/(\w+\/)*\w+\.rs$/,
    /^android\/(build\.gradle|consumer-rules\.pro)$/,
    /^android\/src\/main\/java\/dev\/rustjsilab\/rnr\/surface\/\w+\.kt$/,
    /^ios\/\w+\.(h|mm)$/,
    /^RnrSurface\.podspec$/,
  ],
);
results.push(surface);

// --- module packages: only manifest, spec, Rust crate (with its committed interface) and
// the generated JS wrapper.
for (const m of MODULES) {
  const dir = path.join(ROOT, 'packages', m);
  sh('node', [path.join(ROOT, 'packages/rnr-cli/bin/rnrs.mjs'), 'pack-js', dir]);
  const info = pack(dir);
  expectFiles(
    info.name,
    info.files.map((f) => f.path),
    [
      /^package\.json$/,
      /^[\w-]+\.spec\.ts$/,
      /^shared\.ts$/,
      /^frame\.ts$/,
      /^rust\/Cargo\.toml$/,
      /^rust\/src\/[\w/-]+\.rs$/,
      /^rnr\/(index|web)\.ts$/,
    ],
  );
  if (!info.files.some((f) => f.path === 'rust/src/rnr_interface.rs'))
    throw new Error(`${info.name}: committed interface missing`);
  if (info.files.some((f) => /glue|bundle/.test(f.path)))
    throw new Error(`${info.name}: generated glue must not be packaged`);
  results.push(info);
}

for (const r of results)
  console.log(
    `${r.filename}  ${r.files.length} files, ${r.size} bytes  (${r.files
      .map((f) => f.path)
      .filter(
        (p) => !p.startsWith('src/') && !p.startsWith('generator/') && !p.startsWith('rust/rnr'),
      )
      .join(', ')})`,
  );
if (!existsSync(path.join(OUT, results[0].filename))) throw new Error('pack failed');
