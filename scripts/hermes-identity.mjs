// Records how the consumer's prebuilt Hermes relates to the hermes-v0.14.0 source tag, without a
// device: the AAR's hashes, the tag's commit, a byte comparison of every prefab header in the AAR
// with the tag's API/ or public/ copy, and the sha256 of each tag source file the trial reports
// read. Supporting evidence only: the VM's own source revision stays unproven.
//
// Usage (inside `nix develop`, network access to github.com): node scripts/hermes-identity.mjs <out.json>
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const out = process.argv[2];
if (!out) throw new Error('usage: hermes-identity.mjs <out.json>');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG = 'hermes-v0.14.0';
const VERSION = '0.14.0';
const RAW = `https://raw.githubusercontent.com/facebook/hermes/${TAG}`;
const sha = b => createHash('sha256').update(b).digest('hex');
const base = path.join(ROOT, '.generated/gradle/caches/modules-2/files-2.1/com.facebook.hermes/hermes-android', VERSION);
const aar = readdirSync(base).map(h => path.join(base, h, `hermes-android-${VERSION}-release.aar`)).find(existsSync);
if (!aar) throw new Error(`no hermes-android-${VERSION} AAR under ${base}`);
const unzip = (...a) => execFileSync('unzip', a, {maxBuffer: 1 << 28});
const PREFIX = 'prefab/modules/hermesvm/include/';
const headers = unzip('-Z1', aar).toString().split('\n').filter(n => n.startsWith(PREFIX) && n.endsWith('.h'));
const fetchBytes = async url => { const r = await fetch(url); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; };

const tagCommit = execFileSync('git', ['ls-remote', 'https://github.com/facebook/hermes', `refs/tags/${TAG}`, `refs/tags/${TAG}^{}`], {encoding: 'utf8'}).trim().split('\n').map(l => l.split('\t'));
const rows = [];
for (const h of headers) {
  const rel = h.slice(PREFIX.length);
  const mine = unzip('-p', aar, h);
  let where = null, theirs = null;
  for (const dir of ['API', 'public']) {
    theirs = await fetchBytes(`${RAW}/${dir}/${rel}`);
    if (theirs) { where = `${dir}/${rel}`; break; }
  }
  rows.push({header: rel, aarSha256: sha(mine), tagPath: where, tagSha256: theirs ? sha(theirs) : null, identical: !!theirs && sha(theirs) === sha(mine)});
}
const SOURCES = ['lib/VM/JSLib/HermesInternal.cpp', 'include/hermes/VM/GCBase.h', 'lib/VM/GCBase.cpp', 'lib/VM/gcs/HadesGC.cpp', 'lib/VM/JSLib/Array.cpp', 'lib/VM/JSArray.cpp',
  'include/hermes/VM/JSArray.h', 'include/hermes/VM/SegmentedArray.h', 'lib/VM/SegmentedArray.cpp', 'include/hermes/VM/SmallHermesValue-inline.h', 'include/hermes/VM/SmallHermesValue.h', 'CMakeLists.txt'];
const sources = [];
for (const s of SOURCES) { const b = await fetchBytes(`${RAW}/${s}`); sources.push({path: s, sha256: b ? sha(b) : null}); }
const result = {
  note: 'Supporting evidence only; the prebuilt VM records no source commit, so its revision and build flags remain unproven.',
  aar: path.relative(ROOT, aar), aarSha256: sha(readFileSync(aar)), aarLibhermesvmArm64Sha256: sha(unzip('-p', aar, 'jni/arm64-v8a/libhermesvm.so')),
  tag: TAG, tagRefs: tagCommit, headers: {count: rows.length, identical: rows.filter(r => r.identical).length, rows}, sourcesRead: sources,
  generator: {script: 'scripts/hermes-identity.mjs', sha256: sha(readFileSync(fileURLToPath(import.meta.url))), head: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim()},
};
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(`${result.headers.identical}/${result.headers.count} headers identical; tag refs ${JSON.stringify(tagCommit)}`);
