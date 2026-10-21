// 16 KB page-size gate for an APK's native libraries. The runtime links librnrs.so (and the Rust
// bundle in it) with -z max-page-size=16384 -z common-page-size=16384; passing this gate does not
// prove runtime compatibility with a 16 KB-page device. For every library of one ABI, extracted from the APK itself (what ships), it records the full LOAD / GNU_RELRO
// segment table and checks, separately:
//   1. LOAD: p_align >= 16384 and p_offset ≡ p_vaddr (mod 16384).
//   2. RELRO hazard: the loader write-protects RELRO rounded out to whole pages (bionic
//      rounds the start down and the end up to the page size). With 16 KB pages, any bytes of
//      a writable LOAD segment that are not RELRO but share a page with it would become
//      read-only. Reported as a violation; an unaligned RELRO end alone is not one.
//   3. APK ZIP: uncompressed .so data 16 KB aligned, and `zipalign -c -P 16 4`.
// Exit status: 0 all checks passed; 1 a violation; 2 could not validate (a tool or the SDK
// is missing, the APK has no libraries for the ABI). Tool paths: RNRS_LLVM_READELF /
// RNRS_ZIPALIGN, else ANDROID_HOME or ANDROID_SDK_ROOT (newest NDK / build-tools), else PATH.
// Usage: node scripts/check-page-size.mjs <app.apk> [abi=arm64-v8a] [out.json]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const PAGE = 16384;

function newest(dir) {
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  return versions.length ? path.join(dir, versions[versions.length - 1]) : null;
}

function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir, name);
    if (dir && existsSync(file)) return file;
  }
  return null;
}

export function findTools(env = process.env) {
  const sdk = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT ?? null;
  const ndk = sdk ? newest(path.join(sdk, 'ndk')) : null;
  const buildTools = sdk ? newest(path.join(sdk, 'build-tools')) : null;
  const fromNdk = ndk
    ? path.join(ndk, 'toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf')
    : null;
  const fromBuildTools = buildTools ? path.join(buildTools, 'zipalign') : null;
  const pick = (explicit, ...candidates) =>
    explicit
      ? existsSync(explicit)
        ? explicit
        : null
      : (candidates.find((c) => c && existsSync(c)) ?? null);
  return {
    readelf: pick(env.RNRS_LLVM_READELF, fromNdk, onPath('llvm-readelf')),
    zipalign: pick(env.RNRS_ZIPALIGN, fromBuildTools, onPath('zipalign')),
    sdk,
  };
}

/** Minimal ZIP reader: entries under lib/<abi>/ (stored or deflated; no ZIP64). */
function libraries(file, abi) {
  const buf = readFileSync(file);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const found = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10),
      size = buf.readUInt32LE(p + 20),
      nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30),
      commentLen = buf.readUInt16LE(p + 32),
      local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.startsWith(`lib/${abi}/`) || !name.endsWith('.so')) continue;
    const data = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(data, data + size);
    found.push({
      name: path.basename(name),
      stored: method === 0,
      dataOffset: data,
      bytes: method === 0 ? raw : zlib.inflateRawSync(raw),
    });
  }
  return found;
}

/** Program headers from `llvm-readelf -lW` (LOAD and GNU_RELRO). */
export function parseSegments(text) {
  return text
    .split('\n')
    .filter((l) => /^\s+(LOAD|GNU_RELRO)\s/.test(l))
    .map((l) => {
      // Type Offset VirtAddr PhysAddr FileSiz MemSiz Flg(may contain spaces, e.g. "R E") Align
      const m = l
        .trim()
        .match(
          /^(\S+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(.+?)\s+(0x[0-9a-f]+)$/i,
        );
      if (!m) throw new Error(`unparsed program header: ${l}`);
      const n = (x) => parseInt(x, 16);
      return {
        type: m[1],
        offset: n(m[2]),
        vaddr: n(m[3]),
        filesz: n(m[5]),
        memsz: n(m[6]),
        flags: m[7].replace(/\s+/g, ''),
        align: n(m[8]),
      };
    });
}

/** Writable non-RELRO bytes that share a page with RELRO when rounded to `page`. */
export function relroHazards(segments, page = PAGE) {
  const relro = segments.find((s) => s.type === 'GNU_RELRO');
  if (!relro) return [];
  const start = relro.vaddr,
    end = relro.vaddr + relro.memsz;
  const guarded = [
    [Math.floor(start / page) * page, start],
    [end, Math.ceil(end / page) * page],
  ];
  const hazards = [];
  for (const s of segments.filter((x) => x.type === 'LOAD' && x.flags.includes('W'))) {
    const lo = s.vaddr,
      hi = s.vaddr + s.memsz;
    for (const [a, b] of guarded) {
      const from = Math.max(a, lo),
        to = Math.min(b, hi);
      if (from < to)
        hazards.push({
          segmentVaddr: `0x${lo.toString(16)}`,
          bytes: `0x${from.toString(16)}-0x${to.toString(16)}`,
        });
    }
  }
  return hazards;
}

export function checkLibrary(segments) {
  const loads = segments.filter((s) => s.type === 'LOAD');
  const relro = segments.find((s) => s.type === 'GNU_RELRO');
  const hazards = relroHazards(segments);
  return {
    loadAligned16k:
      loads.length > 0 && loads.every((s) => s.align >= PAGE && s.offset % PAGE === s.vaddr % PAGE),
    relroEndAligned16k: relro ? (relro.vaddr + relro.memsz) % PAGE === 0 : null,
    relroHazards: hazards,
  };
}

function main([apk, abi = 'arm64-v8a', out]) {
  const tools = findTools();
  const report = {
    apk,
    abi,
    pageSize: PAGE,
    tools,
    status: 'ok',
    libraries: [],
    zip: null,
    problems: [],
  };
  const finish = (code) => {
    if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(
      `status: ${report.status}${report.problems.length ? ` (${report.problems.join('; ')})` : ''}`,
    );
    process.exit(code);
  };
  if (!apk || !existsSync(apk)) {
    report.status = 'unavailable';
    report.problems.push(`APK not found: ${apk}`);
    return finish(2);
  }
  if (!tools.readelf || !tools.zipalign) {
    report.status = 'unavailable';
    report.problems.push(
      `missing tool(s): ${[!tools.readelf && 'llvm-readelf', !tools.zipalign && 'zipalign'].filter(Boolean).join(', ')} (set ANDROID_HOME, RNRS_LLVM_READELF or RNRS_ZIPALIGN)`,
    );
    return finish(2);
  }
  let libs;
  try {
    libs = libraries(apk, abi);
  } catch (error) {
    report.status = 'unavailable';
    report.problems.push(`cannot read ${apk}: ${error.message}`);
    return finish(2);
  }
  if (!libs.length) {
    report.status = 'unavailable';
    report.problems.push(`no lib/${abi}/*.so in the APK`);
    return finish(2);
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'rnrs-pagesize-'));
  try {
    // Anything unexpected while inspecting (a failing or unparsable readelf, a corrupt
    // library) means the APK could not be validated: exit 2, never a pass or a violation.
    try {
      for (const lib of libs) {
        const file = path.join(dir, lib.name);
        writeFileSync(file, lib.bytes);
        const segments = parseSegments(
          execFileSync(tools.readelf, ['-lW', file], { encoding: 'utf8' }),
        );
        const result = checkLibrary(segments);
        const hex = (s) => ({
          ...s,
          offset: `0x${s.offset.toString(16)}`,
          vaddr: `0x${s.vaddr.toString(16)}`,
          filesz: `0x${s.filesz.toString(16)}`,
          memsz: `0x${s.memsz.toString(16)}`,
          align: `0x${s.align.toString(16)}`,
        });
        report.libraries.push({
          name: lib.name,
          segments: segments.map(hex),
          ...result,
          zip: {
            stored: lib.stored,
            dataOffsetAligned16k: lib.stored ? lib.dataOffset % PAGE === 0 : null,
          },
        });
        if (!result.loadAligned16k) report.problems.push(`${lib.name}: LOAD not 16 KB aligned`);
        if (result.relroHazards.length)
          report.problems.push(`${lib.name}: writable data shares a 16 KB page with RELRO`);
        if (lib.stored && lib.dataOffset % PAGE !== 0)
          report.problems.push(`${lib.name}: stored data not 16 KB aligned in the APK`);
      }
    } catch (error) {
      report.status = 'unavailable';
      report.problems = [
        `could not inspect the libraries: ${
          String(error.stderr || error.message)
            .trim()
            .split('\n')[0]
        }`,
      ];
      return finish(2);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  try {
    execFileSync(tools.zipalign, ['-c', '-P', '16', '4', apk], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    report.zip = { zipalignP16: 'ok' };
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (!/Verification FAILED/i.test(output)) {
      // The tool failed without a verification result (cannot run, cannot open the file).
      report.status = 'unavailable';
      report.problems = [
        `zipalign could not verify: ${output.trim().split('\n')[0] || error.message}`,
      ];
      return finish(2);
    }
    report.zip = {
      zipalignP16: 'failed',
      output: output
        .split('\n')
        .filter((l) => /BAD|FAIL/i.test(l))
        .slice(0, 20),
    };
    report.problems.push('zipalign -c -P 16 failed');
  }
  for (const l of report.libraries) {
    const load = l.segments
      .filter((s) => s.type === 'LOAD')
      .map((s) => `${s.flags}@${s.vaddr}+${s.memsz}/${s.align}`)
      .join(' ');
    const relro = l.segments.find((s) => s.type === 'GNU_RELRO');
    console.log(
      `${l.name.padEnd(36)} LOAD ${l.loadAligned16k ? '16K-ok ' : 'NOT-16K'} [${load}] RELRO ${relro ? `${relro.vaddr}+${relro.memsz}` : '-'} ` +
        `end ${l.relroEndAligned16k ? '16K-aligned' : 'unaligned'}, ${l.relroHazards.length ? `HAZARD ${JSON.stringify(l.relroHazards)}` : 'no shared writable page'}`,
    );
  }
  console.log(`zipalign -c -P 16: ${report.zip.zipalignP16}`);
  if (report.problems.length) {
    report.status = 'violation';
    return finish(1);
  }
  return finish(0);
}

// Robust to paths with spaces or other URL-escaped characters.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  main(process.argv.slice(2));
