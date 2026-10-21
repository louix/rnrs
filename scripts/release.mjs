// Release checks and publishing for the public framework packages (@rnrs/cli, @rnrs/runtime,
// @rnrs/surface). Nothing else is ever published: the example and lab packages stay private.
//
//   node scripts/release.mjs check [--dir DIR]
//       Packs (scripts/pack.mjs into DIR, default .generated/release), validates the source
//       tree's framework versions and the three tarballs, and writes DIR/release.json (names,
//       files, sha256, sha512 integrity, source commit) and DIR/SHA256SUMS. Never contacts the
//       registry, so it passes after the version is published (pull requests, main).
//   node scripts/release.mjs plan --dir DIR --tag vX.Y.Z [--sha COMMIT]
//       Re-verifies DIR against release.json, the tag against the version and the source commit,
//       then compares each package with the registry: absent (to publish), the identical
//       tarball (skipped: a resumed release) or a different tarball (fails).
//   node scripts/release.mjs publish --dir DIR --tag vX.Y.Z [--sha COMMIT] [--dry-run]
//       plan, then `npm publish <tarball>` for each absent package in dependency order (cli,
//       runtime, surface), confirming each upload's integrity on the registry.
//
// The runtime depends on the exact CLI version and the CLI peer-depends on the exact runtime,
// so a release interrupted between packages is temporarily uninstallable (npm accepts each
// publish on its own). Re-running publish with the same artifacts completes it; nothing is
// rolled back or unpublished.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPOSITORY_URL = 'git+https://github.com/louix/rnrs.git';
export const REGISTRY = 'https://registry.npmjs.org';
/** The public packages, in publish order (dependencies first), with their source directories. */
export const PUBLIC = [
  { name: '@rnrs/cli', dir: 'packages/cli' },
  { name: '@rnrs/runtime', dir: 'packages/runtime' },
  { name: '@rnrs/surface', dir: 'packages/surface' },
];
/** Framework crates (shipped in @rnrs/runtime and @rnrs/surface) and their manifests. */
const FRAMEWORK_CRATES = {
  'rnrs-core': 'rust/rnrs-core',
  'rnrs-android': 'rust/rnrs-android',
  'rnrs-web': 'rust/rnrs-web',
  'rnrs-log': 'rust/rnrs-log',
  'rnrs-build': 'rust/rnrs-build',
  rnrs: 'rust/rnrs',
  'rnrs-surface': 'packages/surface/rust',
};
const EXACT = /^\d+\.\d+\.\d+$/;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

export class ReleaseError extends Error {}
const fail = (errors) => {
  if (errors.length) throw new ReleaseError(errors.join('\n'));
};

// --- tarballs ---------------------------------------------------------------------------

/** The entries of a gzipped (ustar/pax) tarball: [{ path, data }], with the `package/` prefix removed. */
export function readTarball(bytes) {
  const tar = gunzipSync(bytes);
  const entries = [];
  let pax = null;
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from, len) =>
      header
        .subarray(from, from + len)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const data = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1] ?? null;
      continue;
    }
    const prefix = field(345, 155);
    const name = pax ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    pax = null;
    if (type === '0' || type === '\0') entries.push({ path: name.replace(/^package\//, ''), data });
  }
  return entries;
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** npm's dist.integrity of a tarball. */
export const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/** Checks the three framework tarballs' manifests and contents; returns their version. */
export function checkTarballs(packages, license) {
  const errors = [];
  const names = packages.map((p) => p.manifest.name).sort();
  const want = PUBLIC.map((p) => p.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(want))
    errors.push(`release tarballs must be exactly ${want.join(', ')}; got ${names.join(', ')}`);
  const byName = Object.fromEntries(packages.map((p) => [p.manifest.name, p.manifest]));
  const version = byName['@rnrs/runtime']?.version;
  if (!EXACT.test(version ?? '')) errors.push(`@rnrs/runtime version ${version} is not X.Y.Z`);
  for (const { manifest: m, files } of packages) {
    const at = `${m.name}@${m.version}`;
    if (m.private) errors.push(`${at}: private`);
    if (m.version !== version) errors.push(`${at}: version differs from @rnrs/runtime ${version}`);
    if (m.license !== 'MIT') errors.push(`${at}: license ${m.license}, not MIT`);
    if (m.repository?.url !== REPOSITORY_URL)
      errors.push(`${at}: repository.url ${m.repository?.url}, not ${REPOSITORY_URL}`);
    if (m.publishConfig?.access !== 'public')
      errors.push(`${at}: publishConfig.access is not public`);
    for (const s of INSTALL_SCRIPTS) if (m.scripts?.[s]) errors.push(`${at}: has a ${s} script`);
    for (const [dep, range] of Object.entries(m.dependencies ?? {}))
      if (!EXACT.test(range))
        errors.push(`${at}: dependency ${dep}@${range} is not an exact version`);
    const lic = files.find((f) => f.path === 'LICENSE');
    if (!lic) errors.push(`${at}: no LICENSE`);
    else if (license !== undefined && lic.data.toString('utf8') !== license)
      errors.push(`${at}: LICENSE differs from the repository's`);
    if (!files.some((f) => f.path === 'README.md')) errors.push(`${at}: no README.md`);
  }
  const rt = byName['@rnrs/runtime'];
  const cli = byName['@rnrs/cli'];
  const surface = byName['@rnrs/surface'];
  if (rt && rt.dependencies?.['@rnrs/cli'] !== version)
    errors.push(`@rnrs/runtime must depend on @rnrs/cli ${version} exactly`);
  if (cli && cli.peerDependencies?.['@rnrs/runtime'] !== version)
    errors.push(`@rnrs/cli must peer-depend on @rnrs/runtime ${version} exactly`);
  if (surface && surface.peerDependencies?.['@rnrs/runtime'] !== version)
    errors.push(`@rnrs/surface must peer-depend on @rnrs/runtime ${version} exactly`);
  if (surface && !surface.peerDependenciesMeta?.['react-native']?.optional)
    errors.push('@rnrs/surface: react-native must be an optional peer (browser apps)');
  // The framework crates shipped in the tarballs carry the release version.
  for (const { manifest: m, files } of packages)
    for (const f of files.filter((f) => /^rust\/([\w-]+\/)?Cargo\.toml$/.test(f.path))) {
      const v = /^version\s*=\s*"([^"]+)"/m.exec(f.data.toString('utf8'))?.[1];
      if (v !== version) errors.push(`${m.name}: ${f.path} has version ${v}, not ${version}`);
    }
  fail(errors);
  return version;
}

// --- source tree -------------------------------------------------------------------------

/** Whether Cargo requirement `req` (one comparator) accepts `version`. */
export function cargoAllows(req, version) {
  const m = /^\s*(=|\^|~)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(req);
  if (!m) return false;
  const [, op = '^', ...parts] = m;
  const r = parts.map((x) => (x === undefined ? undefined : Number(x)));
  const v = version.split('.').map(Number);
  const cmp = (a, b) => a.findIndex((x, i) => x !== b[i]);
  if (op === '=') return r.every((x, i) => x === undefined || x === v[i]);
  const filled = r.map((x) => x ?? 0);
  const at = cmp(v, filled);
  if (at !== -1 && v[at] < filled[at]) return false; // below the requirement
  if (op === '~') return v[0] === r[0] && (r[1] === undefined || v[1] === r[1]);
  // Caret: the leftmost non-zero specified component (or the last specified one) is fixed.
  const given = r.filter((x) => x !== undefined).length;
  let fixed = filled.findIndex((x, i) => x !== 0 && i < given);
  if (fixed === -1) fixed = given - 1;
  return v.slice(0, fixed + 1).every((x, i) => x === filled[i]);
}

/** [name, requirement, table] of every framework-crate dependency in a parsed Cargo.toml. */
export function frameworkDeps(toml) {
  const out = [];
  const tables = [toml.dependencies, toml['dev-dependencies'], toml['build-dependencies']];
  for (const t of Object.values(toml.target ?? {}))
    tables.push(t.dependencies, t['dev-dependencies'], t['build-dependencies']);
  for (const table of tables.filter(Boolean))
    for (const [key, spec] of Object.entries(table)) {
      const name = typeof spec === 'object' && spec.package ? spec.package : key;
      if (!(name in FRAMEWORK_CRATES)) continue;
      const req = typeof spec === 'string' ? spec : spec.version;
      if (req !== undefined) out.push([name, req]);
    }
  return out;
}

/** Framework-version literals outside manifests: packed tarball names and generator texts. */
export function versionLiterals(text) {
  const found = [];
  for (const m of text.matchAll(/(?:rnrs-[\w${}.-]*?|\$\{?\w+\}?|')-(\d+\.\d+\.\d+)\.tgz/g))
    found.push({ literal: m[0], version: m[1] });
  // Install specs and manifest requirements on the framework packages.
  for (const m of text.matchAll(/@rnrs\/(?:runtime|cli|surface)@(\d+\.\d+\.\d+)\b/g))
    found.push({ literal: m[0], version: m[1] });
  for (const m of text.matchAll(/"@rnrs\/(?:runtime|cli|surface)": "(\d+\.\d+\.\d+)"/g))
    found.push({ literal: m[0], version: m[1] });
  for (const m of text.matchAll(/rnrs(?:-core|-surface)? = \\?"(\d+\.\d+(?:\.\d+)?)\\?"/g))
    found.push({ literal: m[0], requirement: m[1] });
  return found;
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const readText = (f) => readFileSync(path.join(ROOT, f), 'utf8');

/** Checks that every framework version in the source tree is `version`. */
export async function checkSource(version) {
  const { parse } = await import('smol-toml');
  const errors = [];
  for (const { name, dir } of PUBLIC) {
    const m = JSON.parse(readText(`${dir}/package.json`));
    if (m.name !== name || m.version !== version)
      errors.push(`${dir}/package.json: ${m.name}@${m.version}, expected ${name}@${version}`);
  }
  for (const [crate, dir] of Object.entries(FRAMEWORK_CRATES)) {
    const v = parse(readText(`${dir}/Cargo.toml`)).package?.version;
    if (v !== version) errors.push(`${dir}/Cargo.toml: ${crate} ${v}, expected ${version}`);
  }
  // Every crate in the repository that requires a framework crate accepts this version.
  const tracked = git('ls-files', '*Cargo.toml').split('\n').filter(Boolean);
  for (const f of tracked) {
    for (const [name, req] of frameworkDeps(parse(readText(f))))
      if (!cargoAllows(req, version)) errors.push(`${f}: ${name} = "${req}" rejects ${version}`);
  }
  // Module packages (examples, labs) are released with the framework version they peer on.
  for (const f of git('ls-files', 'packages/*package.json').split('\n').filter(Boolean)) {
    const m = JSON.parse(readText(f));
    if (PUBLIC.some((p) => p.name === m.name)) continue;
    const peer = m.peerDependencies?.['@rnrs/runtime'];
    if (peer === undefined) continue;
    if (!m.private) errors.push(`${f}: ${m.name} must stay private`);
    if (peer !== version) errors.push(`${f}: peer @rnrs/runtime ${peer}, expected ${version}`);
    if (m.version !== version) errors.push(`${f}: version ${m.version}, expected ${version}`);
    const surface = m.dependencies?.['@rnrs/surface'];
    if (surface !== undefined && surface !== version)
      errors.push(`${f}: dependency @rnrs/surface ${surface}, expected ${version}`);
  }
  // The native libraries report the runtime version.
  for (const [f, re] of [
    [
      'packages/runtime/android/src/main/java/dev/rustjsilab/rnrs/RnrsRuntimeModule.kt',
      /const val VERSION = "([^"]+)"/,
    ],
    [
      'packages/runtime/ios/RnrsRuntimeModule.mm',
      /- \(NSString \*\)version\s*\{\s*return @"([^"]+)";/,
    ],
  ]) {
    const v = re.exec(readText(f))?.[1];
    if (v !== version) errors.push(`${f}: native version ${v}, expected ${version}`);
  }
  // Scripts, tests and docs that name packed framework tarballs; generator texts that quote the
  // framework crate requirement.
  const short = version.split('.').slice(0, 2).join('.');
  const scanned = git(
    'ls-files',
    'scripts',
    'tools/rnrs-gen',
    'docs',
    'fixtures/*.mjs',
    'fixtures/*/package.json',
  )
    .split('\n')
    .filter(
      (f) =>
        /\.(mjs|sh|md|json)$/.test(f) &&
        !f.endsWith('package-lock.json') &&
        f !== 'scripts/release.mjs' &&
        f !== 'scripts/release.test.mjs',
    );
  for (const f of scanned) {
    for (const l of versionLiterals(readText(f))) {
      if (l.version !== undefined && l.version !== version)
        errors.push(`${f}: ${l.literal} names version ${l.version}, expected ${version}`);
      if (
        l.requirement !== undefined &&
        f.startsWith('tools/rnrs-gen/') &&
        !f.includes('/test/') &&
        l.requirement !== short
      )
        errors.push(`${f}: ${l.literal}, expected "${short}"`);
    }
  }
  fail(errors);
}

// --- artifacts ----------------------------------------------------------------------------

function loadTarball(dir, file) {
  const bytes = readFileSync(path.join(dir, file));
  const files = readTarball(bytes);
  const pkg = files.find((f) => f.path === 'package.json');
  if (!pkg) throw new ReleaseError(`${file}: no package.json`);
  return { file, bytes, files, manifest: JSON.parse(pkg.data.toString('utf8')) };
}

/** Writes release.json and SHA256SUMS for the framework tarballs in `dir`. */
export function writeArtifacts(dir, packages, version, sourceSha, dirty = false) {
  const release = {
    version,
    sourceSha,
    dirty,
    packages: PUBLIC.map(({ name }) => {
      const p = packages.find((x) => x.manifest.name === name);
      return { name, file: p.file, sha256: sha256(p.bytes), integrity: integrity(p.bytes) };
    }),
  };
  writeFileSync(path.join(dir, 'release.json'), JSON.stringify(release, null, 2) + '\n');
  writeFileSync(
    path.join(dir, 'SHA256SUMS'),
    release.packages.map((p) => `${p.sha256}  ${p.file}\n`).join(''),
  );
  return release;
}

/** Loads release.json and re-verifies every listed tarball (hashes, manifests, allowlist). */
export function verifyArtifacts(dir) {
  const release = JSON.parse(readFileSync(path.join(dir, 'release.json'), 'utf8'));
  const errors = [];
  const packages = [];
  if (
    JSON.stringify(release.packages.map((p) => p.name)) !==
    JSON.stringify(PUBLIC.map((p) => p.name))
  )
    errors.push(
      `release.json must list exactly ${PUBLIC.map((p) => p.name).join(', ')}, in that order`,
    );
  for (const entry of release.packages) {
    if (path.basename(entry.file) !== entry.file)
      errors.push(`${entry.file}: not a plain file name`);
    const p = loadTarball(dir, entry.file);
    if (sha256(p.bytes) !== entry.sha256)
      errors.push(`${entry.file}: sha256 differs from release.json`);
    if (integrity(p.bytes) !== entry.integrity)
      errors.push(`${entry.file}: integrity differs from release.json`);
    if (p.manifest.name !== entry.name)
      errors.push(`${entry.file}: contains ${p.manifest.name}, not ${entry.name}`);
    packages.push({ ...p, entry });
  }
  fail(errors);
  const version = checkTarballs(packages);
  if (version !== release.version)
    fail([`release.json version ${release.version}, tarballs ${version}`]);
  return { release, packages };
}

// --- registry -----------------------------------------------------------------------------

/** 'absent' | 'identical' | 'different' for each package at the release version. */
export async function registryState(release, fetchJson = fetchPackument) {
  const states = [];
  for (const p of release.packages) {
    const doc = await fetchJson(p.name);
    const published = doc?.versions?.[release.version];
    const state = !published
      ? 'absent'
      : published.dist?.integrity === p.integrity
        ? 'identical'
        : 'different';
    states.push({ ...p, state, publishedIntegrity: published?.dist?.integrity });
  }
  return states;
}

async function fetchPackument(name) {
  const res = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new ReleaseError(`${name}: registry responded ${res.status}`);
  return res.json();
}

export function checkTag(release, tag, sha) {
  const errors = [];
  if (tag !== `v${release.version}`)
    errors.push(`tag ${tag} does not match version v${release.version}`);
  if (release.dirty !== false)
    errors.push(`artifacts were built from a tree with uncommitted changes`);
  if (sha !== undefined && sha !== release.sourceSha)
    errors.push(`artifacts were built from ${release.sourceSha}, not ${sha}`);
  fail(errors);
}

// --- commands -----------------------------------------------------------------------------

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (['--dir', '--tag', '--sha'].includes(a)) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

async function check(dir) {
  execFileSync('node', [path.join(ROOT, 'scripts/pack.mjs')], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, RNRS_PACK_OUT: dir },
  });
  const files = readdirSync(dir).filter((f) => /^rnrs-(cli|runtime|surface)-.*\.tgz$/.test(f));
  const packages = files.map((f) => loadTarball(dir, f));
  const version = checkTarballs(packages, readText('LICENSE'));
  await checkSource(version);
  const sourceSha = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain=v1', '--untracked-files=no');
  const release = writeArtifacts(dir, packages, version, sourceSha, dirty !== '');
  for (const p of release.packages) console.log(`${p.file}  ${p.sha256}`);
  console.log(
    `${version} from ${sourceSha}${dirty ? ' (uncommitted changes: not releasable)' : ''}`,
  );
  return { release, dirty };
}

async function plan(dir, tag, sha) {
  const { release } = verifyArtifacts(dir);
  checkTag(release, tag, sha);
  const states = await registryState(release);
  for (const s of states) console.log(`${s.name}@${release.version}: ${s.state}`);
  const different = states.filter((s) => s.state === 'different');
  if (different.length)
    fail(
      different.map(
        (s) =>
          `${s.name}@${release.version} is published with ${s.publishedIntegrity}, not this tarball's ${s.integrity}`,
      ),
    );
  return { release, states };
}

async function publish(dir, tag, sha, dryRun) {
  const { release, states } = await plan(dir, tag, sha);
  const todo = states.filter((s) => s.state === 'absent');
  if (!todo.length) return console.log(`${release.version}: every package is already published`);
  for (const s of todo) {
    const npmArgs = ['publish', path.join(dir, s.file), '--access', 'public', '--tag', 'latest'];
    if (dryRun) npmArgs.push('--dry-run');
    console.log(`npm ${npmArgs.join(' ')}`);
    const r = spawnSync('npm', npmArgs, { stdio: 'inherit' });
    if (r.status !== 0)
      fail([
        `npm publish ${s.name} failed; earlier packages stay published. Re-run publish with the same artifacts to resume.`,
      ]);
    if (dryRun) continue;
    // The registry has the exact tarball (it may take a moment to be visible).
    for (let i = 0; ; i++) {
      const [now] = await registryState({ ...release, packages: [s] });
      if (now.state === 'identical') break;
      if (now.state === 'different' || i === 11)
        fail([`${s.name}@${release.version}: registry reports ${now.state} after publishing`]);
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}

async function main(argv) {
  const a = args(argv);
  const dir = path.resolve(a.dir ?? path.join(ROOT, '.generated/release'));
  const [cmd] = a._;
  if (cmd === 'check') {
    await check(dir);
  } else if (cmd === 'plan' || cmd === 'publish') {
    if (!a.tag) throw new ReleaseError(`${cmd} needs --tag vX.Y.Z`);
    if (!existsSync(path.join(dir, 'release.json')))
      throw new ReleaseError(`${dir}/release.json missing (run check)`);
    if (cmd === 'plan') await plan(dir, a.tag, a.sha);
    else await publish(dir, a.tag, a.sha, a.dryRun);
  } else {
    console.error(
      'usage: release.mjs check [--dir DIR] | plan|publish --dir DIR --tag vX.Y.Z [--sha SHA] [--dry-run]',
    );
    return 2;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof ReleaseError)) throw e;
    console.error(`release: ${e.message}`);
    process.exitCode = 1;
  }
}
