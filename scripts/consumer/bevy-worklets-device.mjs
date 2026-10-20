// One controlled Android gesture/stall/unmount run; no renderer latency inference.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const serial = process.argv[2];
if (!serial) throw new Error('explicit adb serial required');
const adb = (...args) =>
  execFileSync('adb', ['-s', serial, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 1 << 24,
  }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = path.join(root, '.generated/consumer/bevy-worklets');
const apk = path.join(app, 'android/app/build/outputs/apk/release/app-release.apk');
const output = path.join(
  root,
  'results/bevy3d',
  'input-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + serial,
);
mkdirSync(output, { recursive: true });
const result = {
  serial,
  build: JSON.parse(readFileSync(path.join(root, '.generated/consumer/bevy-worklets.build.json'))),
  apkSha256: createHash('sha256').update(readFileSync(apk)).digest('hex'),
  checks: [],
};
const check = (name, ok, detail) => result.checks.push({ name, ok: !!ok, detail });
const reports = (tag) =>
  adb('logcat', '-d', '-s', 'ReactNativeJS:*')
    .split('\n')
    .filter((l) => l.includes(tag + ' '))
    .map((l) => JSON.parse(l.slice(l.indexOf(tag + ' ') + tag.length + 1)));
const latest = () => reports('RNR_INPUT').at(-1);
async function until(test, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = test();
    if (value) return value;
    await sleep(200);
  }
  throw new Error('timed out: ' + label);
}
const swipe = (duration) =>
  new Promise((resolve, reject) => {
    const child = spawn('adb', [
      '-s',
      serial,
      'shell',
      'input',
      'swipe',
      '250',
      '650',
      '1150',
      '650',
      String(duration),
    ]);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('swipe exit ' + code))));
  });
function tap(id) {
  const b = reports('RNR_BUTTON').find((b) => b.id === id);
  if (!b) throw new Error('button missing: ' + id);
  const density = adb('shell', 'wm', 'density');
  const dpi = Number(
    (/Override density: (\d+)/.exec(density) ?? /Physical density: (\d+)/.exec(density))[1],
  );
  const bar = /ITYPE_STATUS_BAR, mFrame=\[0,0\]\[\d+,(\d+)\]/.exec(
    adb('shell', 'dumpsys', 'window', 'windows'),
  );
  // RN 0.88's template is edge-to-edge: layout y then needs no status-bar offset.
  const edgeToEdge = /^edgeToEdgeEnabled=true$/m.test(
    readFileSync(path.join(app, 'android/gradle.properties'), 'utf8'),
  );
  adb(
    'shell',
    'input',
    'tap',
    String(Math.round(((b.x + b.w / 2) * dpi) / 160)),
    String(Math.round(((b.y + b.h / 2) * dpi) / 160 + (bar && !edgeToEdge ? Number(bar[1]) : 0))),
  );
}
try {
  check(
    'clean committed source APK',
    result.build.sourceClean && result.build.apkSha256 === result.apkSha256,
    result.build,
  );
  if (adb('get-state') !== 'device') throw new Error('device unavailable');
  adb('install', '-r', apk);
  adb('shell', 'am', 'force-stop', 'com.helloworld');
  adb('logcat', '-b', 'all', '-c');
  adb('shell', 'am', 'start', '-n', 'com.helloworld/.MainActivity');
  const ready = await until(
    () => {
      const v = latest();
      return v?.stats.gpuState === 'ready' && v.stats.framesPresented > 0 && v;
    },
    'Bevy ready',
    120000,
  );
  await swipe(800);
  const gesture = await until(() => {
    const v = latest();
    return v?.stats.inputApplied > 0 && v;
  }, 'gesture applied');
  check(
    'real UI pan accepted in Rust and applied by Bevy',
    gesture.gesture.accepted > 0 &&
      gesture.stats.angle !== ready.stats.angle &&
      gesture.stats.paused,
    { ready, gesture },
  );
  writeFileSync(
    path.join(output, 'gesture.png'),
    execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p']),
  );
  tap('Stall JS');
  await until(() => reports('RNR_STALL_ARMED').length, 'stall armed');
  await swipe(2400);
  const stall = await until(() => reports('RNR_STALL').at(-1), 'stall finished');
  check(
    'Rust receipt continues inside 1.5 second RN JS stall',
    stall.after.inputReceived > stall.before.inputReceived && stall.elapsedMs >= 1500,
    stall,
  );
  await until(() => {
    const v = latest();
    return v?.stats.inputApplied === v?.stats.inputReceived && v;
  }, 'latest sample consumed');
  tap('Unmount');
  const closed = await until(() => {
    const v = latest();
    return v?.stats.state === 'closed' && v;
  }, 'scene closed after component unmount');
  await swipe(800);
  const late = await until(() => {
    const v = latest();
    return v?.gesture.refused > closed.gesture.refused && v;
  }, 'late gesture refused');
  check(
    'late real gesture after unmount safely refused',
    late.stats.inputReceived === closed.stats.inputReceived && late.stats.state === 'closed',
    { closed, late },
  );
  check('unexpected worklet errors absent', !late.gesture.unexpected, late.gesture);
  check(
    'surface lifecycle and renderer healthy',
    late.stats.detachTimeouts === 0 && late.stats.lastError === null,
    late.stats,
  );
  check('process survived', !!adb('shell', 'pidof', 'com.helloworld'));
} catch (error) {
  check('run completed', false, String(error));
} finally {
  writeFileSync(
    path.join(output, 'logcat.txt'),
    adb('logcat', '-d', '-s', 'ReactNativeJS:*', 'RnrRuntime:*', 'RNR:*'),
  );
  const crashes = adb('logcat', '-d', '-b', 'crash');
  check('no app crash', !crashes.includes('com.helloworld'), crashes);
  adb('shell', 'am', 'force-stop', 'com.helloworld');
}
result.ok = result.checks.every((c) => c.ok);
writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log((result.ok ? 'PASS ' : 'FAIL ') + output);
for (const c of result.checks) console.log((c.ok ? 'ok ' : 'FAIL ') + c.name);
process.exitCode = result.ok ? 0 : 1;
