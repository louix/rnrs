// Consumer side of rnr: discover an app's Rust modules from its dependency graph, check
// their targets and committed interfaces, generate a standalone per-app bundle crate (an
// Android or iOS staticlib, or a Wasm cdylib) and build it. Nothing here is module-specific.
//
// Discovery rules: start from the app's package.json `dependencies` (not devDependencies,
// not peerDependencies), resolve each through node_modules like Node does (walking up from
// the depending package), and follow the `dependencies` and installed
// `optionalDependencies` of every resolved package. A package is a Rust module if its
// package.json has a `rustNative` field. Packages that are only workspace siblings or dev
// tools of the app are therefore never bundled. A selected module that does not declare the
// requested target is an error naming the dependency chain; nothing is silently dropped.
// A package whose `rustNative` declares `library` instead of a spec is a Rust library crate
// (for example @rnrs/surface): selected and target-checked the same way, but only patched
// into the bundle under its crate name, so module crates can depend on it by version.
//
// Lock files: the app owns one Cargo.lock per target, `<app>/rnr-<target>.Cargo.lock`
// (committed by the app, outside the regenerated bundle directory). Builds copy it into the
// bundle crate and build with `--locked`, so dependency versions do not drift; without one,
// the first build creates it. `--locked` (or RNR_LOCKED=1) additionally requires it to exist.
// `rnrs lock` updates it deliberately. Cargo records path dependencies (modules, framework
// crates) by name and version only, so the lock holds no machine-specific paths.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  FRAMEWORK_CRATES,
  FRAMEWORK_RUST,
  isFrameworkCrate,
  loadPackage,
  plan,
  writeAtomic,
} from './cli.mjs';
import { emitGlue } from './emit-rust.mjs';
import { activeDependencies, readManifest, sameCrate } from './cargo-manifest.mjs';

export class BundleError extends Error {}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Node-style lookup of `name` from `fromDir` (no `exports` evaluation needed). */
export function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The app's Rust modules: [{pkg, chain}] in discovery order (deduplicated by path). */
export function discoverModules(appDir) {
  const app = readJson(path.join(appDir, 'package.json'));
  const seen = new Set([realpathSync(appDir)]);
  const modules = [];
  const visit = (dir, manifest, chain) => {
    const deps = { ...manifest.optionalDependencies, ...manifest.dependencies };
    for (const name of Object.keys(deps)) {
      const resolved = resolvePackageDir(name, dir);
      if (!resolved) {
        if (manifest.optionalDependencies?.[name] && !manifest.dependencies?.[name]) continue; // optional, not installed
        throw new BundleError(
          `${[...chain, name].join(' -> ')}: dependency ${name} is not installed (run npm install)`,
        );
      }
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      const child = readJson(path.join(resolved, 'package.json'));
      const childChain = [...chain, name];
      if (child.rustNative) modules.push({ dir: resolved, chain: childChain });
      visit(resolved, child, childChain);
    }
  };
  visit(appDir, app, [app.name ?? 'app']);
  return modules;
}

/** Loads and validates the selected modules for `target`. */
export function selectModules(appDir, target) {
  const found = discoverModules(appDir);
  const errors = [];
  const selected = [];
  for (const { dir, chain } of found) {
    let pkg;
    try {
      pkg = loadPackage(dir);
    } catch (error) {
      errors.push(`${chain.join(' -> ')}: ${error.message}`);
      continue;
    }
    if (!pkg.targets.includes(target)) {
      errors.push(
        `${chain.join(' -> ')}: ${path.basename(dir)} declares rustNative.targets [${pkg.targets.join(', ')}] and cannot be bundled for ${target}. ` +
          `Remove the dependency for ${target} builds, or add "${target}" to its targets once an implementation exists.`,
      );
      continue;
    }
    pkg.chain = chain;
    pkg.manifestPath = chain.join(' -> '); // how generator diagnostics name the package
    selected.push(pkg);
  }
  const crates = new Map();
  for (const pkg of selected) {
    const ident = pkg.crate.replace(/-/g, '_');
    if (isFrameworkCrate(pkg.crate))
      errors.push(
        `${pkg.chain.join(' -> ')}: the Rust crate name ${pkg.crate} is reserved for the framework`,
      );
    if (crates.has(ident))
      errors.push(
        `two modules use the Rust crate name ${pkg.crate}: ${crates.get(ident)} and ${pkg.chain.join(' -> ')}`,
      );
    crates.set(ident, pkg.chain.join(' -> '));
  }
  // Rust crates named rnr-* are the framework's namespace: a module crate may depend on one
  // only if this app installs the package that provides it (framework crates come with
  // @rnrs/runtime). Otherwise cargo would look for it on crates.io.
  const provided = new Set(
    [...FRAMEWORK_CRATES, ...selected.map((p) => p.crate)].map((c) => c.replace(/-/g, '_')),
  );
  for (const pkg of selected) {
    const needed = frameworkNeeds(pkg);
    for (const [dep, how] of needed) {
      if (provided.has(dep.replace(/-/g, '_'))) continue;
      const hint = KNOWN_LIBRARIES[dep]
        ? `; add ${KNOWN_LIBRARIES[dep]} to the app's dependencies`
        : '';
      errors.push(
        `${pkg.chain.join(' -> ')}: its crate ${how}, which no installed package provides (rnr-* crates are never taken from crates.io)${hint}`,
      );
    }
  }
  // React Native autolinking links native code (Android/iOS libraries, codegen components)
  // only for the app's direct dependencies; a transitive one would be bundled for Rust but
  // its views and native glue would be missing at run time.
  if (target === 'android' || target === 'ios') {
    const app = readJson(path.join(appDir, 'package.json'));
    const direct = new Set(Object.keys({ ...app.dependencies, ...app.optionalDependencies }));
    for (const pkg of selected) {
      const name = readJson(path.join(pkg.dir, 'package.json')).name;
      if (hasNativePlatformCode(pkg.dir) && !direct.has(name))
        errors.push(
          `${pkg.chain.join(' -> ')}: ${name} contains native platform code, which React Native autolinking links only for the app's direct dependencies; add ${name} to the app's dependencies`,
        );
    }
  }
  if (errors.length) throw new BundleError(errors.join('\n'));
  return selected;
}

/** Where the bundle takes the rnrs facade from (it is patched to this copy). */
const RNRS_MANIFEST = () => path.resolve(FRAMEWORK_RUST, 'rnrs', 'Cargo.toml');

/** What `pkg`'s crate enables with its active features (cargo's activation, see
 *  activeDependencies): the bundle builds modules with their default features; `rnrs test` passes
 *  `dev` and the cargo feature flags. rnrs is followed into the framework copy, so the library
 *  crates its enabled features need are included. */
function activation(pkg, options = {}) {
  return activeDependencies(path.resolve(pkg.cratePath, 'Cargo.toml'), {
    ...options,
    frameworkManifest: (name) => (sameCrate(name, 'rnrs') ? RNRS_MANIFEST() : null),
  });
}

/** Framework-namespace crates (rnr-*, rnrs) `pkg`'s crate needs with its active features,
 *  directly or through crates it reaches by path, including library crates that enabled rnrs
 *  features need: Map name -> reason. */
export function frameworkNeeds(pkg, options = {}) {
  const root = path.resolve(pkg.cratePath, 'Cargo.toml');
  const { crates, enabled } = activation(pkg, options);
  const through = (m) => (m.file === root ? '' : ` (through ${m.name ?? m.file})`);
  const needed = new Map();
  for (const { from, decl } of enabled) {
    if (!isFrameworkNamespace(decl.package) || needed.has(decl.package)) continue;
    if (from.file !== RNRS_MANIFEST()) {
      needed.set(decl.package, `depends on ${decl.package}${through(from)}`);
      continue;
    }
    // Enabled inside rnrs: name the rnrs features that were asked for, and by whom.
    const asked = crates
      .get(RNRS_MANIFEST())
      .by.find((b) => b.features.some((f) => f !== 'default'));
    const features = asked ? [...new Set(asked.features.filter((f) => f !== 'default'))] : [];
    needed.set(
      decl.package,
      `enables rnrs's ${features.map((f) => `"${f}"`).join(', ')} feature${features.length > 1 ? 's' : ''}${asked ? through(asked.from) : ''}, which needs ${decl.package}`,
    );
  }
  return needed;
}

/** Library crates the framework ships in npm packages, for diagnostics. */
export const KNOWN_LIBRARIES = { 'rnr-surface': '@rnrs/surface' };

/** Crate names the framework reserves: rnr-* and the rnrs facade. */
export const isFrameworkNamespace = (name) => /^rnr[-_]/.test(name) || sameCrate(name, 'rnrs');

/** Library crates the rnrs facade's features pull in (rust/rnrs/Cargo.toml [features]). */
const RNRS_FEATURE_CRATES = { surface: 'rnr-surface' };

/** Framework-namespace packages a parsed manifest depends on (normal and build dependencies,
 *  any target; dev-dependencies are not part of the bundle). */
const frameworkNamespace = (manifest) =>
  manifest.deps
    .filter((d) => d.kind !== 'dev' && isFrameworkNamespace(d.package))
    .map((d) => d.package);

/** Names of framework-namespace crates (rnr-*, rnrs) a Cargo.toml depends on. */
export function rnrCrateDependencies(cargoToml) {
  return [...new Set(frameworkNamespace(readManifest(cargoToml)))];
}

/** Whether any selected crate, or a crate it reaches by path, enables the rnrs facade: only
 *  then does the bundle patch it (an unused patch is recorded in Cargo.lock as
 *  [[patch.unused]] and would invalidate existing app locks; a disabled optional rnrs is not
 *  resolved, so it needs no patch). */
export function usesRnrs(selected) {
  return selected.some((pkg) =>
    activation(pkg).enabled.some(({ decl }) => sameCrate(decl.package, 'rnrs')),
  );
}

/** Explains cargo's failure to find a framework crate (a dependency through a registry crate,
 *  which no scan of the app's packages can see, or an rnrs feature whose library package is
 *  not installed): such names are never taken from crates.io. */
export function explainMissing(stderr) {
  const m = /no matching package named `([A-Za-z0-9_-]+)`/.exec(stderr);
  if (!m || !isFrameworkNamespace(m[1])) return stderr;
  const name = m[1];
  const fix = sameCrate(name, 'rnrs')
    ? "rnrs is provided by @rnrs/runtime and patched into the bundle only when one of the app's module crates (or a crate they reach through path dependencies) depends on it; a crate that reaches rnrs another way (a registry or git dependency) is not supported: depend on rnrs from the module crate itself"
    : KNOWN_LIBRARIES[name]
      ? `${name} comes from ${KNOWN_LIBRARIES[name]}: add it to the app's dependencies (it is needed, for example, by rnrs's "${Object.keys(RNRS_FEATURE_CRATES).find((f) => RNRS_FEATURE_CRATES[f] === name) ?? name}" feature)`
      : `no installed package provides ${name}`;
  return `${stderr.trimEnd()}\n${name} is a framework crate, never taken from crates.io: ${fix}.\n`;
}

/** Whether a package has native code that autolinking must link. */
function hasNativePlatformCode(dir) {
  return (
    existsSync(path.join(dir, 'react-native.config.js')) ||
    existsSync(path.join(dir, 'android/build.gradle')) ||
    readdirSync(dir).some((f) => f.endsWith('.podspec'))
  );
}

const toml = (value) => JSON.stringify(value.split(path.sep).join('/'));

/** The app's Rust logging choice (`rustNativeApp.logging` in its package.json), fixed at build
 *  time: null (default: off, nothing linked), `{mode: 'managed', filter, iosPrivacy}` (the
 *  bundle installs rnr-log's subscriber and log bridge at startup), or `{mode: 'external'}`
 *  (rnr-log is linked for an app-owned subscriber; rnr installs nothing). */
export function appLogging(appDir) {
  const app = readJson(path.join(appDir, 'package.json'));
  const logging = app.rustNativeApp?.logging;
  if (logging === undefined) return null;
  const where = "rustNativeApp.logging in the app's package.json";
  if (logging === null || typeof logging !== 'object' || Array.isArray(logging))
    throw new BundleError(`${where} must be an object, e.g. {"filter": "info"}`);
  const mode = logging.mode ?? 'managed';
  if (mode === 'external') {
    const extra = Object.keys(logging).filter((k) => k !== 'mode');
    if (extra.length)
      throw new BundleError(
        `${where}: ${extra.join(', ')} cannot be used with "mode": "external" (the app's own subscriber decides)`,
      );
    return { mode };
  }
  if (mode !== 'managed')
    throw new BundleError(
      `${where}: "mode" must be "managed" (default) or "external", got ${JSON.stringify(mode)}`,
    );
  const unknown = Object.keys(logging).filter((k) => !['mode', 'filter', 'iosPrivacy'].includes(k));
  if (unknown.length)
    throw new BundleError(
      `${where}: unknown key(s) ${unknown.join(', ')}; allowed: mode, filter, iosPrivacy`,
    );
  const filter = logging.filter ?? 'info';
  // The filter is validated by the Targets parser itself when the bundle builds (its build
  // script); here only what can be embedded safely in generated Rust source.
  if (typeof filter !== 'string' || !/^[\x20-\x7e]*$/.test(filter) || /["\\]/.test(filter))
    throw new BundleError(
      `${where}: "filter" must be a string of printable ASCII without quotes or backslashes (tracing Targets directives such as "info,sled=warn")`,
    );
  const iosPrivacy = logging.iosPrivacy ?? 'private';
  if (!['private', 'public'].includes(iosPrivacy))
    throw new BundleError(
      `${where}: "iosPrivacy" must be "private" (default) or "public", got ${JSON.stringify(iosPrivacy)}`,
    );
  return { mode, filter, iosPrivacy };
}

/** Writes the per-app bundle crate into `outDir`; returns {crateDir, modules}. */
export function generateBundle(appDir, target, outDir) {
  const selected = selectModules(appDir, target);
  const modules = selected.filter((p) => !p.library);
  const libraries = selected.filter((p) => p.library);
  const outputs = plan(modules);
  for (const pkg of modules) {
    // The committed interface must be what this rnr version generates from the spec.
    const iface = outputs.find(
      (o) => o.kind === 'interface' && o.file === path.join(pkg.cratePath, 'src/rnr_interface.rs'),
    );
    const current = existsSync(iface.file) ? readFileSync(iface.file, 'utf8') : null;
    if (current !== iface.content)
      throw new BundleError(
        `${pkg.chain.join(' -> ')}: ${path.relative(pkg.dir, iface.file)} does not match its spec for this rnr version; the package must be regenerated (rnrs generate) and republished`,
      );
  }
  const crateDir = path.join(outDir, 'bundle');
  // Android and iOS share the native JSI backend crate (named rnr-android for history).
  const native = target === 'android' || target === 'ios';
  const backend = native ? 'rnr-android' : 'rnr-web';
  const deps = [
    `rnr-core = { path = ${toml(path.join(FRAMEWORK_RUST, 'rnr-core'))}${native ? ', features = ["tokio"]' : ''} }`,
    `${backend} = { path = ${toml(path.join(FRAMEWORK_RUST, backend))} }`,
    ...(target === 'web' ? [`wasm-bindgen = "=${wasmBindgenVersion()}"`] : []),
    ...modules.map((p) => `${p.crate} = { path = ${toml(p.cratePath)} }`),
  ];
  const webSurface =
    target === 'web' ? libraries.find((p) => p.crate === 'rnr-surface') : undefined;
  if (webSurface) deps.push(`rnr-surface = { path = ${toml(webSurface.cratePath)} }`);
  // Rust logging (off unless the app opts in): rnr-log for managed and external modes; in
  // managed mode the build script validates the filter with the same Targets parser.
  const logging = appLogging(appDir);
  if (logging) deps.push(`rnr-log = { path = ${toml(path.join(FRAMEWORK_RUST, 'rnr-log'))} }`);
  const managed = logging?.mode === 'managed';
  const buildDeps = managed
    ? `\n[build-dependencies]\ntracing-subscriber = { version = "0.3", default-features = false, features = ["registry", "std"] }\n`
    : '';
  const privacy = managed && logging.iosPrivacy === 'public' ? 'Public' : 'Private';
  const install = managed
    ? `    rnr_log::install_for_bundle(${JSON.stringify(logging.filter)}, rnr_log::Privacy::${privacy});\n`
    : '';
  const rnrs = usesRnrs(selected)
    ? `rnrs = { path = ${toml(path.join(FRAMEWORK_RUST, 'rnrs'))} }\n`
    : '';
  const cargo = `# @generated by rnrs bundle (${target}); do not edit. Rebuilt from the app's dependencies.
[package]
name = "rnr-bundle"
version = "0.0.0"
edition = "2021"
publish = false

[lib]
path = "src/lib.rs"
crate-type = [${native ? '"staticlib"' : '"cdylib"'}]

[dependencies]
${deps.join('\n')}
${buildDeps}
# Modules depend on rnr-core = "0.1"${rnrs ? ' or rnrs = "0.1"' : ''}; resolve ${rnrs ? 'them to the framework copies' : 'it to this framework copy'}${libraries.length ? ", and library packages' crates to their installed copies" : ''}.
[patch.crates-io]
rnr-core = { path = ${toml(path.join(FRAMEWORK_RUST, 'rnr-core'))} }
${rnrs}${libraries.map((p) => `${p.crate} = { path = ${toml(p.cratePath)} }\n`).join('')}
# A standalone workspace: never part of an enclosing one.
[workspace]

[profile.release]
opt-level = 3
panic = "abort"
`;
  const mods = modules.map((p) => {
    const ident = p.crate.replace(/-/g, '_');
    return {
      ident,
      file: `glue/${ident}.rs`,
      content: emitGlue(p.ir, { crate: ident, moduleType: p.moduleType }),
    };
  });
  const list = `&[${mods.map((m) => `&glue::${m.ident}::MODULE`).join(', ')}]`;
  const lib = `// @generated by rnrs bundle (${target}); do not edit.
// Modules: ${modules.map((p) => `${p.ir.module} (${p.chain.join(' -> ')})`).join('; ') || 'none'}
${libraries.length ? `// Library crates: ${libraries.map((p) => `${p.crate} (${p.chain.join(' -> ')})`).join('; ')}\n` : ''}#![allow(clippy::all)]
mod glue {
${mods.map((m) => `    pub mod ${m.ident} {\n        include!(${JSON.stringify(m.file)});\n    }`).join('\n')}
}

static MODULES: &[&rnr_core::bind::ModuleDef] = ${list};
${
  native
    ? `pub use rnr_android::*;

/// Registers the bundled modules; called once by the framework JSI adapter.
#[no_mangle]
pub extern "C" fn rnr_bundle_init() {
${install}    rnr_android::register(MODULES);
}
`
    : `#[wasm_bindgen::prelude::wasm_bindgen(start)]
fn start() {
${install}    rnr_web::register(MODULES);
${webSurface ? '    rnr_surface::web_exports::keep_exports();' : ''}
}
`
}`;
  // Everything under the output directory is generated; keep it out of version control.
  const ignore = "# Generated by rnr from the app's dependencies; never commit.\n*\n";
  writeAtomic(path.join(outDir, '.gitignore'), ignore);
  const rnrDir = path.join(appDir, '.rnr');
  if (path.resolve(outDir).startsWith(path.resolve(rnrDir) + path.sep))
    writeAtomic(path.join(rnrDir, '.gitignore'), ignore);
  writeAtomic(path.join(crateDir, 'Cargo.toml'), cargo);
  writeAtomic(path.join(crateDir, 'src/lib.rs'), lib);
  // Managed logging: the build fails (rnrs build, Gradle, Xcode) if the filter is not valid
  // tracing Targets syntax, checked by the parser the runtime uses.
  const buildRs = path.join(crateDir, 'build.rs');
  if (managed) {
    writeAtomic(
      buildRs,
      `// @generated by rnrs bundle; do not edit. Validates rustNativeApp.logging.filter.
fn main() {
    let filter = ${JSON.stringify(logging.filter)};
    if let Err(error) = filter.parse::<tracing_subscriber::filter::Targets>() {
        panic!("rustNativeApp.logging.filter {filter:?} in the app's package.json is not a valid tracing Targets filter: {error}");
    }
}
`,
    );
  } else {
    rmSync(buildRs, { force: true });
  }
  for (const m of mods) writeAtomic(path.join(crateDir, 'src', m.file), m.content);
  // The app's lock is the source of truth: copy it in, or drop a lock left by an earlier
  // build so resolution starts from what the app has committed.
  const appLock = lockFile(appDir, target);
  const bundleLock = path.join(crateDir, 'Cargo.lock');
  if (existsSync(appLock)) writeAtomic(bundleLock, readFileSync(appLock, 'utf8'));
  else rmSync(bundleLock, { force: true });
  return { crateDir, modules, libraries };
}

/** The app-owned lock file for `target`. */
export const lockFile = (appDir, target) => path.join(appDir, `rnr-${target}.Cargo.lock`);

const cargoFlags = ({ offline }) => (offline ? ['--offline'] : []);

/** Resolves the bundle (`cargo metadata`, which also writes its Cargo.lock unless
 *  `locked`). Returns {ok, stderr}; on success also checks framework-crate provenance. */
function resolve(manifest, cargo, { locked = false, env = process.env, ...options } = {}) {
  const args = [
    'metadata',
    '--format-version',
    '1',
    ...(locked ? ['--locked'] : []),
    '--manifest-path',
    manifest,
    ...cargoFlags(options),
  ];
  const result = spawnSync(cargo, args, { encoding: 'utf8', maxBuffer: 1 << 28, env });
  if (result.error)
    throw new BundleError(
      `cannot run ${cargo}: ${result.error.message}` +
        (result.error.code === 'ENOENT'
          ? '. Install Rust with rustup (tested toolchain: 1.90.0), or set RNR_CARGO to a cargo executable.'
          : ''),
    );
  if (result.status !== 0) return { ok: false, stderr: explainMissing(result.stderr) };
  checkProvenance(JSON.parse(result.stdout), options.libraries);
  return { ok: true, stderr: '' };
}
const lockIsCurrent = (manifest, cargo, options) =>
  resolve(manifest, cargo, { ...options, locked: true });

/** The framework crates must resolve to this framework's own copies. `rnr-core` is not
 *  published and its crates.io name is not reserved: a module whose requirement the patch
 *  cannot satisfy would otherwise make cargo fetch an unrelated crates.io package. */
export function checkProvenance(metadata, libraries = []) {
  const libraryErrors = [];
  // Library packages' crates must resolve to the installed package, not to a registry crate
  // of the same name (the bundle patches them; an unsatisfiable requirement would not).
  for (const lib of libraries) {
    for (const pkg of metadata.packages.filter((p) => p.name === lib.crate)) {
      const expected = path.join(lib.cratePath, 'Cargo.toml');
      if (pkg.source !== null || realpathSync(pkg.manifest_path) !== realpathSync(expected))
        libraryErrors.push(
          `${lib.crate} ${pkg.version} resolved from ${pkg.source ?? pkg.manifest_path}, not the installed library package ${lib.chain.join(' -> ')} (${expected})`,
        );
    }
  }
  if (libraryErrors.length)
    throw new BundleError(
      `${libraryErrors.join('\n')}\nA module requires a version of this library crate that the installed package does not provide; ` +
        'align that requirement with the installed library package rather than letting cargo fetch a crates.io package of the same name.',
    );
  const errors = [];
  for (const name of ['rnr-core', 'rnr-android', 'rnr-web', 'rnr-log', 'rnrs']) {
    for (const pkg of metadata.packages.filter((p) => p.name === name)) {
      const expected = path.join(FRAMEWORK_RUST, name, 'Cargo.toml');
      if (pkg.source !== null || realpathSync(pkg.manifest_path) !== realpathSync(expected))
        errors.push(
          `${name} ${pkg.version} resolved from ${pkg.source ?? pkg.manifest_path}, not the framework's ${expected}`,
        );
    }
  }
  if (errors.length)
    throw new BundleError(
      `${errors.join('\n')}\nA module requires a framework crate version this @rnrs/runtime does not provide (it patches rnr-core = "0.1"); ` +
        "fix the module's rnr-core requirement rather than letting cargo fetch an unrelated crates.io package.",
    );
  // Nothing else in the rnr-* namespace may come from a registry or git either, whether or not
  // a package declared it (a module requiring rnr-surface without @rnrs/surface installed).
  const foreign = metadata.packages.filter(
    (p) => isFrameworkNamespace(p.name) && p.source !== null,
  );
  if (foreign.length)
    throw new BundleError(
      foreign.map((p) => `${p.name} ${p.version} resolved from ${p.source}`).join('\n') +
        '\nCrates named rnr-* are reserved for the framework and its npm library packages and are never taken from a registry; install the package that provides it.',
    );
}

/** With tracing's `log-always` feature every tracing event is also emitted as a `log` record,
 *  which the managed log bridge would feed back as a second event. Returns null if the
 *  resolved tracing has no `log-always`, else the packages that enable it ("name version",
 *  directly in a dependency declaration or through one of their enabled features). */
export function logAlwaysEnablers(metadata) {
  const tracing = new Set(metadata.packages.filter((p) => p.name === 'tracing').map((p) => p.id));
  const nodes = metadata.resolve?.nodes ?? [];
  if (!nodes.some((n) => tracing.has(n.id) && n.features.includes('log-always'))) return null;
  const byId = new Map(metadata.packages.map((p) => [p.id, p]));
  const enablers = [];
  for (const node of nodes) {
    const pkg = byId.get(node.id);
    if (!pkg) continue;
    const direct = pkg.dependencies.some(
      (d) => d.name === 'tracing' && (d.features ?? []).includes('log-always'),
    );
    const viaFeature = node.features.filter((f) =>
      (pkg.features?.[f] ?? []).some((x) => /^tracing\??\/log-always$/.test(x)),
    );
    if (direct) enablers.push(`${pkg.name} ${pkg.version}`);
    else if (viaFeature.length)
      enablers.push(`${pkg.name} ${pkg.version} (its feature ${viaFeature.join(', ')})`);
  }
  return enablers.length ? enablers : ['(not attributable to a dependency declaration)'];
}

/** Managed logging only: fails before compiling if `log-always` is on for this target. */
function checkLogAlways(manifest, cargo, triple, { locked, offline, env }) {
  const args = [
    'metadata',
    '--format-version',
    '1',
    '--filter-platform',
    triple,
    ...(locked ? ['--locked'] : []),
    '--manifest-path',
    manifest,
    ...cargoFlags({ offline }),
  ];
  const result = spawnSync(cargo, args, { encoding: 'utf8', maxBuffer: 1 << 28, env });
  if (result.error || result.status !== 0)
    throw new BundleError(
      `cargo metadata --filter-platform ${triple} failed:\n${result.stderr ?? result.error?.message}`,
    );
  const enablers = logAlwaysEnablers(JSON.parse(result.stdout));
  if (enablers)
    throw new BundleError(
      `rustNativeApp.logging is managed, but tracing's "log-always" feature is enabled for ${triple} by: ${enablers.join('; ')}. ` +
        'With it every tracing event would also arrive through the log bridge, twice. Remove that feature, or use "logging": {"mode": "external"} with your own subscriber.',
    );
}

function staleLockError(appDir, target, stderr) {
  const rel = path.relative(process.cwd(), lockFile(appDir, target)) || lockFile(appDir, target);
  return new BundleError(
    `${rel} does not match the app's Rust dependencies for ${target}. Run \`npx rnrs lock --target ${target}\` (add --update to also upgrade) and commit the result.\n${stderr.trim()}`,
  );
}

/** `rnrs lock`: brings the app's lock up to date (keeping locked versions; `update` upgrades
 *  them), or with `check` verifies it exists and is current without writing. */
export function lockBundle(
  appDir,
  target,
  { out, cargo = process.env.RNR_CARGO ?? 'cargo', update = false, check = false, offline = false },
) {
  const { crateDir, modules, libraries } = generateBundle(appDir, target, out);
  const manifest = path.join(crateDir, 'Cargo.toml');
  const appLock = lockFile(appDir, target);
  if (check) {
    if (!existsSync(appLock))
      throw new BundleError(
        `${path.relative(process.cwd(), appLock)} is missing; run \`npx rnrs lock --target ${target}\` and commit it`,
      );
    const current = lockIsCurrent(manifest, cargo, { offline, libraries });
    if (!current.ok) throw staleLockError(appDir, target, current.stderr);
    return { crateDir, modules, lock: appLock, changed: false };
  }
  if (update) run(cargo, ['update', '--manifest-path', manifest, ...cargoFlags({ offline })]);
  const resolved = resolve(manifest, cargo, { offline, libraries });
  if (!resolved.ok)
    throw new BundleError(
      `cargo could not resolve the bundle's dependencies:\n${resolved.stderr.trim()}`,
    );
  const changed = writeAtomic(appLock, readFileSync(path.join(crateDir, 'Cargo.lock'), 'utf8'));
  return { crateDir, modules, lock: appLock, changed };
}

export const ANDROID_TRIPLES = {
  'arm64-v8a': 'aarch64-linux-android',
  'armeabi-v7a': 'armv7-linux-androideabi',
  x86: 'i686-linux-android',
  x86_64: 'x86_64-linux-android',
};

/** iOS: Rust triple for each (Xcode PLATFORM_NAME, architecture). */
export const IOS_TRIPLES = {
  iphoneos: { arm64: 'aarch64-apple-ios' },
  iphonesimulator: { arm64: 'aarch64-apple-ios-sim', x86_64: 'x86_64-apple-ios' },
};
/** React Native's minimum iOS version (15.1 in 0.83 through 0.88), when Xcode passes none. */
export const IOS_DEPLOYMENT_TARGET = '15.1';

/** The environment cargo runs in for iOS. An Xcode script phase exports hundreds of build
 *  settings, SDKROOT for the iOS SDK, and a PATH that starts with Xcode's toolchain
 *  directories, whose clang (unlike the /usr/bin/cc shim) finds no SDK on its own. Build
 *  scripts are compiled and linked for the macOS host, so under that environment they fail
 *  (`ld: library 'System' not found`). Cargo therefore gets only an allowlisted environment
 *  with those PATH entries removed; it and the cc crate select each target's SDK through
 *  xcrun. */
const IOS_ENV_ALLOW =
  /^(HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_\w+|TERM|DEVELOPER_DIR|IPHONEOS_DEPLOYMENT_TARGET|RUSTUP_\w+|CARGO\w*|RUSTC\w*|RUSTFLAGS|RUSTDOCFLAGS|RNR_\w+|(CC|CXX|AR|CFLAGS|CXXFLAGS)_\w+|SSL_CERT_\w+|NIX_SSL_CERT_FILE|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy)$/;
export function iosCargoEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (IOS_ENV_ALLOW.test(key)) out[key] = value;
  const xcode = env.DEVELOPER_DIR ?? '/Applications/Xcode.app/Contents/Developer';
  out.PATH = (env.PATH ?? '')
    .split(':')
    .filter((p) => p && !p.startsWith(xcode) && !p.includes('.app/Contents/Developer/'))
    .join(':');
  out.IPHONEOS_DEPLOYMENT_TARGET = env.IPHONEOS_DEPLOYMENT_TARGET || IOS_DEPLOYMENT_TARGET;
  return out;
}

/** The triples to build for an iOS SDK and its architectures, or an actionable error. */
export function iosTriples(sdk, archs) {
  const table = IOS_TRIPLES[sdk];
  if (!table)
    throw new BundleError(
      `unsupported iOS SDK ${JSON.stringify(sdk)}; supported: ${Object.keys(IOS_TRIPLES).join(', ')}`,
    );
  if (!archs.length) throw new BundleError(`no architectures given for ${sdk}`);
  return archs.map((arch) => {
    const triple = table[arch];
    if (!triple)
      throw new BundleError(
        `unsupported architecture ${JSON.stringify(arch)} for ${sdk}; supported: ${Object.keys(table).join(', ')}`,
      );
    return triple;
  });
}

/** The exact wasm-bindgen version the framework's rnr-web crate pins; the CLI must match it. */
export function wasmBindgenVersion() {
  const toml = readFileSync(path.join(FRAMEWORK_RUST, 'rnr-web/Cargo.toml'), 'utf8');
  const version = toml.match(/^wasm-bindgen\s*=\s*"=([^"]+)"/m)?.[1];
  if (!version)
    throw new BundleError(
      'rnr-web/Cargo.toml does not pin wasm-bindgen exactly (wasm-bindgen = "=x.y.z")',
    );
  return version;
}

/** Fails before compiling unless the wasm-bindgen CLI is the pinned version. */
export function checkWasmBindgen(wasmBindgen, env = process.env) {
  const want = wasmBindgenVersion();
  const fix =
    `Install it with \`cargo install wasm-bindgen-cli --version ${want} --locked\` (or use a shell that provides it), ` +
    'and put it on PATH or set RNR_WASM_BINDGEN to its path.';
  const result = spawnSync(wasmBindgen, ['--version'], { encoding: 'utf8', env });
  if (result.error || result.status !== 0)
    throw new BundleError(
      `the web build needs the wasm-bindgen CLI ${want}, but ${wasmBindgen} could not be run (${result.error?.message ?? `exit ${result.status}`}). ${fix}`,
    );
  const have = result.stdout.match(/(\d+\.\d+\.\d+)/)?.[1];
  if (have !== want)
    throw new BundleError(
      `the web build needs the wasm-bindgen CLI ${want} (the version the framework pins), but ${wasmBindgen} is ${have ?? result.stdout.trim()}. ${fix}`,
    );
}

/** Fails before compiling if the active Rust toolchain lacks `triple`. Skipped with a custom
 *  RNR_CARGO and no RUSTC (rustc on PATH may be another toolchain) or when rustc cannot be
 *  run; cargo then reports the problem itself. */
export function checkRustTarget(triple, env = process.env) {
  if (env.RNR_CARGO && !env.RUSTC) return;
  const rustc = env.RUSTC || 'rustc';
  const sysroot = spawnSync(rustc, ['--print', 'sysroot'], { encoding: 'utf8', env });
  if (sysroot.error || sysroot.status !== 0) return;
  if (existsSync(path.join(sysroot.stdout.trim(), 'lib/rustlib', triple))) return;
  const version = spawnSync(rustc, ['--version'], { encoding: 'utf8', env }).stdout?.trim();
  throw new BundleError(
    `the Rust target ${triple} is not installed for the active toolchain (${version}). ` +
      `Run \`rustup target add ${triple}\` in the shell that builds (tested toolchain: 1.90.0, e.g. RUSTUP_TOOLCHAIN=1.90.0).`,
  );
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error)
    throw new BundleError(
      `cannot run ${command}: ${result.error.message}` +
        (result.error.code === 'ENOENT' && /cargo/.test(path.basename(command))
          ? '. Install Rust with rustup (tested toolchain: 1.90.0), or set RNR_CARGO to a cargo executable.'
          : ''),
    );
  if (result.status !== 0)
    throw new BundleError(`${command} ${args.join(' ')} failed (exit ${result.status})`);
}

/** Generates and builds the bundle. Android: one staticlib per ABI under
 *  `<out>/target/<triple>/release/librnr_bundle.a`. iOS: one staticlib per SDK (iphoneos,
 *  iphonesimulator), all requested architectures combined, at `<out>/lib/<sdk>/librnr_bundle.a`.
 *  Web: wasm-bindgen output in `<out>/pkg`. */
export function buildBundle(
  appDir,
  target,
  {
    out,
    abis = ['arm64-v8a'],
    sdk = 'iphoneos',
    archs = ['arm64'],
    cargo = process.env.RNR_CARGO ?? 'cargo',
    wasmBindgen = process.env.RNR_WASM_BINDGEN ?? 'wasm-bindgen',
    locked = /^(1|true)$/i.test(process.env.RNR_LOCKED ?? ''),
    offline = false,
  },
) {
  const appLock = lockFile(appDir, target);
  const hadLock = existsSync(appLock);
  if (locked && !hadLock)
    throw new BundleError(
      `${path.relative(process.cwd(), appLock)} is missing, and --locked (or RNR_LOCKED=1) requires the app's committed lock. Run \`npx rnrs lock --target ${target}\` and commit it.`,
    );
  const { crateDir, modules, libraries } = generateBundle(appDir, target, out);
  const targetDir = path.join(out, 'target');
  const manifest = path.join(crateDir, 'Cargo.toml');
  const env = target === 'ios' ? iosCargoEnv() : process.env;
  const triples = target === 'ios' ? iosTriples(sdk, archs) : [];
  // Resolve first: checks the committed lock (or writes a new one) and framework-crate
  // provenance before anything is compiled.
  const resolved = resolve(manifest, cargo, { locked: hadLock, offline, env, libraries });
  // Prerequisites, checked before anything is compiled.
  const buildTriples =
    target === 'android'
      ? abis.map((abi) => ANDROID_TRIPLES[abi]).filter(Boolean)
      : target === 'ios'
        ? triples
        : ['wasm32-unknown-unknown'];
  if (resolved.ok) for (const triple of buildTriples) checkRustTarget(triple, env);
  if (resolved.ok && target === 'web') checkWasmBindgen(wasmBindgen, env);
  if (!resolved.ok) {
    if (hadLock) throw staleLockError(appDir, target, resolved.stderr);
    throw new BundleError(
      `cargo could not resolve the bundle's dependencies:\n${resolved.stderr.trim()}`,
    );
  }
  // RNR_BUNDLE_FEATURES (diagnostics builds only, e.g. "rnr-web/diagnostics" or
  // "rnr-android/diagnostics" for the native JSI backend crate).
  const features = env.RNR_BUNDLE_FEATURES ? ['--features', env.RNR_BUNDLE_FEATURES] : [];
  const lockArgs = [...(hadLock ? ['--locked'] : []), ...cargoFlags({ offline }), ...features];
  if (appLogging(appDir)?.mode === 'managed') {
    for (const triple of buildTriples)
      checkLogAlways(manifest, cargo, triple, { locked: hadLock, offline, env });
  }
  if (target === 'android') {
    for (const abi of abis) {
      const triple = ANDROID_TRIPLES[abi];
      if (!triple) throw new BundleError(`unsupported Android ABI ${abi}`);
      run(cargo, [
        'build',
        '--release',
        '--target',
        triple,
        '--manifest-path',
        manifest,
        '--target-dir',
        targetDir,
        ...lockArgs,
      ]);
    }
  } else if (target === 'ios') {
    for (const triple of triples)
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
          ...lockArgs,
        ],
        { env },
      );
    const libs = triples.map((t) => path.join(targetDir, t, 'release/librnr_bundle.a'));
    const lib = path.join(out, 'lib', sdk, 'librnr_bundle.a');
    mkdirSync(path.dirname(lib), { recursive: true });
    // Replace atomically, so an interrupted build never leaves a truncated library to link.
    const tmp = `${lib}.${process.pid}.tmp`;
    if (libs.length === 1) copyFileSync(libs[0], tmp);
    else run('lipo', ['-create', ...libs, '-output', tmp]);
    renameSync(tmp, lib);
  } else {
    run(cargo, [
      'build',
      '--release',
      '--target',
      'wasm32-unknown-unknown',
      '--manifest-path',
      manifest,
      '--target-dir',
      targetDir,
      ...lockArgs,
    ]);
    run(wasmBindgen, [
      '--target',
      'web',
      '--weak-refs',
      '--out-dir',
      path.join(out, 'pkg'),
      '--out-name',
      'rnr_bundle',
      path.join(targetDir, 'wasm32-unknown-unknown/release/rnr_bundle.wasm'),
    ]);
  }
  if (!hadLock) {
    writeAtomic(appLock, readFileSync(path.join(crateDir, 'Cargo.lock'), 'utf8'));
    console.log(
      `rnrs: created ${path.relative(process.cwd(), appLock) || appLock}; commit it so builds use these dependency versions (CI: --locked)`,
    );
  }
  return { crateDir, modules, targetDir };
}
