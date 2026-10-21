// Runs the worklets lab APK (scripts/consumer/worklets-app.sh) on one explicitly named
// device and reads its RNRS_WORKLETS result from logcat. Every adb call passes `-s SERIAL`;
// the adb server is never restarted or killed. The Pixel 8a (42261JEKB07916) belongs to the
// surface work and is refused. The app (com.helloworld) is uninstalled afterwards.
// Usage (inside `nix develop`): ANDROID_SERIAL=711KPTM0646609 node scripts/consumer/worklets-device-test.mjs [out.json]
// RNRS_COMMIT is recorded with the result.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = 'worklets-lab';
const APK = path.join(
  ROOT,
  '.generated/consumer',
  NAME,
  'android/app/build/outputs/apk/release/app-release.apk',
);
const PACKAGE = 'com.helloworld';
const SERIAL = process.env.ANDROID_SERIAL;
const RESERVED = ['42261JEKB07916'];
if (!SERIAL)
  throw new Error(
    'set ANDROID_SERIAL explicitly (the worklets lab uses the Pixel 2 XL, 711KPTM0646609)',
  );
if (RESERVED.includes(SERIAL)) throw new Error(`${SERIAL} is reserved for the surface work`);
const adb = (...args) =>
  execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8', timeout: 120000 }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reassembles the chunked "RNRS_WORKLETS <run> <i>/<n> <text>" lines of the latest complete run.
function readResult(log) {
  const runs = new Map();
  for (const line of log.split(/\r?\n/)) {
    const m = /RNRS_WORKLETS (\w+) (\d+)\/(\d+) (.*)$/.exec(line);
    if (!m) continue;
    const run = runs.get(m[1]) ?? { n: Number(m[3]), parts: [] };
    run.parts[Number(m[2]) - 1] = m[4];
    runs.set(m[1], run);
  }
  const complete = [...runs.values()]
    .filter((r) => r.parts.filter((p) => p !== undefined).length === r.n)
    .map((r) => JSON.parse(r.parts.join('')));
  // A run that reloads reports once per runtime; it is done when a runtime does not reload.
  const done = complete.find((r) => !r.reload);
  if (!done) return undefined;
  if (complete.length === 1) return done;
  const iterations = complete.map((r) => ({ iteration: r.iteration, stage: r.stage, ok: r.ok }));
  const checks = complete.flatMap((r) =>
    r.checks.map((c) => ({ ...c, name: `[${r.iteration ?? '?'}] ${c.name}` })),
  );
  return { ok: complete.every((r) => r.ok), stage: done.stage, iterations, checks, runs: complete };
}

let result;
let logcat = '';
try {
  adb('install', '-r', APK);
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); // W6 swipes need the screen on
  adb('logcat', '-c');
  adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
  const swiped = new Set();
  for (let i = 0; i < 300 && !result; i++) {
    await sleep(1000);
    // W6/W5a: the app asks for one round of swipes per "RNRS_WORKLETS_SWIPE <tag>" line.
    const requests = [
      ...adb('logcat', '-d', '-s', 'ReactNativeJS:*').matchAll(/RNRS_WORKLETS_SWIPE (\S+)/g),
    ]
      .map((m) => m[1])
      .filter((tag) => !swiped.has(tag));
    for (const tag of new Set(requests)) {
      swiped.add(tag);
      const [w, h] = adb('shell', 'wm', 'size')
        .match(/(\d+)x(\d+)/)
        .slice(1)
        .map(Number);
      for (let s = 0; s < 4; s++) {
        adb(
          'shell',
          'input',
          'swipe',
          String(Math.round(w * 0.2)),
          String(Math.round(h * 0.45)),
          String(Math.round(w * 0.8)),
          String(Math.round(h * 0.75)),
          '700',
        );
        adb(
          'shell',
          'input',
          'swipe',
          String(Math.round(w * 0.8)),
          String(Math.round(h * 0.75)),
          String(Math.round(w * 0.2)),
          String(Math.round(h * 0.45)),
          '700',
        );
      }
    }
    result = readResult(adb('logcat', '-d', '-s', 'ReactNativeJS:*'));
    // A crash ends the run (the crash buffer is read again below).
    if (!result && i % 5 === 4 && adb('logcat', '-d', '-b', 'crash').includes(PACKAGE)) break;
  }
  logcat = adb(
    'logcat',
    '-d',
    '-s',
    'ReactNativeJS:*',
    'rnrs:*',
    'AndroidRuntime:E',
    'libc:F',
    'DEBUG:F',
  );
  const crashes = adb('logcat', '-d', '-b', 'crash');
  if (crashes.includes(PACKAGE)) result = { ...result, ok: false, crash: crashes };
} finally {
  try {
    adb('shell', 'am', 'force-stop', PACKAGE);
    adb('uninstall', PACKAGE);
  } catch {
    /* best effort */
  }
}
if (!result) result = { ok: false, error: 'no final RNRS_WORKLETS result within 300 s' };
const buildRecord = path.join(ROOT, '.generated/consumer', `${NAME}.build.json`);
if (existsSync(buildRecord)) result.build = JSON.parse(readFileSync(buildRecord, 'utf8'));
result.device = {
  serial: SERIAL,
  model: adb('shell', 'getprop', 'ro.product.model'),
  sdk: adb('shell', 'getprop', 'ro.build.version.sdk'),
};
result.provenance = {
  commit: process.env.RNRS_COMMIT ?? null,
  apkSha256: execFileSync('sha256sum', [APK], { encoding: 'utf8' }).split(' ')[0],
};
result.logcatTail = logcat
  .split('\n')
  .filter((l) => !l.includes('RNRS_WORKLETS '))
  .slice(-60);
for (const c of result.checks ?? []) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name} ${c.detail}`);
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2));
console.log(
  result.ok
    ? `OK: worklets lab ${result.stage} passed on ${SERIAL}`
    : `FAILED: ${result.error ?? 'see checks'}`,
);
process.exit(result.ok ? 0 : 1);
