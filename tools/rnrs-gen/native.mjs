// Binary-first native distribution (Android, iOS and web).
//
// Publisher (`rnrs build-native`, Rust required): builds one module package into sealed static
// archives, one per Android ABI, plus `rnrs/native/manifest.json`, all shipped in the npm package.
// A sealed archive holds one relocatable object in which only the module's table symbol
// (`rnrs_module_v2_<crate>`, packages/runtime/cpp/RnrsAbi.h) is global: std, Tokio, the framework
// backend and the module's dependencies are local to it, so several prebuilt modules (and one
// unsealed source bundle) link into one library without symbol collisions. Each keeps its own
// Rust runtime and executor.
//
// App (`rnrs link`, run by `rnrs build` from Gradle; Node only, never cargo): checks every
// module's manifest against this framework (ABI, symbol, spec IR, shipped Rust sources, ABIs,
// minSdk), then writes the C++ registry (`rnrs_registry.inc`) and the archives to link
// (`modules.cmake`). Modules listed in the app's `rustNativeApp.sourceBuild` are compiled from
// their installed sources into the app's source bundle instead (cargo required), and their
// prebuilt archives are not linked. Nothing falls back silently in either direction.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  FRAMEWORK_CRATES,
  FRAMEWORK_RUST,
  RUNTIME_DIR,
  loadPackage,
  plan,
  writeAtomic,
} from './cli.mjs';
import {
  ANDROID_TRIPLES,
  BundleError,
  checkWasmBindgen,
  wasmBindgenVersion,
  iosCargoEnv,
  NATIVE_ABI,
  NATIVE_SURFACE_ABI,
  checkRustTarget,
  frameworkNeeds,
  resolve,
  run,
  selectModules,
  tableSymbol,
  writeBundleCrate,
} from './bundle.mjs';

export const MANIFEST = 'rnrs/native/manifest.json';
/** Targets with prebuilt surface modules (the others build them from source). */
export const SURFACE_TARGETS = ['android', 'ios', 'web'];
/** The lowest Android API level prebuilt archives are built for (React Native's minimum). */
export const ANDROID_MIN_SDK = 24;
/** System libraries a sealed Android archive may need (checked when it is built). */
export const ANDROID_LINK_LIBRARIES = ['log', 'dl', 'm'];
/** What a sealed iOS surface binary links against (wgpu's Metal backend and rnrs-surface): the
 *  seal check links with exactly these, the manifest records them and the RnrsRuntime pod passes
 *  them to the app target with the slices. Headless modules need only libSystem. */
export const IOS_SURFACE_FRAMEWORKS = [
  'Metal',
  'QuartzCore',
  'CoreGraphics',
  'CoreFoundation',
  'Foundation',
];
export const IOS_SURFACE_LIBRARIES = ['objc'];
const CLANG_PREFIX = {
  'arm64-v8a': 'aarch64-linux-android',
  'armeabi-v7a': 'armv7a-linux-androideabi',
  x86: 'i686-linux-android',
  x86_64: 'x86_64-linux-android',
};

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

/** Every file of the module's crate directory as installed (relative to the package, POSIX
 *  separators), except build output. These are what a source build would compile. */
function crateFiles(pkg) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'target') walk(file);
      } else out.push(posix(path.relative(pkg.dir, file)));
    }
  };
  walk(pkg.cratePath);
  return out.sort();
}

/** Hashes `dir`'s Cargo.toml and src/ tree (sorted, paths relative to `base`) into `hash`. */
function hashCrate(hash, dir, base) {
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const file = path.join(d, entry.name);
      if (entry.isDirectory()) walk(file);
      else hash.update(`${posix(path.relative(base, file))}\0`).update(readFileSync(file));
    }
  };
  hash
    .update(`${posix(path.relative(base, path.join(dir, 'Cargo.toml')))}\0`)
    .update(readFileSync(path.join(dir, 'Cargo.toml')));
  walk(path.join(dir, 'src'));
}

/** One hash over the framework Rust sources compiled into every prebuilt binary (rnrs-core,
 *  rnrs-android, rnrs): binaries of two targets are only combined when it is equal. */
function frameworkHash() {
  const hash = createHash('sha256');
  for (const crate of ['rnrs-core', 'rnrs-android', 'rnrs'])
    hashCrate(hash, path.join(FRAMEWORK_RUST, crate), FRAMEWORK_RUST);
  return hash.digest('hex');
}

/** The hash of one library crate's sources (the rnrs-surface copy a surface module embeds). */
function crateHash(dir) {
  const hash = createHash('sha256');
  hashCrate(hash, dir, dir);
  return hash.digest('hex');
}

/** The @rnrs/surface library package a surface module is built with: the one its package
 *  resolves (its dependency), as an app would install it. */
function surfaceLibrary(pkgDir) {
  let manifest;
  try {
    manifest = createRequire(path.join(pkgDir, 'package.json')).resolve(
      '@rnrs/surface/package.json',
    );
  } catch {
    throw new BundleError(
      `${pkgDir}: its crate needs rnrs-surface, but @rnrs/surface is not installed for it; add it to the package's dependencies and install them`,
    );
  }
  const lib = loadPackage(path.dirname(manifest));
  if (!lib.library || lib.crate !== 'rnrs-surface')
    throw new BundleError(`${path.dirname(manifest)} does not provide the rnrs-surface crate`);
  lib.chain = ['@rnrs/surface'];
  return lib;
}

/** The files `npm pack` puts in the package's tarball (relative, POSIX separators). */
function packedFiles(pkgDir) {
  const out = capture('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: pkgDir });
  return JSON.parse(out)[0].files.map((f) => f.path);
}

/** The Android NDK's LLVM bin directory: `ndk` if given, else ANDROID_NDK_HOME/ANDROID_NDK_ROOT,
 *  else the newest NDK under ANDROID_HOME/ANDROID_SDK_ROOT. */
export function ndkBin(ndk, env = process.env) {
  let root = ndk ?? env.ANDROID_NDK_HOME ?? env.ANDROID_NDK_ROOT;
  if (!root) {
    const sdk = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
    const versions =
      sdk && existsSync(path.join(sdk, 'ndk')) ? readdirSync(path.join(sdk, 'ndk')).sort() : [];
    if (versions.length) root = path.join(sdk, 'ndk', versions.at(-1));
  }
  if (!root)
    throw new BundleError(
      'no Android NDK found: pass --ndk DIR or set ANDROID_NDK_HOME (or ANDROID_HOME with an ndk/ directory)',
    );
  const host = process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
  const bin = path.join(root, 'toolchains/llvm/prebuilt', host, 'bin');
  if (!existsSync(path.join(bin, 'ld.lld')))
    throw new BundleError(`${root} is not an Android NDK (no ${bin}/ld.lld)`);
  return bin;
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...options });
  if (result.error || result.status !== 0)
    throw new BundleError(
      `${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`,
    );
  return result.stdout;
}

/** Seals the staticlib `raw` into `archive`: one object, debug info stripped (function symbols
 *  stay, as local symbols), `symbol` the only global definition, and every undefined symbol
 *  resolvable by `libraries` (checked by linking it into a throwaway shared library with
 *  --no-undefined). The same object with its debug info is kept in `work` (`*.debug.o`) for the
 *  publisher's own records; it is not shipped. */
export function sealAndroid({ bin, raw, symbol, archive, clang, libraries, work }) {
  mkdirSync(work, { recursive: true });
  const linked = path.join(work, 'linked.o');
  const sealed = path.join(work, `${path.basename(archive, '.a')}.o`);
  run(path.join(bin, 'ld.lld'), ['-r', '-u', symbol, '-o', linked, raw]);
  run(path.join(bin, 'llvm-objcopy'), [
    `--keep-global-symbol=${symbol}`,
    linked,
    sealed.replace(/\.o$/, '.debug.o'),
  ]);
  run(path.join(bin, 'llvm-objcopy'), [
    '--strip-debug',
    `--keep-global-symbol=${symbol}`,
    linked,
    sealed,
  ]);
  const globals = capture(path.join(bin, 'llvm-nm'), [
    '-g',
    '--defined-only',
    '--format=just-symbols',
    sealed,
  ])
    .split('\n')
    .filter(Boolean);
  if (globals.length !== 1 || globals[0] !== symbol)
    throw new BundleError(
      `sealing ${raw}: expected only ${symbol} to stay global, found ${globals.length}: ${globals.slice(0, 10).join(', ')}`,
    );
  run(clang, [
    '-shared',
    '-nostdlib++',
    '-Wl,--no-undefined',
    '-o',
    path.join(work, 'check.so'),
    sealed,
    ...libraries.map((l) => `-l${l}`),
  ]);
  rmSync(archive, { force: true });
  mkdirSync(path.dirname(archive), { recursive: true });
  run(path.join(bin, 'llvm-ar'), ['rcs', archive, sealed]);
}

/** Before any binary of `target` changes: drops `target`'s manifest entry (atomically), then its
 *  binaries. Old metadata can therefore never describe partially replaced binaries: an app that
 *  meets a package between the two steps, or after a failed build, finds no entry for `target`
 *  and refuses it. The other target's entry stays for a retry. */
export function invalidateTarget(pkgDir, target) {
  const file = path.join(pkgDir, MANIFEST);
  if (existsSync(file)) {
    const { [target]: dropped, ...rest } = readJson(file);
    if (dropped) writeAtomic(file, JSON.stringify(rest, null, 2) + '\n');
  }
  rmSync(path.join(pkgDir, 'rnrs/native', target), { recursive: true, force: true });
}

/** Publisher: builds the module package in `pkgDir` for `target` (android: `abis`; ios: device
 *  arm64 and simulator `simArchs`) and writes its prebuilt binaries and manifest under
 *  `<pkgDir>/rnrs/native/`, replacing every earlier binary of that target. The other target's
 *  binaries are kept only if they were built from the same sources, lock, spec and framework
 *  (Android is built on any host, iOS only on macOS); otherwise they are removed, so the
 *  manifest never lists a binary of other sources. */
export function buildNative(
  pkgDir,
  {
    target = 'android',
    abis = ANDROID_ABIS,
    simArchs = ['arm64', 'x86_64'],
    ndk,
    cargo = process.env.RNRS_CARGO ?? 'cargo',
    offline = false,
  } = {},
) {
  if (!['android', 'ios', 'web'].includes(target))
    throw new BundleError(`build-native: --target must be android, ios or web`);
  const pkg = loadPackage(pkgDir);
  pkg.chain = [readJson(path.join(pkgDir, 'package.json')).name];
  if (pkg.library)
    throw new BundleError(`${pkg.manifestPath}: a library package has no module to prebuild`);
  if (!pkg.targets.includes(target))
    throw new BundleError(`${pkg.manifestPath}: rustNative.targets does not include ${target}`);
  // A module may need rnrs-surface: each binary carries its own copy, reached by the app's
  // surface host through the module table (RnrsAbi.h RnrsSurfaceV1). Any other library crate
  // would share Rust state with other binaries, so such a module stays source-built.
  const needs = frameworkNeeds(pkg);
  const shared = [...needs].filter(
    ([name]) => !FRAMEWORK_CRATES.includes(name) && name !== 'rnrs' && name !== 'rnrs-surface',
  );
  if (shared.length)
    throw new BundleError(
      `${pkg.manifestPath}: its crate ${shared.map(([, why]) => why).join('; ')}; only modules without framework library crates other than rnrs-surface can be prebuilt (apps build this one with rustNativeApp.sourceBuild)`,
    );
  if (needs.has('rnrs-surface') && !SURFACE_TARGETS.includes(target))
    throw new BundleError(
      `${pkg.manifestPath}: prebuilt surface modules are implemented for ${SURFACE_TARGETS.join(', ')} only; on ${target} apps build this one with rustNativeApp.sourceBuild`,
    );
  const surface = needs.has('rnrs-surface') ? surfaceLibrary(pkgDir) : null;
  const libraries = surface ? [surface] : [];
  const nativeDir = path.join(pkgDir, 'rnrs/native');
  const lock = path.join(nativeDir, 'Cargo.lock');
  const previous = existsSync(path.join(pkgDir, MANIFEST))
    ? readJson(path.join(pkgDir, MANIFEST))
    : null;
  invalidateTarget(pkgDir, target);
  const work = path.join(pkgDir, '.rnrs/native-build');
  writeAtomic(
    path.join(pkgDir, '.rnrs/.gitignore'),
    '# Generated by rnrs build-native; never commit.\n*\n',
  );
  const { crateDir } = writeBundleCrate({
    modules: [pkg],
    libraries,
    target,
    outDir: work,
    logging: null,
    lock,
  });
  const manifest = path.join(crateDir, 'Cargo.toml');
  const hadLock = existsSync(lock);
  const env = target === 'ios' ? iosCargoEnv() : process.env;
  if (target === 'web') checkWasmBindgen(process.env.RNRS_WASM_BINDGEN ?? 'wasm-bindgen');
  const resolved = resolve(manifest, cargo, { locked: hadLock, offline, env, libraries });
  if (!resolved.ok)
    throw new BundleError(
      `cargo could not resolve ${pkg.crate}'s dependencies:\n${resolved.stderr.trim()}`,
    );
  const build = {
    pkg,
    pkgDir,
    nativeDir,
    work,
    manifest,
    cargo,
    symbol: tableSymbol(pkg.crate),
    ident: pkg.crate.replace(/-/g, '_'),
    cargoArgs: [...(hadLock ? ['--locked'] : []), ...(offline ? ['--offline'] : [])],
    surface,
  };
  const section =
    target === 'android'
      ? buildAndroid(build, { abis, ndk })
      : target === 'ios'
        ? buildIos(build, { simArchs, env })
        : buildWeb(build);
  section.rustc = capture(process.env.RUSTC ?? 'rustc', ['--version'], { env }).trim();
  copyFileSync(path.join(crateDir, 'Cargo.lock'), lock);
  // What npm will ship of the crate directory is what installed copies are compared with.
  const packed = new Set(packedFiles(pkgDir));
  const sourceFiles = Object.fromEntries(
    crateFiles(pkg)
      .filter((f) => packed.has(f))
      .map((f) => [f, sha256(path.join(pkgDir, f))]),
  );
  const data = {
    abi: NATIVE_ABI,
    module: pkg.ir.module,
    hash: pkg.ir.hash,
    crate: pkg.crate,
    symbol: build.symbol,
    rnrs: readJson(path.join(RUNTIME_DIR, 'package.json')).version,
    frameworkSha256: frameworkHash(),
    lockSha256: sha256(lock),
    sourceFiles,
    // Surface modules: the surface table ABI their rnrs-surface copy implements, and that copy.
    ...(surface && { surface: { abi: NATIVE_SURFACE_ABI, sha256: crateHash(surface.cratePath) } }),
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sameBuild = [
    'abi',
    'module',
    'hash',
    'crate',
    'symbol',
    'rnrs',
    'frameworkSha256',
    'lockSha256',
    'sourceFiles',
    'surface',
  ].every((k) => same(previous?.[k], data[k]));
  for (const other of ['android', 'ios', 'web'].filter((t) => t !== target)) {
    if (previous?.[other] && sameBuild) {
      data[other] = previous[other];
    } else {
      if (previous?.[other])
        console.log(
          `rnrs: removed the ${other} binaries: they were built from other sources, lock or framework; rebuild them with --target ${other}`,
        );
      rmSync(path.join(nativeDir, other), { recursive: true, force: true });
    }
  }
  data[target] = section;
  writeAtomic(path.join(pkgDir, MANIFEST), JSON.stringify(data, null, 2) + '\n');
  return { pkg, manifest: data };
}

function buildAndroid(
  { pkgDir, nativeDir, work, manifest, cargo, symbol, ident, cargoArgs, surface },
  { abis, ndk },
) {
  const bin = ndkBin(ndk);
  // rnrs-surface releases ANativeWindow references (libandroid); wgpu loads Vulkan with dlopen.
  const libraries = surface ? [...ANDROID_LINK_LIBRARIES, 'android'] : ANDROID_LINK_LIBRARIES;
  const targetDir = path.join(work, 'target');
  const artifacts = {};
  for (const abi of abis) {
    const triple = ANDROID_TRIPLES[abi];
    if (!triple) throw new BundleError(`unsupported Android ABI ${abi}`);
    checkRustTarget(triple);
    const key = triple.replace(/-/g, '_');
    const clang = path.join(bin, `${CLANG_PREFIX[abi]}${ANDROID_MIN_SDK}-clang`);
    const env = {
      ...process.env,
      [`CC_${key}`]: clang,
      [`AR_${key}`]: path.join(bin, 'llvm-ar'),
      [`CARGO_TARGET_${key.toUpperCase()}_LINKER`]: clang,
    };
    run(
      cargo,
      [
        'build',
        '--release',
        '--target',
        triple,
        '--manifest-path',
        manifest,
        '--target-dir',
        targetDir,
        ...cargoArgs,
      ],
      { env },
    );
    const archive = path.join(nativeDir, 'android', abi, `librnrs_${ident}.a`);
    sealAndroid({
      bin,
      raw: path.join(targetDir, triple, 'release/librnrs_bundle.a'),
      symbol,
      archive,
      clang,
      libraries,
      work: path.join(work, 'seal', abi),
    });
    artifacts[abi] = posix(path.relative(pkgDir, archive));
  }
  return { minSdk: ANDROID_MIN_SDK, linkLibraries: libraries, abis: artifacts };
}

/** The web ABI prebuilt Wasm instances are built for (RNRS_WEB_ABI in rust/rnrs-web, WEB_ABI in
 *  packages/runtime/src/web-backend.ts; tools/rnrs-gen/test/web-abi.test.mjs pins all three). */
export const NATIVE_WEB_ABI = 1;

/** One Wasm instance of the module: `cdylib` for wasm32 plus wasm-bindgen's `--target web` glue,
 *  `rnrs/native/web/rnrs_<crate>.js` (initialized by `initRnrs`) and `rnrs_<crate>_bg.wasm`
 *  (fetched by the glue through `new URL(..., import.meta.url)`, which bundlers handle). The
 *  instance has its own memory, allocator and native-object slab; nothing needs sealing. */
function buildWeb({ pkgDir, nativeDir, work, manifest, cargo, ident, cargoArgs }) {
  const triple = 'wasm32-unknown-unknown';
  checkRustTarget(triple);
  const targetDir = path.join(work, 'target');
  run(cargo, [
    'build',
    '--release',
    '--target',
    triple,
    '--manifest-path',
    manifest,
    '--target-dir',
    targetDir,
    ...cargoArgs,
  ]);
  const out = path.join(nativeDir, 'web');
  const name = `rnrs_${ident}`;
  run(process.env.RNRS_WASM_BINDGEN ?? 'wasm-bindgen', [
    '--target',
    'web',
    '--weak-refs',
    '--no-typescript',
    '--out-dir',
    out,
    '--out-name',
    name,
    path.join(targetDir, triple, 'release/rnrs_bundle.wasm'),
  ]);
  return {
    abi: NATIVE_WEB_ABI,
    wasmBindgen: wasmBindgenVersion(),
    js: posix(path.relative(pkgDir, path.join(out, `${name}.js`))),
    wasm: posix(path.relative(pkgDir, path.join(out, `${name}_bg.wasm`))),
  };
}

/** Rust triples of each iOS SDK slice, by architecture. */
const IOS_SLICE_TRIPLES = {
  iphoneos: { arm64: 'aarch64-apple-ios' },
  iphonesimulator: { arm64: 'aarch64-apple-ios-sim', x86_64: 'x86_64-apple-ios' },
};

/** The personality routine a sealed Apple object exports under a module-unique name: Mach-O
 *  unwind info refers to it by an external symbol, so it cannot be made local like on ELF. */
export const applePersonality = (crate) => `rnrs_eh_personality_${crate.replace(/-/g, '_')}`;

/** Rust's own llvm-objcopy (the toolchain's llvm-tools component): Xcode ships none. */
function rustObjcopy(env) {
  const sysroot = capture(env.RUSTC ?? 'rustc', ['--print', 'sysroot'], { env }).trim();
  const host = capture(env.RUSTC ?? 'rustc', ['-vV'], { env }).match(/^host: (.+)$/m)[1];
  const tool = path.join(sysroot, 'lib/rustlib', host, 'bin/llvm-objcopy');
  if (!existsSync(tool))
    throw new BundleError(
      `build-native --target ios needs llvm-objcopy from Rust's llvm-tools: run \`rustup component add llvm-tools\` for the active toolchain`,
    );
  return tool;
}

/** Seals one iOS staticlib like `sealAndroid`, with Apple's tools. Rust's prebuilt std objects
 *  embed LLVM bitcode, which `ld -r` would carry over unsealed, so it is removed first (Rust's
 *  llvm-objcopy); the personality routine is renamed to `applePersonality(crate)`. `ld -r`
 *  (driven by clang for the platform version) then keeps only the table and that routine external
 *  (-exported_symbol: every other global becomes local), `strip -S` drops debug info, and a
 *  throwaway dylib link checks that libSystem plus `frameworks` and `libraries` resolve every
 *  remaining reference. Returns the one-object archive. */
export function sealApple({
  raw,
  symbol,
  personality,
  arch,
  sdk,
  work,
  deploymentTarget,
  objcopy,
  frameworks = [],
  libraries = [],
}) {
  mkdirSync(work, { recursive: true });
  const exported = [`_${symbol}`, `_${personality}`];
  const plain = path.join(work, `plain-${arch}.a`);
  const debug = path.join(work, `sealed-${arch}.debug.o`);
  const sealed = path.join(work, `sealed-${arch}.o`);
  run(objcopy, [
    '--remove-section=__LLVM,__bitcode',
    '--remove-section=__LLVM,__cmdline',
    `--redefine-sym=_rust_eh_personality=_${personality}`,
    raw,
    plain,
  ]);
  const variant = sdk === 'iphonesimulator' ? '-simulator' : '';
  const target = `${arch}-apple-ios${deploymentTarget}${variant}`;
  // clang drives ld -r with the platform version for the target.
  run('xcrun', [
    '--sdk',
    sdk,
    'clang',
    '-target',
    target,
    '-r',
    '-nostdlib',
    `-Wl,-u,_${symbol}`,
    ...exported.map((s) => `-Wl,-exported_symbol,${s}`),
    '-o',
    debug,
    plain,
  ]);
  run('xcrun', ['strip', '-S', '-o', sealed, debug]);
  const globals = capture('xcrun', ['nm', '-g', '-U', '-j', sealed])
    .split('\n')
    .filter(Boolean)
    .sort();
  if (JSON.stringify(globals) !== JSON.stringify([...exported].sort()))
    throw new BundleError(
      `sealing ${raw} (${arch}): expected only ${exported.join(', ')} to stay global, found ${globals.length}: ${globals.slice(0, 10).join(', ')}`,
    );
  run('xcrun', [
    '--sdk',
    sdk,
    'clang',
    '-dynamiclib',
    '-target',
    target,
    '-o',
    path.join(work, `check-${arch}.dylib`),
    sealed,
    ...frameworks.flatMap((f) => ['-framework', f]),
    ...libraries.map((l) => `-l${l}`),
  ]);
  const archive = path.join(work, `librnrs-${arch}.a`);
  rmSync(archive, { force: true });
  run('xcrun', ['libtool', '-static', '-o', archive, sealed]);
  return archive;
}

function buildIos(
  { pkgDir, nativeDir, work, manifest, cargo, symbol, ident, cargoArgs, surface },
  { simArchs, env },
) {
  if (process.platform !== 'darwin')
    throw new BundleError('build-native --target ios runs on macOS (Xcode command line tools)');
  const frameworks = surface ? IOS_SURFACE_FRAMEWORKS : [];
  const linkLibraries = surface ? IOS_SURFACE_LIBRARIES : [];
  const targetDir = path.join(work, 'target');
  const libraries = [];
  const archs = { iphoneos: ['arm64'], iphonesimulator: simArchs };
  const objcopy = rustObjcopy(env);
  const personality = applePersonality(ident);
  for (const [sdk, list] of Object.entries(archs)) {
    const parts = list.map((arch) => {
      const triple = IOS_SLICE_TRIPLES[sdk][arch];
      if (!triple) throw new BundleError(`unsupported ${sdk} architecture ${arch}`);
      checkRustTarget(triple, env);
      run(
        cargo,
        [
          'build',
          '--release',
          '--target',
          triple,
          '--manifest-path',
          manifest,
          '--target-dir',
          targetDir,
          ...cargoArgs,
        ],
        { env },
      );
      return sealApple({
        raw: path.join(targetDir, triple, 'release/librnrs_bundle.a'),
        symbol,
        personality,
        arch,
        sdk,
        work: path.join(work, 'seal', sdk),
        deploymentTarget: env.IPHONEOS_DEPLOYMENT_TARGET,
        objcopy,
        frameworks,
        libraries: linkLibraries,
      });
    });
    const lib = path.join(work, 'seal', sdk, `librnrs_${ident}.a`);
    rmSync(lib, { force: true });
    if (parts.length === 1) copyFileSync(parts[0], lib);
    else run('xcrun', ['lipo', '-create', ...parts, '-output', lib]);
    libraries.push(lib);
  }
  const xcframework = path.join(nativeDir, 'ios', `rnrs_${ident}.xcframework`);
  run('xcrun', [
    'xcodebuild',
    '-create-xcframework',
    ...libraries.flatMap((l) => ['-library', l]),
    '-output',
    xcframework,
  ]);
  // Where Xcode's own XCFramework resolution would look: the slices listed in its Info.plist.
  const info = JSON.parse(
    capture('plutil', ['-convert', 'json', '-o', '-', path.join(xcframework, 'Info.plist')]),
  );
  const slices = {};
  for (const l of info.AvailableLibraries) {
    const sdk = l.SupportedPlatformVariant === 'simulator' ? 'iphonesimulator' : 'iphoneos';
    slices[sdk] = {
      path: posix(
        path.relative(pkgDir, path.join(xcframework, l.LibraryIdentifier, l.LibraryPath)),
      ),
      archs: l.SupportedArchitectures,
    };
  }
  // The effective target (IPHONEOS_DEPLOYMENT_TARGET, default React Native's minimum): apps
  // with a lower one are refused at pod install.
  return {
    deploymentTarget: env.IPHONEOS_DEPLOYMENT_TARGET,
    exports: [symbol, personality],
    frameworks,
    linkLibraries,
    xcframework: posix(path.relative(pkgDir, xcframework)),
    slices,
  };
}

/** The modules the app builds from source: `rustNativeApp.sourceBuild`, a list of package names
 *  or "*" for every module. Unknown names are an error (a typo would otherwise link a prebuilt). */
export function sourceBuildSelection(appDir, modules) {
  const config = readJson(path.join(appDir, 'package.json')).rustNativeApp?.sourceBuild;
  const names = new Map(modules.map((p) => [readJson(path.join(p.dir, 'package.json')).name, p]));
  if (config === undefined) return new Set();
  if (config === '*') return new Set(modules);
  if (!Array.isArray(config) || config.some((n) => typeof n !== 'string'))
    throw new BundleError(
      'rustNativeApp.sourceBuild in the app\'s package.json must be "*" or an array of module package names',
    );
  const unknown = config.filter((n) => !names.has(n));
  if (unknown.length)
    throw new BundleError(
      `rustNativeApp.sourceBuild names ${unknown.join(', ')}, which ${unknown.length > 1 ? 'are' : 'is'} not among the app's Rust modules (${[...names.keys()].join(', ') || 'none'})`,
    );
  return new Set(config.map((n) => names.get(n)));
}

/** The Android ABIs React Native builds by default (`reactNativeArchitectures`): every one a
 *  published module package must ship. */
export const ANDROID_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
const BINARY_TARGETS = ['android', 'ios', 'web'];

/** Author side (Node only): whether the package in `pkgDir` ships current binaries for every
 *  target it declares. Binaries that no longer match the package are always errors: another
 *  rnrs ABI, another spec, Rust sources changed after `build-native` (compared with what npm
 *  packs), or listed files missing. A declared target without binaries is an error with
 *  `require` (publishing: `rnrs check-native`) and a warning otherwise (packing: `pack-js`;
 *  none for private packages, which npm never publishes). `targets` limits the check to some
 *  of the declared targets (an author building one platform per machine).
 *  Library packages, and modules that need a framework library crate other than rnrs-surface,
 *  are source-only.
 *  Returns {errors, warnings, notes}. */
export function checkPackageBinaries(pkgDir, { require = false, targets } = {}) {
  const errors = [],
    warnings = [],
    notes = [];
  const pkg = loadPackage(pkgDir);
  const name = readJson(path.join(pkgDir, 'package.json')).name;
  if (pkg.library) return { errors, warnings, notes: [`${name}: library package, no binaries`] };
  const needs = frameworkNeeds(pkg);
  const shared = [...needs].filter(
    ([crate]) => !FRAMEWORK_CRATES.includes(crate) && crate !== 'rnrs' && crate !== 'rnrs-surface',
  );
  if (shared.length)
    return {
      errors,
      warnings,
      notes: [
        `${name}: no prebuilt binaries (its crate needs ${shared.map(([c]) => c).join(', ')}, which cannot be prebuilt yet): every app using it must list it in rustNativeApp.sourceBuild and build it with Rust`,
      ],
    };
  const manifestJson = readJson(path.join(pkgDir, 'package.json'));
  const declared = pkg.targets.filter(
    (t) =>
      BINARY_TARGETS.includes(t) &&
      (!targets || targets.includes(t)) &&
      (!needs.has('rnrs-surface') || SURFACE_TARGETS.includes(t)),
  );
  if (needs.has('rnrs-surface'))
    for (const t of pkg.targets.filter(
      (t) => BINARY_TARGETS.includes(t) && !SURFACE_TARGETS.includes(t),
    ))
      notes.push(
        `${name}: no prebuilt ${t} binaries (prebuilt surface modules exist for ${SURFACE_TARGETS.join(', ')} only): apps using it on ${t} must list it in rustNativeApp.sourceBuild`,
      );
  const quiet = !require && manifestJson.private === true;
  const hint = (t) => `run \`rnrs build-native --target ${t}\``;
  const missing = (t, what) =>
    quiet ||
    (require ? errors : warnings).push(
      `${name}: ${what}; ${hint(t)}${require ? '' : ' before publishing (apps without it must build this module from source)'}`,
    );
  const file = path.join(pkgDir, MANIFEST);
  if (!existsSync(file)) {
    for (const t of declared) missing(t, `no prebuilt ${t} binaries`);
    return { errors, warnings, notes };
  }
  const m = readJson(file);
  if (m.abi !== NATIVE_ABI)
    errors.push(
      `${name}: ${MANIFEST} is for rnrs ABI ${m.abi}, this rnrs builds ABI ${NATIVE_ABI}; rebuild every target`,
    );
  if (needs.has('rnrs-surface') && m.surface?.abi !== NATIVE_SURFACE_ABI)
    errors.push(
      `${name}: its crate renders to surfaces, but the binaries implement surface ABI ${m.surface?.abi ?? 'none'} (this rnrs: ${NATIVE_SURFACE_ABI}); rebuild every target`,
    );
  const [ir] = plan([pkg])
    .filter((o) => o.kind === 'ir')
    .map((o) => JSON.parse(o.content));
  if (m.hash !== ir.hash || m.module !== ir.module)
    errors.push(
      `${name}: the binaries were built from another spec (IR ${m.hash}, now ${ir.hash}); rebuild every target`,
    );
  if (m.crate !== pkg.crate || m.symbol !== tableSymbol(pkg.crate))
    errors.push(
      `${name}: the binaries are for crate ${m.crate}, the package declares ${pkg.crate}`,
    );
  const packed = new Set(packedFiles(pkgDir));
  const shipped = Object.keys(m.sourceFiles ?? {});
  const now = crateFiles(pkg).filter((f) => packed.has(f));
  const changed = [
    ...now.filter((f) => !(f in (m.sourceFiles ?? {}))).map((f) => `${f} (added)`),
    ...now
      .filter(
        (f) => f in (m.sourceFiles ?? {}) && sha256(path.join(pkgDir, f)) !== m.sourceFiles[f],
      )
      .map((f) => `${f} (modified)`),
    ...shipped.filter((f) => !now.includes(f)).map((f) => `${f} (removed)`),
  ];
  if (changed.length)
    errors.push(
      `${name}: the Rust sources changed after the binaries were built: ${changed.slice(0, 5).join(', ')}; rebuild every target`,
    );
  const exists = (f) => f && existsSync(path.join(pkgDir, f));
  for (const t of declared) {
    const section = m[t];
    if (!section) {
      missing(t, `no prebuilt ${t} binaries`);
      continue;
    }
    if (t === 'android') {
      for (const abi of ANDROID_ABIS)
        if (!exists(section.abis?.[abi]))
          missing(
            t,
            `no prebuilt Android ${abi} archive (React Native builds all of ${ANDROID_ABIS.join(', ')} by default)`,
          );
    } else if (t === 'ios') {
      if (
        JSON.stringify(section.exports) !==
        JSON.stringify([tableSymbol(pkg.crate), applePersonality(pkg.crate)])
      )
        errors.push(`${name}: the iOS binaries export ${JSON.stringify(section.exports)}`);
      for (const sdk of ['iphoneos', 'iphonesimulator'])
        if (!exists(section.slices?.[sdk]?.path)) missing(t, `no prebuilt iOS ${sdk} slice`);
    } else {
      if (section.abi !== NATIVE_WEB_ABI)
        errors.push(
          `${name}: the web binaries are for web ABI ${section.abi}, this rnrs builds ${NATIVE_WEB_ABI}`,
        );
      for (const key of ['js', 'wasm'])
        if (!exists(section[key])) missing(t, `no prebuilt web ${key} file`);
    }
  }
  for (const t of BINARY_TARGETS.filter((t) => m[t] && !declared.includes(t)))
    warnings.push(`${name}: ships ${t} binaries but rustNative.targets does not declare ${t}`);
  return { errors, warnings, notes };
}

/** Why `pkg`'s prebuilt binary cannot be linked for `target` (Android: `abis`; iOS: both SDK
 *  slices), or [] (Node only). */
export function checkPrebuilt(
  pkg,
  { target = 'android', abis = [], minSdk, iosDeploymentTarget } = {},
) {
  const name = pkg.chain.join(' -> ');
  const hint = `; add its package name to rustNativeApp.sourceBuild in the app's package.json to compile it from source (needs Rust)`;
  const file = path.join(pkg.dir, MANIFEST);
  if (!existsSync(file)) return [`${name}: ships no prebuilt native binary (${MANIFEST})${hint}`];
  const m = readJson(file);
  const errors = [];
  if (m.abi !== NATIVE_ABI)
    return [
      `${name}: its prebuilt binary is for rnrs ABI ${m.abi}, this @rnrs/runtime needs ABI ${NATIVE_ABI}; install a matching version${hint}`,
    ];
  if (m.crate !== pkg.crate || m.symbol !== tableSymbol(pkg.crate))
    errors.push(
      `${name}: its manifest names crate ${m.crate} (${m.symbol}), the package declares ${pkg.crate}`,
    );
  // A surface module's binary embeds its own rnrs-surface: its surface table must be the one
  // this runtime's surface host speaks (checked again at run time, before any surface call).
  if (m.surface && !SURFACE_TARGETS.includes(target))
    return [
      `${name}: renders to surfaces, which are prebuilt for ${SURFACE_TARGETS.join(', ')} only${hint}`,
    ];
  if (m.surface && m.surface.abi !== NATIVE_SURFACE_ABI)
    errors.push(
      `${name}: its prebuilt binary implements surface ABI ${m.surface.abi}, this @rnrs/runtime needs ${NATIVE_SURFACE_ABI}; install matching versions of the module, @rnrs/runtime and @rnrs/surface${hint}`,
    );
  const wrapper = path.join(pkg.dir, 'rnrs/index.ts');
  const wrapperHash = existsSync(wrapper)
    ? /\/\/ IR hash: (\w+)/.exec(readFileSync(wrapper, 'utf8'))?.[1]
    : undefined;
  if (!wrapperHash)
    errors.push(
      `${name}: has a prebuilt binary but no generated JS wrapper with an IR hash (rnrs/index.ts); the package was not packed with rnrs pack-js`,
    );
  else if (wrapperHash !== m.hash)
    errors.push(
      `${name}: its JS wrapper (IR ${wrapperHash}) and prebuilt binary (IR ${m.hash}) come from different specs; reinstall the package`,
    );
  // Rust sources edited after publishing (patch-package, a local edit) are never ignored.
  const shipped = new Set(Object.keys(m.sourceFiles ?? {}));
  const changed = [];
  for (const f of crateFiles(pkg)) {
    if (!shipped.delete(f)) changed.push(`${f} (added)`);
    else if (sha256(path.join(pkg.dir, f)) !== m.sourceFiles[f]) changed.push(`${f} (modified)`);
  }
  changed.push(...[...shipped].map((f) => `${f} (removed)`));
  if (changed.length)
    errors.push(
      `${name}: its Rust sources differ from the ones its prebuilt binary was built from: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', ...' : ''}${hint}`,
    );
  if (target === 'web') {
    if (m.web && m.web.abi !== NATIVE_WEB_ABI)
      return [
        `${name}: its prebuilt Wasm module is for web ABI ${m.web.abi}, this @rnrs/runtime needs ${NATIVE_WEB_ABI}; install a matching version${hint}`,
      ];
    for (const key of ['js', 'wasm']) {
      const file = m.web?.[key];
      if (!file || !existsSync(path.join(pkg.dir, file)))
        errors.push(
          `${name}: its prebuilt binary has no web ${key === 'js' ? 'glue' : 'Wasm'} file${hint}`,
        );
    }
    return errors;
  }
  if (target === 'ios') {
    const version = (v) =>
      String(v ?? '0')
        .split('.')
        .map(Number);
    const above = (a, b) => {
      const [x, y] = [version(a), version(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i++)
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
      return false;
    };
    if (iosDeploymentTarget && above(m.ios?.deploymentTarget, iosDeploymentTarget))
      errors.push(
        `${name}: its prebuilt binary needs iOS ${m.ios.deploymentTarget}, the app's deployment target is ${iosDeploymentTarget}${hint}`,
      );
    // Exactly the table and the module's personality routine are exported (a new export must be
    // added here on purpose).
    const exports = [tableSymbol(pkg.crate), applePersonality(pkg.crate)];
    if (m.ios && JSON.stringify(m.ios.exports) !== JSON.stringify(exports))
      errors.push(
        `${name}: its iOS binary exports ${JSON.stringify(m.ios.exports)}, this @rnrs/runtime expects ${JSON.stringify(exports)}`,
      );
    if (m.surface && !Array.isArray(m.ios?.frameworks))
      errors.push(`${name}: its iOS surface binary lists no frameworks to link; rebuild it${hint}`);
    // The names become linker flags of the app target.
    const names = [...(m.ios?.frameworks ?? []), ...(m.ios?.linkLibraries ?? [])];
    if (names.some((n) => typeof n !== 'string' || !/^[A-Za-z0-9_]+$/.test(n)))
      errors.push(
        `${name}: its iOS binary lists invalid frameworks or libraries ${JSON.stringify(names)}`,
      );
    for (const sdk of ['iphoneos', 'iphonesimulator']) {
      const slice = m.ios?.slices?.[sdk]?.path;
      if (!slice || !existsSync(path.join(pkg.dir, slice)))
        errors.push(`${name}: its prebuilt binary has no iOS ${sdk} slice${hint}`);
    }
    return errors;
  }
  if (minSdk !== undefined && m.android?.minSdk > minSdk)
    errors.push(
      `${name}: its prebuilt binary needs Android API ${m.android.minSdk}, the app's minSdk is ${minSdk}${hint}`,
    );
  for (const abi of abis) {
    const archive = m.android?.abis?.[abi];
    if (!archive || !existsSync(path.join(pkg.dir, archive)))
      errors.push(
        `${name}: its prebuilt binary has no ${abi} archive${hint}, or build only the ABIs it ships (Gradle -PreactNativeArchitectures)`,
      );
  }
  return errors;
}

/** App: checks the app's modules for `target` and writes `<out>/rnrs_registry.inc` and (Android)
 *  `<out>/modules.cmake`. Returns {prebuilt, source, slices, frameworks, libraries}: the source
 *  modules still need the source bundle build (cargo); with none, nothing else is needed. iOS
 *  `slices` maps each SDK to the absolute paths of the prebuilt static libraries to link, and
 *  `frameworks`/`libraries` are what those need (the pod's linker flags). Node only. */
export function linkModules(
  appDir,
  target,
  { out, abis = ['arm64-v8a'], minSdk, iosDeploymentTarget } = {},
) {
  if (!['android', 'ios', 'web'].includes(target))
    throw new BundleError(`rnrs link: unknown target ${target}`);
  const selected = selectModules(appDir, target);
  const modules = selected.filter((p) => !p.library);
  const source = sourceBuildSelection(appDir, modules);
  const prebuilt = modules.filter((p) => !source.has(p));
  const errors = [];
  for (const pkg of prebuilt)
    errors.push(...checkPrebuilt(pkg, { target, abis, minSdk, iosDeploymentTarget }));
  // Module names must be unique (the registry refuses a second definition at run time).
  const names = new Map();
  for (const pkg of prebuilt) {
    const file = path.join(pkg.dir, MANIFEST);
    const module = existsSync(file) ? readJson(file).module : undefined;
    if (module && names.has(module))
      errors.push(
        `module ${module} is defined by both ${names.get(module)} and ${pkg.chain.join(' -> ')}`,
      );
    if (module) names.set(module, pkg.chain.join(' -> '));
  }
  if (errors.length) throw new BundleError(errors.join('\n'));
  const linked = [...prebuilt, ...source];
  const ordered = modules.filter((p) => linked.includes(p));
  if (target === 'web') {
    // The app's module registry: the instances to load, the source bundle (if any) first; a
    // surface bootstrap binds every instance that contains rnrs-surface. Prebuilt glue of
    // overridden modules is never imported. Relative imports, so bundlers include the files no package `exports` list.
    const rel = (file) => {
      const r = posix(path.relative(out, file));
      return r.startsWith('.') ? r : `./${r}`;
    };
    // Prefixed bindings: crate names may be `source` or JS reserved words (`delete`, `this`).
    const imports = [
      ...(source.size ? [['source_bundle', './pkg/rnrs_bundle.js']] : []),
      ...prebuilt.map((p) => [
        `m_${p.crate.replace(/-/g, '_')}`,
        rel(path.join(p.dir, readJson(path.join(p.dir, MANIFEST)).web.js)),
      ]),
    ];
    writeAtomic(
      path.join(out, 'rnrs.js'),
      `// @generated by rnrs build (web); do not edit. The app's Rust modules for initRnrs():
//   import * as modules from './.rnrs/web/rnrs.js'; await initRnrs(modules);
// Prebuilt: ${prebuilt.map((p) => p.crate).join(', ') || 'none'}. Source bundle: ${[...source].map((p) => p.crate).join(', ') || 'none'}.
${imports
  .map(
    ([id, file]) => `import * as ${id} from ${JSON.stringify(file)};
`,
  )
  .join('')}export const instances = [${imports.map(([id]) => id).join(', ')}];
// The source bundle (also the first instance), or null when every module is prebuilt.
export const source = ${source.size ? 'source_bundle' : 'null'};
`,
    );
    writeAtomic(
      path.join(out, 'rnrs.d.ts'),
      `// @generated by rnrs build (web); do not edit.
export declare const instances: readonly import('@rnrs/runtime/web').RnrsBundle[];
export declare const source: import('@rnrs/runtime/web').RnrsBundle | null;
`,
    );
    return { prebuilt, source, slices: {}, frameworks: [], libraries: [] };
  }
  writeAtomic(
    path.join(out, 'rnrs_registry.inc'),
    `// @generated by rnrs link (${target}); do not edit. Included by RnrsRegistry.cpp.
// Prebuilt: ${prebuilt.map((p) => p.crate).join(', ') || 'none'}. Source bundle: ${[...source].map((p) => p.crate).join(', ') || 'none'}.
${ordered.map((p) => `extern "C" const RnrsModuleV2* ${tableSymbol(p.crate)}();\n`).join('')}static const RnrsModuleEntry kRnrsModules[] = {
${ordered.map((p) => `    {"${tableSymbol(p.crate)}", ${tableSymbol(p.crate)}},\n`).join('')}    {nullptr, nullptr},
};
`,
  );
  if (target === 'android') {
    const cmake = (s) => s.replace(/[\\"$;]/g, (c) => `\\${c}`);
    const archives = (abi) =>
      prebuilt.map((p) =>
        cmake(posix(path.join(p.dir, readJson(path.join(p.dir, MANIFEST)).android.abis[abi]))),
      );
    const libraries = [
      ...new Set(
        prebuilt.flatMap((p) => readJson(path.join(p.dir, MANIFEST)).android.linkLibraries ?? []),
      ),
    ];
    writeAtomic(
      path.join(out, 'modules.cmake'),
      `# @generated by rnrs link (android); do not edit. Included by @rnrs/runtime's CMakeLists.txt.
set(RNRS_LINKED_CRATES "${ordered.map((p) => p.crate).join(';')}")
set(RNRS_SOURCE_BUNDLE ${source.size ? 'ON' : 'OFF'})
set(RNRS_MODULE_LINK_LIBRARIES "${libraries.join(';')}")
set(RNRS_MODULE_ARCHIVES "")
${abis.map((abi) => `if(ANDROID_ABI STREQUAL "${abi}")\n  set(RNRS_MODULE_ARCHIVES "${archives(abi).join(';')}")\nendif()\n`).join('')}`,
    );
  }
  const slices = {};
  const union = (key) => [
    ...new Set(prebuilt.flatMap((p) => readJson(path.join(p.dir, MANIFEST)).ios[key] ?? [])),
  ];
  if (target !== 'ios') return { prebuilt, source, slices, frameworks: [], libraries: [] };
  for (const sdk of ['iphoneos', 'iphonesimulator'])
    slices[sdk] = prebuilt.map((p) =>
      path.join(p.dir, readJson(path.join(p.dir, MANIFEST)).ios.slices[sdk].path),
    );
  return {
    prebuilt,
    source,
    slices,
    frameworks: union('frameworks'),
    libraries: union('linkLibraries'),
  };
}
