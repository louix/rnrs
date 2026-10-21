// Reads the parts of Cargo.toml files the generator needs: dependency declarations (with
// `package =` renames, target tables, optional and workspace-inherited entries), the [features]
// table, and which dependencies a crate's active features actually enable.
//
// Syntax is smol-toml's (pinned). On top of it, fail closed: every value this module reads is
// type-checked, and a shape it does not expect is an error naming the file, never skipped.
// Tables are null-prototype objects and every lookup is an own-property lookup, so keys such
// as `__proto__`, `constructor` or `toString` are ordinary keys. The workspace and feature
// logic below models only the parts of cargo's behaviour listed in their comments (an
// over-approximation where noted), not all of it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TomlError, parse } from 'smol-toml';

export class ManifestError extends Error {}

const newTable = () => Object.create(null);
/** A table from parseToml (smol-toml builds every table, inline ones included, with a null
 *  prototype) or built here: never an array, TomlDate or other value. */
export const isTable = (v) =>
  v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === null;
const has = (obj, key) => Object.hasOwn(obj, key);
/** `obj[key]` if it is an own property, else undefined. */
export const own = (obj, key) => (isTable(obj) && has(obj, key) ? obj[key] : undefined);

/** Parses `text` with smol-toml (TOML 1.1, a superset of what cargo accepts: anything cargo
 *  rejects still fails at cargo, nothing is read differently). Strings and booleans are JS
 *  values, integers numbers (bigint beyond 2^53, never rounded), floats numbers, date-times
 *  TomlDate objects. Syntax errors are ManifestErrors with file:line:column. */
export function parseToml(text, file = 'Cargo.toml') {
  try {
    return parse(text, { integersAsBigInt: 'asNeeded' });
  } catch (error) {
    if (!(error instanceof TomlError)) throw error;
    const what = error.message.split('\n')[0].replace(/^Invalid TOML document: /, '');
    throw new ManifestError(`${file}:${error.line}:${error.column}: ${what}`);
  }
}

const KINDS = {
  dependencies: 'normal',
  'build-dependencies': 'build',
  build_dependencies: 'build',
  'dev-dependencies': 'dev',
  dev_dependencies: 'dev',
};

/** Cargo treats `-` and `_` alike in crate identifiers. */
export const sameCrate = (a, b) => a.replace(/-/g, '_') === b.replace(/-/g, '_');

const parseFile = (file) => parseToml(readFileSync(file, 'utf8'), file);

/** A cargo workspace glob (`*`, `?`, `**`) as a RegExp over `/`-separated relative paths. */
function globRegExp(pattern, where) {
  if (/[[\]{}!]/.test(pattern))
    throw new ManifestError(
      `${where}: the workspace pattern ${pattern} is not supported here (only *, ? and **); list the member explicitly`,
    );
  const parts = pattern.split('/').filter((p) => p !== '' && p !== '.');
  const re = parts
    .map((p) =>
      p === '**'
        ? '(?:[^/]+/)*'
        : `${p
            .replace(/[.+^$()|\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]')}/`,
    )
    .join('');
  return new RegExp(`^${re}$`);
}

const slash = (p) => p.split(path.sep).join('/');
const inside = (dir, root) => {
  const r = path.relative(root, dir);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

/** The workspace `cargoToml` belongs to (a subset of cargo's lookup): its own [workspace], the root named
 *  by package.workspace, or the nearest ancestor with [workspace] (unless it excludes the
 *  crate). Returns {file, toml} or null; a crate the found root does not take as a member is an
 *  error, since cargo would refuse to build it. */
export function workspaceOf(cargoToml, toml = parseFile(cargoToml)) {
  if (own(toml, 'workspace') !== undefined) return { file: cargoToml, toml };
  const crateDir = path.dirname(cargoToml);
  const named = own(own(toml, 'package'), 'workspace');
  let rootFile;
  if (named !== undefined) {
    if (typeof named !== 'string')
      throw new ManifestError(`${cargoToml}: package.workspace must be a path string`);
    rootFile = path.join(path.resolve(crateDir, named), 'Cargo.toml');
    if (!existsSync(rootFile) || own(parseFile(rootFile), 'workspace') === undefined)
      throw new ManifestError(
        `${cargoToml}: package.workspace = ${JSON.stringify(named)} does not name a workspace root (${rootFile})`,
      );
  } else {
    for (let dir = path.dirname(crateDir); ; dir = path.dirname(dir)) {
      const file = path.join(dir, 'Cargo.toml');
      if (existsSync(file) && own(parseFile(file), 'workspace') !== undefined) {
        rootFile = file;
        break;
      }
      if (path.dirname(dir) === dir) return null;
    }
  }
  const rootToml = parseFile(rootFile);
  const ws = own(rootToml, 'workspace');
  const rootDir = path.dirname(rootFile);
  const strings = (v, what) => {
    if (v === undefined) return [];
    if (!(Array.isArray(v) && v.every((x) => typeof x === 'string')))
      throw new ManifestError(`${rootFile}: workspace.${what} must be an array of strings`);
    return v;
  };
  const rel = `${slash(path.relative(rootDir, crateDir))}/`;
  const explicit = strings(own(ws, 'members'), 'members').some((m) =>
    globRegExp(m, rootFile).test(rel),
  );
  const excluded = strings(own(ws, 'exclude'), 'exclude').some((e) =>
    inside(crateDir, path.resolve(rootDir, e)),
  );
  if (!explicit && named === undefined && excluded) return null; // cargo: not part of that workspace
  if (explicit) return { file: rootFile, toml: rootToml };
  // Implicit members: path dependencies, inside the workspace, of the root package and members.
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !existsSync(file)) return false;
    seen.add(file);
    if (path.dirname(file) === crateDir) return true;
    for (const d of readDeclarations(file, parseFile(file), { inherit: false }))
      if (d.path && inside(d.path, rootDir) && visit(path.join(d.path, 'Cargo.toml'))) return true;
    return false;
  };
  // From the root package and every member: explicit paths, and the directories (with a
  // Cargo.toml) that member globs match on disk. The disk walk skips target/, node_modules/
  // and dot-directories (a subset of cargo's glob expansion).
  const globs = strings(own(ws, 'members'), 'members').map((m) => globRegExp(m, rootFile));
  const matched = [];
  const walk = (dir, depth) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (
        !e.isDirectory() ||
        e.name.startsWith('.') ||
        e.name === 'target' ||
        e.name === 'node_modules'
      )
        continue;
      const sub = path.join(dir, e.name);
      const relSub = `${slash(path.relative(rootDir, sub))}/`;
      if (existsSync(path.join(sub, 'Cargo.toml')) && globs.some((g) => g.test(relSub)))
        matched.push(path.join(sub, 'Cargo.toml'));
      if (depth > 1) walk(sub, depth - 1);
    }
  };
  const depth = Math.max(
    0,
    ...strings(own(ws, 'members'), 'members').map((m) =>
      m.includes('**') ? 64 : m.split('/').filter(Boolean).length,
    ),
  );
  if (depth > 0) walk(rootDir, depth);
  const starts = [rootFile, ...matched];
  for (const s of starts) if (visit(s)) return { file: rootFile, toml: rootToml };
  throw new ManifestError(
    `${cargoToml}: the crate is inside the workspace ${rootFile} but is not one of its members${excluded ? ' (it is excluded)' : ''}; cargo would refuse to build it: add it to workspace.members${named === undefined ? ', or to workspace.exclude' : ''}`,
  );
}

/** Dependency declarations of one parsed manifest. `inherit: false` leaves `workspace = true`
 *  entries unresolved (membership walks only need paths). */
function readDeclarations(cargoToml, toml, { inherit = true } = {}) {
  const bad = (what) => {
    throw new ManifestError(`${cargoToml}: ${what}`);
  };
  const checkSpec = (where, spec) => {
    if (typeof spec === 'string') return Object.assign(newTable(), { version: spec });
    if (!isTable(spec)) bad(`${where} must be a version string or a table`);
    for (const f of ['package', 'version', 'path', 'git', 'branch', 'tag', 'rev', 'registry'])
      if (has(spec, f) && typeof spec[f] !== 'string') bad(`${where}.${f} must be a string`);
    for (const f of ['optional', 'workspace', 'default-features', 'default_features'])
      if (has(spec, f) && typeof spec[f] !== 'boolean') bad(`${where}.${f} must be true or false`);
    if (
      has(spec, 'features') &&
      !(Array.isArray(spec.features) && spec.features.every((x) => typeof x === 'string'))
    )
      bad(`${where}.features must be an array of strings`);
    return Object.assign(newTable(), spec);
  };
  const target = own(toml, 'target');
  if (target !== undefined && !isTable(target)) bad('target must be a table');
  let ws;
  const deps = [];
  const add = (table, cfg) => {
    if (!isTable(table)) bad(`target.${cfg} must be a table`);
    for (const [name, kind] of Object.entries(KINDS)) {
      const section = own(table, name);
      if (section === undefined) continue;
      const where = `${cfg ? `target.${cfg}.` : ''}${name}`;
      if (!isTable(section)) bad(`[${where}] must be a table`);
      for (const [key, raw] of Object.entries(section)) {
        const spec = checkSpec(`${where}.${key}`, raw);
        const workspace = own(spec, 'workspace') === true;
        let base = newTable();
        if (workspace && inherit) {
          for (const f of [
            'package',
            'version',
            'path',
            'git',
            'branch',
            'tag',
            'rev',
            'registry',
            'default-features',
            'default_features',
          ])
            if (has(spec, f)) bad(`${where}.${key}: ${f} cannot be combined with workspace = true`);
          ws ??= workspaceOf(cargoToml, toml) ?? false;
          const inherited = ws
            ? own(own(own(ws.toml, 'workspace'), 'dependencies'), key)
            : undefined;
          if (inherited === undefined)
            bad(
              `${key} = { workspace = true } has no [workspace.dependencies] entry ${key} in ${ws ? ws.file : 'an enclosing workspace (none found)'}`,
            );
          base = checkSpec(`workspace.dependencies.${key} in ${ws.file}`, inherited);
          if (has(base, 'path')) base.path = path.resolve(path.dirname(ws.file), base.path);
          if (has(base, 'optional'))
            bad(`workspace.dependencies.${key} in ${ws.file}: optional is not allowed there`);
        } else if (has(spec, 'path')) spec.path = path.resolve(path.dirname(cargoToml), spec.path);
        const field = (f) => (has(spec, f) ? spec[f] : has(base, f) ? base[f] : null);
        const defaults = field('default-features') ?? field('default_features');
        deps.push({
          key,
          kind,
          target: cfg,
          optional: own(spec, 'optional') === true,
          workspace,
          features: [...(own(base, 'features') ?? []), ...(own(spec, 'features') ?? [])],
          defaultFeatures: defaults !== false,
          package: field('package') ?? key,
          version: field('version'),
          path: field('path'),
          git: field('git'),
        });
      }
    }
  };
  add(toml, null);
  for (const [cfg, table] of Object.entries(target ?? newTable())) add(table, cfg);
  return deps;
}

/** A crate's manifest: {file, name, deps, features}. `deps`: [{key, package, kind, target,
 *  optional, workspace, features, defaultFeatures, version, path, git}], with `workspace = true`
 *  entries resolved through the crate's workspace. */
export function readManifest(cargoToml) {
  const toml = parseFile(cargoToml);
  const features = own(toml, 'features') ?? newTable();
  if (!isTable(features)) throw new ManifestError(`${cargoToml}: [features] must be a table`);
  for (const [f, list] of Object.entries(features))
    if (!(Array.isArray(list) && list.every((x) => typeof x === 'string')))
      throw new ManifestError(`${cargoToml}: features.${f} must be an array of strings`);
  const name = own(own(toml, 'package'), 'name');
  return {
    file: cargoToml,
    name: typeof name === 'string' ? name : null,
    deps: readDeclarations(cargoToml, toml),
    features,
  };
}

/** What a crate's active features enable, across the crates it reaches through path
 *  dependencies (and framework crates `frameworkManifest(name)` locates, such as rnrs), modelling
 *  this subset of cargo's feature activation: a crate's features start from those requested (its root: `default`
 *  unless `noDefault`, plus `features`, or all with `allFeatures`), expand through [features]
 *  (`f`, `dep:x`, `x/f`, `x?/f` as cargo's resolution counts it, implicit features of optional
 *  dependencies per dependency), and enable
 *  non-optional and enabled optional dependencies, with their requested features. Target tables
 *  count as active (every target is over-approximated); dev-dependencies only for the root with
 *  `dev`. Returns {crates: Map file -> {manifest, features}, enabled: [{from, decl}]}: every
 *  enabled dependency declaration, `from` the manifest declaring it. Each crate entry also has
 *  `by`: [{from, features}], who requested which of its features. */
export function activeDependencies(
  cargoToml,
  {
    dev = false,
    features = [],
    allFeatures = false,
    noDefault = false,
    frameworkManifest = () => null,
  } = {},
) {
  const crates = new Map();
  const enabled = [];
  const queue = [];
  const request = (file, wanted, from = null) => {
    let entry = crates.get(file);
    const fresh = !entry;
    if (fresh) {
      if (!existsSync(file))
        throw new ManifestError(
          `${file}: not found (a path dependency's manifest${from ? ` of ${from.file}` : ''})`,
        );
      entry = {
        manifest: readManifest(file),
        features: new Set(),
        root: crates.size === 0,
        by: [],
      };
      crates.set(file, entry);
    }
    if (from) entry.by.push({ from, features: [...wanted] });
    const before = entry.features.size;
    for (const f of wanted) entry.features.add(f);
    if (fresh || entry.features.size !== before) queue.push(file);
  };
  const rootManifest = readManifest(path.resolve(cargoToml));
  const rootWanted = allFeatures
    ? Object.keys(rootManifest.features)
    : [...features, ...(noDefault ? [] : ['default'])];
  request(path.resolve(cargoToml), rootWanted);
  const done = new Map(); // file -> Set of enabled declaration indexes (to report each once)
  while (queue.length) {
    const file = queue.shift();
    const { manifest, features: wanted, root } = crates.get(file);
    const decls = manifest.deps.filter((d) => d.kind !== 'dev' || (root && dev));
    const byKey = (k) => decls.filter((d) => d.key === k);
    // An optional dependency gets an implicit feature of its name unless some feature names it
    // with `dep:` (cargo suppresses it per dependency, not for the whole crate).
    const viaDep = new Set(
      Object.values(manifest.features).flatMap((l) =>
        l.filter((f) => f.startsWith('dep:')).map((f) => f.slice(4)),
      ),
    );
    const implicit = (k) => !viaDep.has(k) && byKey(k).some((d) => d.optional);
    const active = new Set();
    const on = new Set(); // keys of enabled optional dependencies
    const depFeatures = new Map(); // key -> features requested through `x/f` or `x?/f`
    // One feature entry: `f` (a feature of this crate, or an optional dependency's implicit
    // feature), `dep:x`, `x/f` (enables optional x), or `x?/f`. Cargo compiles `x?/f` only if x
    // is enabled otherwise, but its dependency resolution (cargo metadata's resolve, the lock)
    // includes x, so x must be patched and installed: counted like `x/f` here.
    const entry = (e) => {
      const dep = /^dep:(.+)$/.exec(e);
      const sub = /^([^/?]+)(\?)?\/(.+)$/.exec(e);
      if (dep) on.add(dep[1]);
      else if (sub) {
        if (byKey(sub[1]).some((d) => d.optional)) {
          on.add(sub[1]);
          if (!sub[2] && implicit(sub[1]) && own(manifest.features, sub[1]) === undefined)
            active.add(sub[1]);
        }
        if (!depFeatures.has(sub[1])) depFeatures.set(sub[1], new Set());
        depFeatures.get(sub[1]).add(sub[3]);
      } else expand(e);
    };
    const expand = (f) => {
      if (active.has(f)) return;
      active.add(f);
      const list = own(manifest.features, f);
      if (list !== undefined) for (const e of list) entry(e);
      else if (implicit(f)) on.add(f);
    };
    for (const f of wanted) entry(f);
    const reported = done.get(file) ?? new Set();
    done.set(file, reported);
    manifest.deps.forEach((d, index) => {
      if (!decls.includes(d) || (d.optional && !on.has(d.key))) return;
      if (!reported.has(index)) {
        reported.add(index);
        enabled.push({ from: manifest, decl: d });
      }
      const next = d.path ? path.join(d.path, 'Cargo.toml') : frameworkManifest(d.package);
      if (next)
        request(
          path.resolve(next),
          [
            ...d.features,
            ...(depFeatures.get(d.key) ?? []),
            ...(d.defaultFeatures ? ['default'] : []),
          ],
          manifest,
        );
    });
  }
  return { crates, enabled };
}
