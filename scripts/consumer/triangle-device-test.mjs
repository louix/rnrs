// Android device run of the rnrs::gpu triangle (fixtures/triangle-consumer, built by
// `FIXTURE=triangle-consumer MODULES=labs-webgpu-triangle PACKS=rnrs-surface NAME=triangle-app scripts/consumer/rn-app.sh`).
//
// Usage (inside `nix develop`): node scripts/consumer/triangle-device-test.mjs <adb-serial>
//
// Checks, from `RNRS_TRIANGLE_STATS` and raw screenshots: ready and presenting; orange triangle
// pixels on screen (the device's own GPU, not a readback); redraws follow the one-per-second
// background change rather than running continuously (Next::Wait); background then foreground
// re-attaches with a new setup and presents again; rotation resizes; a process restart presents
// again; no detach timeout, crash or GPU error in the app's log.
// Writes results/triangle/runs/<UTC timestamp>-<serial>/ (ignored); uninstalls com.helloworld.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { triangleShape } from './triangle-shape.mjs';

const serial = process.argv[2];
if (!serial) throw new Error('usage: triangle-device-test.mjs <adb-serial>');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APK = path.join(
  ROOT,
  '.generated/consumer',
  process.env.NAME ?? 'triangle-app',
  'android/app/build/outputs/apk/release/app-release.apk',
);
const PACKAGE = 'com.helloworld';
const adb = (...args) =>
  execFileSync('adb', ['-s', serial, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 1 << 26,
  }).trim();
const adbRaw = (...args) =>
  execFileSync('adb', ['-s', serial, ...args], { timeout: 60000, maxBuffer: 1 << 28 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (adb('get-state') !== 'device') throw new Error(`${serial} is not connected`);
if (!existsSync(APK)) throw new Error(`${APK} missing; build the consumer first`);
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z');
const run = path.join(ROOT, 'results/triangle/runs', `${stamp}-${serial}`);
mkdirSync(run, { recursive: true });

const stats = () =>
  adb('logcat', '-d', '-s', 'ReactNativeJS:*')
    .split('\n')
    .filter((l) => l.includes('RNRS_TRIANGLE_STATS '))
    .map((l) => JSON.parse(l.slice(l.indexOf('RNRS_TRIANGLE_STATS ') + 19)));
const latest = () => stats().at(-1);
async function waitFor(pred, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > end)
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(latest())}`);
    await sleep(500);
  }
}
const start = () => adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
/** The triangle's geometry in a raw screenshot (RGBA after a 12- or 16-byte header), for a
 *  surface of the size the stats report (triangle-shape.mjs); also saves a PNG. */
function triangleOnScreen(name, stats) {
  const raw = adbRaw('exec-out', 'screencap');
  const width = raw.readUInt32LE(0),
    height = raw.readUInt32LE(4);
  writeFileSync(path.join(run, `${name}.png`), adbRaw('exec-out', 'screencap', '-p'));
  const pixels = raw.subarray(raw.length - width * height * 4);
  return triangleShape(
    { width, height, channels: 4, pixels },
    { width: stats.surfaceWidth, height: stats.surfaceHeight },
  );
}
const result = {
  serial,
  model: adb('shell', 'getprop', 'ro.product.model'),
  build: adb('shell', 'getprop', 'ro.build.fingerprint'),
  checks: [],
};
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
};
const rotation = {
  auto: adb('shell', 'settings', 'get', 'system', 'accelerometer_rotation'),
  user: adb('shell', 'settings', 'get', 'system', 'user_rotation'),
};
const ready =
  (after = {}) =>
  (s) =>
    s &&
    s.state === 'attached' &&
    s.gpuState === 'ready' &&
    s.framesSubmitted > (after.framesSubmitted ?? 0) &&
    s;
try {
  adb('install', '-r', APK);
  adb('logcat', '-b', 'all', '-c');
  start();
  const first = await waitFor(() => ready()(latest()), 60000, 'ready and presenting');
  check('ready and presenting', first.lastError === null, first);
  await sleep(1500);
  const shot = triangleOnScreen('steady', first);
  check('the triangle on screen (orange region with its geometry)', shot.ok, shot);

  // Redraw on change only: about one frame per background change, not 60 per second.
  const a = latest();
  await sleep(5000);
  const b = latest();
  const frames = b.framesSubmitted - a.framesSubmitted,
    changes = b.changes - a.changes;
  check(
    'redraws follow state changes (no continuous drawing)',
    frames >= 1 && frames <= changes + 3,
    { frames, changes, seconds: 5 },
  );

  // Background and foreground: a new attachment, a new setup, presenting again.
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(3000);
  start();
  const fg = await waitFor(
    () => ready(b)(latest()) && latest().initsStarted > b.initsStarted && latest(),
    20000,
    'presenting after foreground',
  );
  check('foreground: re-attached with a new setup and presenting', fg.lastError === null, {
    before: b,
    after: fg,
  });

  // Rotation: the surface resizes and presents at the new size.
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '1');
  const rot = await waitFor(
    () => ready(fg)(latest()) && latest().surfaceWidth > fg.surfaceWidth && latest(),
    20000,
    'rotated',
  );
  check('rotation: presenting at the wider size', rot.lastError === null, {
    before: `${fg.surfaceWidth}x${fg.surfaceHeight}`,
    after: `${rot.surfaceWidth}x${rot.surfaceHeight}`,
  });
  {
    const r = triangleOnScreen('rotated', rot);
    check('the rotated triangle on screen (geometry at the rotated size)', r.ok, r);
  }
  adb(
    'shell',
    'settings',
    'put',
    'system',
    'user_rotation',
    rotation.user === 'null' ? '0' : rotation.user,
  );
  await sleep(2000);

  // Process restart.
  const log1 = adb('logcat', '-d');
  adb('shell', 'am', 'force-stop', PACKAGE);
  adb('logcat', '-b', 'all', '-c');
  start();
  const restarted = await waitFor(() => ready()(latest()), 60000, 'presenting after restart');
  check('restart: a fresh runtime presents', restarted.lastError === null, restarted);
  const log = log1 + '\n' + adb('logcat', '-d');
  writeFileSync(path.join(run, 'logcat.txt'), log);
  check(
    'no detach timeout (surface counter, before and after restart)',
    fg.detachTimeouts === 0 && rot.detachTimeouts === 0 && latest().detachTimeouts === 0,
    { foreground: fg.detachTimeouts, rotated: rot.detachTimeouts },
  );
  check(
    'no GPU failure or device loss',
    latest().deviceLosses === 0 && latest().gpuState === 'ready',
    latest(),
  );
  check('no crash', !/FATAL EXCEPTION|Fatal signal|SIGABRT/.test(log), null);
  result.adapter = restarted.adapter;
  result.presentation = restarted.presentation;
} catch (error) {
  check('run completed', false, String(error));
} finally {
  try {
    adb(
      'shell',
      'settings',
      'put',
      'system',
      'accelerometer_rotation',
      rotation.auto === 'null' ? '1' : rotation.auto,
    );
    adb(
      'shell',
      'settings',
      'put',
      'system',
      'user_rotation',
      rotation.user === 'null' ? '0' : rotation.user,
    );
    adb('uninstall', PACKAGE);
  } catch {}
  result.ok = result.checks.every((c) => c.ok);
  writeFileSync(path.join(run, 'triangle-device.json'), JSON.stringify(result, null, 2));
  console.log(
    `${result.ok ? 'OK' : 'FAILED'}: ${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks; ${run}`,
  );
  process.exitCode = result.ok ? 0 : 1;
}
