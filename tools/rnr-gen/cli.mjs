#!/usr/bin/env node
// rnr-gen: TS spec -> IR -> Rust interface (committed) + hidden glue (build output).
//
//   node tools/rnr-gen/cli.mjs generate          write interfaces and .generated/rnr/
//   node tools/rnr-gen/cli.mjs check             fail if any committed output is stale
//   node tools/rnr-gen/cli.mjs build-outputs --out DIR --target T [--manifest Cargo.toml]
//                                                (build.rs) write one bundle's Rust glue into
//                                                DIR (the crate's OUT_DIR); fail if a committed
//                                                interface is stale or the bundle crate's
//                                                dependencies do not match target T's modules
//   node tools/rnr-gen/cli.mjs ir <spec.ts>      print a spec's IR or its diagnostics
//
// Package and consumer commands (also `rnrs <command>` from @rnrs/runtime):
//   generate <package-dir>      write one package's committed Rust interface (an author's
//                               package outside this repository)
//   check <package-dir>         fail if that package's committed interface is stale
//   init [dir]                  scaffold a module package (tools/rnr-gen/author.mjs)
//   test [dir] [cargo args]     generate, then cargo test the crate against the framework
//   pack-js <package-dir>       write the package's JS wrapper (rnr/index.ts, rnr/web.ts)
//                               before `npm pack`; fails if the committed interface is stale
//   bundle --target T --app DIR [--out DIR]
//                               generate the app's Rust bundle crate from its dependencies
//   build --target T --app DIR [--out DIR] [--abi a,b] [--sdk S --arch a,b] [--locked] [--offline]
//                               bundle, then cargo build (and wasm-bindgen for web) with
//                               (Android: --abi; iOS: the Xcode --sdk iphoneos|iphonesimulator
//                               and --arch list, combined into .rnr/ios/lib/<sdk>/)
//                               the app's rnr-T.Cargo.lock (created if absent, unless
//                               --locked or RNR_LOCKED=1, which require it)
//   lock --target T --app DIR [--update | --check] [--offline]
//                               write the app's rnr-T.Cargo.lock for the current
//                               dependencies (keeping locked versions; --update upgrades),
//                               or --check that it exists and is current (CI)
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {implementedTargets} from './targets.mjs';
import {formatDiagnostic, parseSpec} from './parse.mjs';
import {emitGlue, emitInterface} from './emit-rust.mjs';
import {emitTs} from './emit-ts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Two layouts: this repository (tools/rnr-gen; the framework is packages/rnr-runtime and rust/)
// or the packed @rnrs/cli (generator/), which uses the @rnrs/runtime installed next to it (its
// exact-version peer dependency) for the framework spec and Rust crates.
const CLI_MANIFEST = path.join(HERE, '../package.json');
const cliManifest = existsSync(CLI_MANIFEST) ? JSON.parse(readFileSync(CLI_MANIFEST, 'utf8')) : null;
export const PACKAGED = cliManifest?.name === '@rnrs/cli';
export const RUNTIME_DIR = PACKAGED ? packagedRuntime() : path.resolve(HERE, '../../packages/rnr-runtime');
export const FRAMEWORK_SPEC = path.join(RUNTIME_DIR, 'src/spec.ts');
/** Framework Rust crates (rnr-core, rnr-android, rnr-web, rnr-log). */
export const FRAMEWORK_RUST = PACKAGED ? path.join(RUNTIME_DIR, 'rust') : path.resolve(HERE, '../../rust');

/** The packed CLI's @rnrs/runtime, resolved the way Node resolves the CLI's peer dependency.
 *  Its version must equal the CLI's: the two are released together. */
function packagedRuntime() {
  let manifest;
  try {
    manifest = createRequire(CLI_MANIFEST).resolve('@rnrs/runtime/package.json');
  } catch {
    console.error(`rnrs: @rnrs/runtime is not installed next to @rnrs/cli ${cliManifest.version} (${path.resolve(HERE, '..')}). ` +
      `Install both in the project: npm install --save-dev @rnrs/cli@${cliManifest.version} @rnrs/runtime@${cliManifest.version}`);
    process.exit(1);
  }
  const {version} = JSON.parse(readFileSync(manifest, 'utf8'));
  if (version !== cliManifest.version) {
    console.error(`rnrs: @rnrs/cli ${cliManifest.version} requires @rnrs/runtime ${cliManifest.version}, but resolved ${version} at ${path.dirname(manifest)}. ` +
      'Install matching versions of both packages.');
    process.exit(1);
  }
  return path.dirname(manifest);
}
/** Authoring root for generate/check (the repository, or the current directory). */
export const ROOT = PACKAGED ? process.cwd() : path.resolve(HERE, '../..');
export const GEN_DIR = path.join(ROOT, '.generated/rnr');
const TARGET_BUNDLES = {android: 'bundle-android.rs', web: 'bundle-web.rs'};

class GenError extends Error {}

/** Reads one package's rustNative config. */
export function loadPackage(dir) {
  const manifestPath = path.join(dir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const rel = path.relative(ROOT, manifestPath);
  let targets;
  try {
    targets = implementedTargets(manifest, rel);
  } catch (error) {
    throw new GenError(error.message);
  }
  const rn = manifest.rustNative;
  const need = (value, what) => {
    if (typeof value !== 'string' || !value) throw new GenError(`${rel}: rustNative.${what} must be a nonempty string`);
    return value;
  };
  if (rn.library !== undefined) {
    // A Rust library package (for example @rnrs/surface): a crate that module crates depend on
    // by version (`rnr-surface = "0.1"`). It has no spec, generated interface or JS wrapper;
    // bundles patch the crate name to the installed copy and register no module for it.
    const extra = Object.keys(rn).filter(k => !['targets', 'library'].includes(k));
    if (extra.length) throw new GenError(`${rel}: rustNative.library cannot be combined with ${extra.join(', ')} (a library package declares only targets and library)`);
    if (rn.library === null || typeof rn.library !== 'object' || Array.isArray(rn.library))
      throw new GenError(`${rel}: rustNative.library must be an object {"crate": ..., "path": ...}`);
    const unknown = Object.keys(rn.library).filter(k => !['crate', 'path'].includes(k));
    if (unknown.length) throw new GenError(`${rel}: rustNative.library: unknown key(s) ${unknown.join(', ')}; allowed: crate, path`);
    const lib = {dir, manifestPath: rel, targets, library: true,
      crate: need(rn.library.crate, 'library.crate'), cratePath: path.resolve(dir, need(rn.library.path, 'library.path'))};
    if (!/^[a-z][a-z0-9_-]*$/.test(lib.crate)) throw new GenError(`${rel}: rustNative.library.crate is not a crate name`);
    if (isFrameworkCrate(lib.crate)) throw new GenError(`${rel}: rustNative.library.crate ${lib.crate} is reserved for the framework`);
    // The crate must ship inside the package: npm pack takes only the package directory.
    const inside = path.relative(dir, lib.cratePath);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new GenError(`${rel}: rustNative.library.path must stay inside the package`);
    const cargoToml = path.join(lib.cratePath, 'Cargo.toml');
    if (!existsSync(cargoToml)) throw new GenError(`${rel}: rustNative.library.path has no Cargo.toml`);
    const declared = cargoPackageName(readFileSync(cargoToml, 'utf8'));
    if (declared !== lib.crate)
      throw new GenError(`${rel}: rustNative.library.crate is ${lib.crate}, but ${path.relative(dir, cargoToml)} declares package ${declared ?? '(no name)'}`);
    return lib;
  }
  const rust = rn.rust ?? {};
  const pkg = {
    dir, manifestPath: rel, targets,
    spec: path.join(dir, need(rn.spec, 'spec')),
    crate: need(rust.crate, 'rust.crate'),
    cratePath: path.join(dir, need(rust.path, 'rust.path')),
    moduleType: need(rust.module, 'rust.module'),
    maxInFlight: rn.maxInFlight ?? 8,
  };
  if (!/^[a-z][a-z0-9_]*$/.test(pkg.crate.replace(/-/g, '_'))) throw new GenError(`${rel}: rustNative.rust.crate is not a crate name`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pkg.moduleType)) throw new GenError(`${rel}: rustNative.rust.module must be a Rust type name`);
  if (!Number.isInteger(pkg.maxInFlight) || pkg.maxInFlight < 1 || pkg.maxInFlight > 1024) throw new GenError(`${rel}: rustNative.maxInFlight must be an integer from 1 to 1024`);
  if (!existsSync(pkg.spec)) throw new GenError(`${rel}: spec ${rn.spec} not found`);
  return pkg;
}

/** Crate names the framework provides or generates (rnr-bundle); no package may use them.
 *  Compared with `-` and `_` treated alike, as Cargo does for crate identifiers. */
export const FRAMEWORK_CRATES = ['rnr-core', 'rnr-android', 'rnr-web', 'rnr-log', 'rnr-bundle'];
export const isFrameworkCrate = name => FRAMEWORK_CRATES.some(f => f.replace(/-/g, '_') === name.replace(/-/g, '_'));

/** `name` in the `[package]` table of a Cargo.toml, or null. */
function cargoPackageName(toml) {
  const start = toml.search(/^\[package\]\s*$/m);
  if (start < 0) return null;
  const rest = toml.slice(start).split('\n').slice(1);
  const end = rest.findIndex(line => /^\s*\[/.test(line));
  const table = (end < 0 ? rest : rest.slice(0, end)).join('\n');
  return table.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

/** Commands that work on a module's spec refuse library packages with a clear diagnostic. */
function moduleOnly(pkg, command) {
  if (pkg.library) throw new GenError(`${pkg.manifestPath}: rnrs ${command} applies to module packages; this is a Rust library package (rustNative.library) with no spec, interface or JS wrapper`);
  return pkg;
}

/** The app's module packages (root package.json `rustNativeApp.packages`). */
export function appPackages() {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const dirs = manifest.rustNativeApp?.packages;
  if (!Array.isArray(dirs)) throw new GenError('package.json: rustNativeApp.packages must list module package directories');
  return dirs.map(d => loadPackage(path.join(ROOT, d)));
}

/** Everything generation would write: [{file, content, committed}]. Throws on diagnostics. */
export function plan(packages, {genDir = GEN_DIR} = {}) {
  const outputs = [];
  const failures = [];
  const modules = new Map();
  for (const pkg of packages) {
    const {ir, diagnostics} = parseSpec(pkg.spec, {frameworkSpec: FRAMEWORK_SPEC, root: ROOT});
    if (diagnostics.length) { failures.push(...diagnostics.map(formatDiagnostic)); continue; }
    if (modules.has(ir.module)) { failures.push(`${pkg.manifestPath}: module name ${ir.module} is already used by ${modules.get(ir.module)}`); continue; }
    modules.set(ir.module, pkg.manifestPath);
    // Generated headers name the spec relative to its package, so the committed interface is
    // the same wherever the package is installed (repository, node_modules).
    ir.spec = path.relative(pkg.dir, pkg.spec).split(path.sep).join('/');
    const crateIdent = pkg.crate.replace(/-/g, '_');
    const out = path.join(GEN_DIR, crateIdent);
    outputs.push({file: path.join(pkg.cratePath, 'src/rnr_interface.rs'), content: emitInterface(ir), committed: true, kind: 'interface'});
    // Rust glue: compiled from the bundle crate's OUT_DIR (build.rs); a copy under
    // .generated/rnr is written by `generate` for inspection only.
    outputs.push({file: path.join(genDir, crateIdent, 'glue.rs'), content: emitGlue(ir, {crate: crateIdent, moduleType: pkg.moduleType}), committed: false, kind: 'glue', pkg});
    const runtimeImport = path.relative(out, path.join(ROOT, 'packages/rnr-runtime/src/runtime')).split(path.sep).join('/');
    outputs.push({file: path.join(out, 'index.ts'), content: emitTs(ir, {runtimeImport, maxInFlight: pkg.maxInFlight}), committed: false, kind: 'ts'});
    outputs.push({file: path.join(out, 'ir.json'), content: JSON.stringify(ir, null, 2) + '\n', committed: false, kind: 'ir'});
    pkg.ir = ir;
    pkg.crateIdent = crateIdent;
  }
  if (failures.length) throw new GenError(failures.join('\n'));
  for (const [target, file] of Object.entries(TARGET_BUNDLES)) {
    const members = packages.filter(p => p.targets.includes(target));
    const content = `// @generated by tools/rnr-gen: modules bundled for ${target}; do not edit.\n` +
      members.map(p => `pub mod ${p.crateIdent} {\n    include!(concat!(env!("RNR_GEN_DIR"), "/${p.crateIdent}/glue.rs"));\n}\n`).join('') +
      `\npub static MODULES: &[&rnr_core::bind::ModuleDef] = &[${members.map(p => `&${p.crateIdent}::MODULE`).join(', ')}];\n`;
    outputs.push({file: path.join(genDir, file), content, committed: false, kind: 'bundle', target, members});
  }
  return outputs;
}

/** Inputs whose change must rerun generation (for cargo's rerun-if-changed). */
function dependencies() {
  const deps = [path.join(ROOT, 'package.json'), path.join(ROOT, 'tools/rnr-gen'), FRAMEWORK_SPEC, path.join(ROOT, 'scripts/rn-targets.mjs')];
  for (const pkg of appPackages()) deps.push(pkg.dir, path.join(pkg.cratePath, 'src/rnr_interface.rs'));
  return deps;
}

const read = file => (existsSync(file) ? readFileSync(file, 'utf8') : null);

let tmpCounter = 0;
/** Write-then-rename, so a concurrent reader (another build script, tsc, Metro) never sees a
 *  partial file. Unchanged files are not rewritten (stable mtimes for cargo and Metro). */
export function writeAtomic(file, content) {
  if (read(file) === content) return false;
  mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.tmp-${process.pid}-${tmpCounter++}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
  return true;
}

function write(outputs, select) {
  let written = 0;
  for (const o of outputs) if (select(o) && writeAtomic(o.file, o.content)) written++;
  return written;
}

/** Module crates a bundle crate depends on (names from [dependencies], `-` as `_`). */
function manifestDependencies(manifestPath) {
  const text = readFileSync(manifestPath, 'utf8');
  const section = text.split(/^\[/m).find(part => part.startsWith('dependencies]')) ?? '';
  return new Set([...section.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map(m => m[1].replace(/-/g, '_')));
}

/** A bundle crate must depend on exactly the module crates whose targets include its target. */
export function checkBundleManifest(manifestPath, target, packages) {
  const deps = manifestDependencies(manifestPath);
  const rel = path.relative(ROOT, manifestPath);
  const errors = [];
  for (const p of packages) {
    const included = p.targets.includes(target);
    if (included && !deps.has(p.crateIdent))
      errors.push(`${rel}: module crate ${p.crate} (${p.manifestPath}, targets ${p.targets.join(', ')}) is bundled for ${target} but is not a dependency`);
    if (!included && deps.has(p.crateIdent))
      errors.push(`${rel}: module crate ${p.crate} does not declare target ${target} (targets ${p.targets.join(', ')}); remove the dependency`);
  }
  return errors;
}

function option(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function stale(outputs) {
  return outputs.filter(o => o.committed && read(o.file) !== o.content).map(o => path.relative(ROOT, o.file));
}

/** The framework's rnr-core version (what bundles patch `rnr-core` to). */
function frameworkCoreVersion() {
  return readFileSync(path.join(FRAMEWORK_RUST, 'rnr-core/Cargo.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m)[1];
}

/** A module crate must require an rnr-core version this framework provides: bundles patch
 *  `rnr-core` to the framework copy, and an unsatisfiable requirement would make cargo look
 *  for the (unpublished, unreserved) name on crates.io. Plain or caret requirements only. */
export function checkCoreRequirement(pkg) {
  const file = path.join(pkg.cratePath, 'Cargo.toml');
  const toml = readFileSync(file, 'utf8');
  const m = toml.match(/^rnr-core\s*=\s*(?:"([^"]*)"|\{([^}]*)\})/m);
  const rel = path.relative(process.cwd(), file);
  if (!m) throw new GenError(`${rel}: the crate must depend on rnr-core (rnr-core = "${frameworkCoreVersion().split('.').slice(0, 2).join('.')}")`);
  if (m[2] !== undefined && /\b(path|git|registry)\s*=/.test(m[2]) && !/\bversion\s*=/.test(m[2])) return; // a local override (repository workspaces)
  const req = m[1] ?? m[2].match(/\bversion\s*=\s*"([^"]*)"/)?.[1] ?? '';
  const have = frameworkCoreVersion().split('.').map(Number);
  const want = req.replace(/^\^/, '').trim().split('.');
  const ok = /^\^?\d+(\.\d+){0,2}$/.test(req.trim()) && Number(want[0]) === have[0] && (have[0] !== 0 || want[1] === undefined || Number(want[1]) === have[1]) &&
    (want[1] === undefined || have[0] !== 0 || want[2] === undefined || Number(want[2]) <= have[2]);
  if (!ok) throw new GenError(`${rel}: rnr-core requirement "${req}" is not satisfied by this framework's rnr-core ${have.join('.')}; ` +
    `use rnr-core = "${have.slice(0, 2).join('.')}" (rnr-core is not published: cargo must resolve it to the framework copy, never to crates.io)`);
}

/** Writes a package's JS wrapper for publishing: `rnr/index.ts` (imports @rnrs/runtime) and
 *  `rnr/web.ts` (the same, or a stub that fails at import if web is not a declared target). */
export function packJs(dir) {
  const pkg = moduleOnly(loadPackage(dir), 'pack-js');
  checkCoreRequirement(pkg);
  const outputs = plan([pkg]);
  const iface = outputs.find(o => o.kind === 'interface');
  if (!existsSync(iface.file) || readFileSync(iface.file, 'utf8') !== iface.content)
    throw new GenError(`${path.relative(process.cwd(), iface.file)} is stale; run "rnrs generate ." and review the diff`);
  const ts = emitTs(pkg.ir, {runtimeImport: '@rnrs/runtime', maxInFlight: pkg.maxInFlight});
  const name = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
  const web = pkg.targets.includes('web')
    ? `// @generated by rnrs pack-js; do not edit.\nexport * from './index';\n`
    : `// @generated by rnrs pack-js; do not edit.\nthrow new Error(${JSON.stringify(`${name} does not support the web target (rustNative.targets: ${pkg.targets.join(', ')})`)});\nexport {};\n`;
  writeAtomic(path.join(dir, 'rnr/index.ts'), ts);
  writeAtomic(path.join(dir, 'rnr/web.ts'), web);
  console.log(`rnrs: wrote ${path.join(path.relative(process.cwd(), dir) || '.', 'rnr')}/{index,web}.ts`);
  return 0;
}

export const USAGE = `usage: rnrs <command> [options]

Module packages (an author's package with a TypeScript spec and a Rust crate):
  init [dir] [--name NAME] [--targets android,ios,web] [--crate CRATE]
                       add the rustNative package.json fields, a spec, a Rust crate and
                       .gitignore entries; never overwrites files, never installs anything
  generate [dir]       write the Rust interface (rust/src/rnr_interface.rs) from the spec
  check [dir]          fail if the interface is stale or package.json cannot work for apps
  test [dir] [args...] generate, then cargo test the crate against the installed framework
                       (further arguments go to cargo test; a filter needs the dir first:
                       rnrs test . my_test)
  pack-js [dir]        write the JS wrapper rnr/{index,web}.ts (npm pack runs it via prepack)

Apps:
  build --target android|ios|web [--app DIR] [--locked] [--offline]
                       generate and build the app's Rust bundle (Android/iOS builds run this)
  bundle --target T [--app DIR]     only generate the bundle crate
  lock --target T [--app DIR] [--update | --check]
                       write or check the app's rnr-T.Cargo.lock

  ir <spec.ts>         print a spec's IR or its diagnostics
  help                 this text

dir defaults to the current directory.`;

const COMMANDS = ['init', 'generate', 'check', 'test', 'pack-js', 'build', 'bundle', 'lock', 'ir', 'build-outputs'];
const PACKAGE_COMMANDS = ['init', 'generate', 'check', 'test', 'pack-js'];

export async function main(argv) {
  const [command] = argv;
  let arg = argv[1];
  if (command === undefined || ['help', '--help', '-h'].includes(command)) {
    (command === undefined ? console.error : console.log)(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (!COMMANDS.includes(command)) { console.error(`rnrs: unknown command ${JSON.stringify(command)}\n\n${USAGE}`); return 2; }
  const dirGiven = arg !== undefined && !arg.startsWith('-');
  // Outside this repository, package commands default to the current directory.
  if (PACKAGED && PACKAGE_COMMANDS.includes(command) && !dirGiven) arg = '.';
  try {
    if (command === 'init' || command === 'test') {
      const author = await import('./author.mjs');
      const dir = path.resolve(dirGiven ? arg : '.');
      if (command === 'test') return author.testPackage(dir, argv.slice(dirGiven ? 2 : 1));
      const n = author.init(dir, {name: option(argv, '--name'), targets: option(argv, '--targets'), crate: option(argv, '--crate')});
      const where = path.relative(process.cwd(), dir) || '.';
      console.log(`rnrs: initialized ${where}: ${n.spec}, rust/Cargo.toml, rust/src/lib.rs (crate ${n.crate}, trait ${n.iface}, JS ${n.accessor}())`);
      console.log(`rnrs: rustNative.targets is ${n.targets.join(', ')}. This is your declaration of support: rnrs does not check that your Rust code or its dependencies build for these targets, so build each one before publishing.`);
      const code = await main(['generate', dir]);
      if (code) return code;
      if (!['@rnrs/cli', '@rnrs/runtime'].every(name => existsSync(path.join(dir, 'node_modules', name))))
        console.log('rnrs: next: npm install (installs the devDependencies @rnrs/cli and @rnrs/runtime, needed by rnrs test and npm pack)');
      console.log(`rnrs: next: edit ${n.spec} and rust/src/lib.rs, then run npx rnrs test${where === '.' ? '' : ` ${where}`} and npm pack`);
      return 0;
    }
    if (command === 'pack-js') {
      const dir = path.resolve(arg ?? '.');
      const code = packJs(dir);
      const {lintManifest} = await import('./author.mjs');
      const problems = lintManifest(loadPackage(dir));
      if (problems.length) { console.error(problems.join('\n')); return 1; }
      return code;
    }
    if (command === 'bundle' || command === 'build' || command === 'lock') {
      const target = option(argv, '--target');
      const app = path.resolve(option(argv, '--app') ?? '.');
      if (!['android', 'ios', 'web'].includes(target)) throw new GenError('--target must be android, ios or web');
      const out = path.resolve(option(argv, '--out') ?? path.join(app, '.rnr', target));
      const {generateBundle, buildBundle, lockBundle} = await import('./bundle.mjs');
      const abis = (option(argv, '--abi') ?? 'arm64-v8a').split(',');
      // iOS: the Xcode SDK (PLATFORM_NAME) and architectures (ARCHS) being built.
      const sdk = option(argv, '--sdk') ?? 'iphoneos';
      const archs = (option(argv, '--arch') ?? 'arm64').split(',').filter(Boolean);
      const offline = argv.includes('--offline');
      if (command === 'lock') {
        const check = argv.includes('--check');
        const result = lockBundle(app, target, {out, update: argv.includes('--update'), check, offline});
        const rel = path.relative(process.cwd(), result.lock) || result.lock;
        console.log(check ? `rnrs: ${rel} is current` : `rnrs: ${rel} ${result.changed ? 'updated' : 'unchanged'}`);
        return 0;
      }
      const result = command === 'bundle' ? generateBundle(app, target, out)
        : buildBundle(app, target, {out, abis, sdk, archs, offline, ...(argv.includes('--locked') ? {locked: true} : {})});
      console.log(`rnrs: ${target} bundle with ${result.modules.length} module(s): ${result.modules.map(m => `${m.ir.module} (${m.chain.join(' -> ')})`).join(', ') || 'none'}`);
      console.log(`rnrs: crate ${path.relative(process.cwd(), result.crateDir)}`);
      return 0;
    }
    if (command === 'ir') {
      if (!arg) { console.error('usage: rnrs ir <spec.ts>'); return 2; }
      const {ir, diagnostics} = parseSpec(path.resolve(arg), {frameworkSpec: FRAMEWORK_SPEC, root: ROOT});
      if (diagnostics.length) { console.error(diagnostics.map(formatDiagnostic).join('\n')); return 1; }
      console.log(JSON.stringify(ir, null, 2));
      return 0;
    }
    if ((command === 'generate' || command === 'check') && arg) {
      // One author package: only its committed interface (the JS wrapper is `pack-js`).
      const pkg = moduleOnly(loadPackage(path.resolve(arg)), command);
      checkCoreRequirement(pkg);
      const outputs = plan([pkg]).filter(o => o.committed);
      if (command === 'generate') {
        const n = write(outputs, () => true);
        console.log(`rnrs: ${outputs.map(o => path.relative(process.cwd(), o.file)).join(', ')} ${n ? 'updated' : 'unchanged'}`);
        return 0;
      }
      const old = stale(outputs);
      const missing = outputs.filter(o => !existsSync(o.file)).map(o => path.relative(process.cwd(), o.file));
      if (missing.length) { console.error(`rnrs: interface not generated: ${missing.join(', ')}; run rnrs generate ${arg} (or rnrs test) first`); return 1; }
      if (old.length) { console.error(`rnrs: stale interface: ${old.join(', ')}; run rnrs generate ${arg}`); return 1; }
      const {lintManifest} = await import('./author.mjs');
      const problems = lintManifest(pkg);
      if (problems.length) { console.error(problems.join('\n')); return 1; }
      console.log(problems.unchecked ? 'rnrs: interface up to date; package.json entry points reach the wrapper (tarball contents not checked)'
        : 'rnrs: interface up to date; package.json reaches the wrapper and packs the spec, crate and wrapper');
      return 0;
    }
    const packages = appPackages();
    const out = option(argv, '--out');
    const outputs = plan(packages, out ? {genDir: path.resolve(out, 'rnr')} : {});
    if (command === 'generate') {
      const n = write(outputs, () => true);
      console.log(`rnr-gen: ${n} file(s) updated, ${outputs.length - n} unchanged`);
      return 0;
    }
    if (command === 'check' || command === 'build-outputs') {
      const old = stale(outputs);
      if (command === 'build-outputs') {
        const target = option(argv, '--target');
        const manifest = option(argv, '--manifest');
        if (target && !TARGET_BUNDLES[target]) throw new GenError(`unknown bundle target ${target}`);
        if (manifest && target) {
          const errors = checkBundleManifest(manifest, target, packages);
          if (errors.length) throw new GenError(errors.join('\n'));
        }
        const bundled = new Set(packages.filter(p => !target || p.targets.includes(target)).map(p => p.crateIdent));
        write(outputs, o => (o.kind === 'glue' && bundled.has(o.pkg.crateIdent)) || (o.kind === 'bundle' && (!target || o.target === target)));
        for (const dep of dependencies()) console.log(`rnr-gen-dep: ${dep}`);
      }
      if (old.length) {
        console.error(`rnr-gen: committed generated interface(s) are stale:\n  ${old.join('\n  ')}\n` +
          'Run `node tools/rnr-gen/cli.mjs generate` and review the diff.');
        return 1;
      }
      if (command === 'check') console.log(`rnr-gen: ${outputs.filter(o => o.committed).length} committed interface(s) up to date`);
      return 0;
    }
    console.error(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof GenError || ['BundleError', 'AuthorError'].includes(error?.constructor?.name) || error?.message?.includes('rustNative')) { console.error(error.message); return 1; }
    throw error;
  }
}

// Not a top-level await: bundle.mjs imports this module, and its dynamic import in main()
// would wait for this module's evaluation, which would be waiting for main().
if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then(code => process.exit(code));
