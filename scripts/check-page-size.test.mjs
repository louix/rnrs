import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {checkLibrary, findTools, parseSegments, relroHazards} from './check-page-size.mjs';

const H = (type, offset, vaddr, size, flags, align) =>
  `  ${type.padEnd(14)} 0x${offset.toString(16)} 0x${vaddr.toString(16)} 0x${vaddr.toString(16)} 0x${size.toString(16)} 0x${size.toString(16)} ${flags} 0x${align.toString(16)}`;

test('program headers parse, including the spaced "R E" flags column', () => {
  const segs = parseSegments([H('LOAD', 0, 0, 0x5000, 'R E', 0x4000), H('GNU_RELRO', 0x5000, 0x9000, 0x1000, 'R', 1)].join('\n'));
  assert.deepEqual(segs.map(s => [s.type, s.flags, s.vaddr, s.memsz, s.align]), [['LOAD', 'RE', 0, 0x5000, 0x4000], ['GNU_RELRO', 'R', 0x9000, 0x1000, 1]]);
});

test('an unaligned RELRO end is a hazard only when writable non-RELRO data shares its page', () => {
  // React Native-style layout: RELRO is its own RW LOAD ending at a 4 KB boundary; the next
  // writable LOAD starts on a later 16 KB page -> no hazard.
  const separate = parseSegments([
    H('LOAD', 0, 0, 0x4f30, 'R E', 0x4000), H('LOAD', 0x4f30, 0x4f30, 0x10d0, 'RW', 0x4000),
    H('LOAD', 0x6000, 0x9050, 0x60, 'RW', 0x4000), H('GNU_RELRO', 0x4f30, 0x4f30, 0x10d0, 'R', 1)].join('\n'));
  assert.equal(checkLibrary(separate).relroEndAligned16k, false);
  assert.deepEqual(relroHazards(separate), []);
  // Same RELRO, but the RW LOAD continues past it (.data in the same 16 KB page) -> hazard.
  const shared = parseSegments([
    H('LOAD', 0, 0, 0x4f30, 'R E', 0x4000), H('LOAD', 0x4f30, 0x4f30, 0x3000, 'RW', 0x4000),
    H('GNU_RELRO', 0x4f30, 0x4f30, 0x10d0, 'R', 1)].join('\n'));
  assert.deepEqual(relroHazards(shared), [{segmentVaddr: '0x4f30', bytes: '0x6000-0x7f30'}]);
  // A writable segment ending just before RELRO, in the same page, is a hazard too.
  const before = parseSegments([H('LOAD', 0x8000, 0x8000, 0x100, 'RW', 0x4000), H('LOAD', 0x8100, 0x8100, 0x1f00, 'RW', 0x4000),
    H('GNU_RELRO', 0x8100, 0x8100, 0x3f00, 'R', 1)].join('\n'));
  assert.deepEqual(relroHazards(before), [{segmentVaddr: '0x8000', bytes: '0x8000-0x8100'}]);
});

test('LOAD alignment requires 16 KB p_align and congruent offset/vaddr', () => {
  assert.equal(checkLibrary(parseSegments(H('LOAD', 0, 0, 0x10, 'R E', 0x1000))).loadAligned16k, false);
  assert.equal(checkLibrary(parseSegments(H('LOAD', 0x100, 0x4100, 0x10, 'RW', 0x4000))).loadAligned16k, true);
  assert.equal(checkLibrary(parseSegments(H('LOAD', 0x100, 0x4200, 0x10, 'RW', 0x4000))).loadAligned16k, false);
});

test('missing tools are "unavailable" (exit 2), distinct from a violation', () => {
  assert.deepEqual(findTools({PATH: ''}), {readelf: null, zipalign: null, sdk: null});
  // No SDK, no tools on PATH: unable to validate.
  const run = spawnSync(process.execPath, ['scripts/check-page-size.mjs', 'package.json'], {encoding: 'utf8', env: {PATH: ''}});
  assert.equal(run.status, 2);
  assert.match(run.stdout, /status: unavailable \(missing tool/);
  const none = spawnSync(process.execPath, ['scripts/check-page-size.mjs', 'no-such.apk'], {encoding: 'utf8', env: {PATH: ''}});
  assert.equal(none.status, 2);
  // Tools present (fake executables) but the file is not an APK: still unable to validate.
  const notZip = spawnSync(process.execPath, ['scripts/check-page-size.mjs', 'package.json'], {encoding: 'utf8',
    env: {PATH: '', RNR_LLVM_READELF: process.execPath, RNR_ZIPALIGN: process.execPath}});
  assert.equal(notZip.status, 2);
  assert.match(notZip.stdout, /cannot read package.json/);
});

import {chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** A minimal stored-entry ZIP (enough for the script's reader). */
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name), crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data); centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'rnr page size '));  // a path with spaces
  const tool = (name, body) => { const f = path.join(dir, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
  const apk = path.join(dir, 'app.apk');
  writeFileSync(apk, zip([['lib/arm64-v8a/libcorrupt.so', Buffer.from('not an ELF file')]]));
  return {dir, apk, tool};
}
const run = (args, env) => spawnSync(process.execPath, args, {encoding: 'utf8', env: {PATH: '', ...env}});

test('run from a path with spaces, a missing APK still exits 2 (entry point resolves)', () => {
  const {dir} = fixture();
  try {
    const copy = path.join(dir, 'check page size.mjs');
    copyFileSync('scripts/check-page-size.mjs', copy);
    const r = run([copy, path.join(dir, 'missing.apk')]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /status: unavailable \(APK not found/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a corrupt library (readelf fails) or unparsable readelf output is exit 2, not a violation', () => {
  const {dir, apk, tool} = fixture();
  try {
    const okZip = tool('zipalign', 'exit 0');
    const failing = tool('readelf-fail', 'echo "llvm-readelf: error: not an ELF file" >&2; exit 1');
    let r = run(['scripts/check-page-size.mjs', apk], {RNR_LLVM_READELF: failing, RNR_ZIPALIGN: okZip});
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /could not inspect the libraries: llvm-readelf: error: not an ELF file/);
    const garbage = tool('readelf-garbage', 'echo "  LOAD  this is not a program header"');
    r = run(['scripts/check-page-size.mjs', apk], {RNR_LLVM_READELF: garbage, RNR_ZIPALIGN: okZip});
    assert.equal(r.status, 2);
    assert.match(r.stdout, /could not inspect the libraries: unparsed program header/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('zipalign: a tool error is exit 2; a reported verification failure is a violation (1)', () => {
  const {dir, apk, tool} = fixture();
  try {
    const H = (t, o, v, sz, f, a) => `  ${t} 0x${o.toString(16)} 0x${v.toString(16)} 0x${v.toString(16)} 0x${sz.toString(16)} 0x${sz.toString(16)} ${f} 0x${a.toString(16)}`;
    const good = tool('readelf-good', `echo '${H('LOAD', 0, 0, 0x100, 'R E', 0x4000)}'`);
    const broken = tool('zipalign-broken', 'echo "Unable to open" >&2; exit 1');
    let r = run(['scripts/check-page-size.mjs', apk], {RNR_LLVM_READELF: good, RNR_ZIPALIGN: broken});
    assert.equal(r.status, 2);
    assert.match(r.stdout, /zipalign could not verify: Unable to open/);
    const failed = tool('zipalign-failed', 'echo "Verification FAILED"; exit 1');
    r = run(['scripts/check-page-size.mjs', apk], {RNR_LLVM_READELF: good, RNR_ZIPALIGN: failed});
    assert.equal(r.status, 1);
    assert.match(r.stdout, /status: violation/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
