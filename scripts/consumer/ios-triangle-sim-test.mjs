// iOS simulator run of the rnrs::gpu triangle (fixtures/triangle-consumer), built on the Mac by
// `RNRS_IOS_FIXTURE=triangle RNRS_IOS_SDKS=iphonesimulator scripts/consumer/ios-app.sh`:
//   node scripts/consumer/ios-triangle-sim-test.mjs --app <HelloWorld.app> --device <simulator udid>
//     --bundle-id <id> --out <run dir>
//
// Checks, from `RNRS_TRIANGLE_STATS` (console.error lines in the simulator's unified log) and
// simulator screenshots: ready and presenting on Metal; orange triangle pixels on screen;
// redraws follow the one-per-second background change (Next::Wait); background (Settings to the
// front) then foreground re-attaches with a new setup and presents; terminate and relaunch
// presents again; no detach timeout or GPU error in the log. simctl cannot rotate, so rotation
// is covered on Android only. The app is left installed (nothing is uninstalled from the
// simulator). Writes <out>/{triangle-sim.json,*.png}; the directory must not exist.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';
import { triangleShape } from './triangle-shape.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
};
const APP = arg('app'),
  DEVICE = arg('device'),
  BUNDLE = arg('bundle-id'),
  OUT = arg('out');
if (existsSync(OUT)) throw new Error(`${OUT} exists`);
mkdirSync(OUT, { recursive: true });
const sh = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 26 }).trim();
const simctl = (...args) => sh('xcrun', ['simctl', ...args]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stats = [];
const lines = [];
let tail = '';
const logStream = spawn(
  'xcrun',
  [
    'simctl',
    'spawn',
    DEVICE,
    'log',
    'stream',
    '--level',
    'info',
    '--style',
    'ndjson',
    '--predicate',
    'process == "HelloWorld"',
  ],
  { stdio: ['ignore', 'pipe', 'ignore'] },
);
logStream.stdout.on('data', (chunk) => {
  const split = (tail + chunk).split('\n');
  tail = split.pop();
  for (const l of split) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    const message = e.eventMessage ?? '';
    lines.push(message);
    const m = /RNRS_TRIANGLE_STATS (\{.*\})/s.exec(message);
    if (m)
      try {
        stats.push(JSON.parse(m[1]));
      } catch {}
  }
});
const latest = () => stats.at(-1);
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
const result = {
  device: DEVICE,
  xcode: sh('xcodebuild', ['-version']).split('\n'),
  macos: sh('sw_vers', ['-productVersion']),
  checks: [],
};
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
};
/** The triangle's geometry in a simulator screenshot (triangle-shape.mjs). */
function triangleOnScreen(name, stats) {
  const file = path.join(OUT, `${name}.png`);
  simctl('io', DEVICE, 'screenshot', file);
  return triangleShape(decodePng(readFileSync(file)), {
    width: stats.surfaceWidth,
    height: stats.surfaceHeight,
  });
}
const launch = () => simctl('launch', DEVICE, BUNDLE);
const ready =
  (after = {}) =>
  (s) =>
    s &&
    s.state === 'attached' &&
    s.gpuState === 'ready' &&
    s.framesSubmitted > (after.framesSubmitted ?? 0) &&
    s;
try {
  simctl('install', DEVICE, APP);
  await sleep(1500); // the log stream is up before the launch
  launch();
  const first = await waitFor(() => ready()(latest()), 90000, 'ready and presenting');
  check(
    'ready and presenting (Metal)',
    first.lastError === null && /Metal/.test(first.adapter),
    first,
  );
  await sleep(1500);
  const shot = triangleOnScreen('steady', first);
  check('the triangle on screen (orange region with its geometry)', shot.ok, shot);

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

  simctl('launch', DEVICE, 'com.apple.Preferences');
  await sleep(3000);
  launch();
  const fg = await waitFor(
    () => ready(b)(latest()) && latest().initsStarted > b.initsStarted && latest(),
    30000,
    'presenting after foreground',
  );
  check('foreground: re-attached with a new setup and presenting', fg.lastError === null, {
    before: b,
    after: fg,
  });
  {
    const f = triangleOnScreen('foreground', fg);
    check('the triangle on screen after foreground (geometry)', f.ok, f);
  }

  simctl('terminate', DEVICE, BUNDLE);
  stats.length = 0;
  launch();
  const restarted = await waitFor(() => ready()(latest()), 90000, 'presenting after relaunch');
  check('relaunch: a fresh runtime presents', restarted.lastError === null, restarted);
  check(
    'no detach timeout (surface counter)',
    fg.detachTimeouts === 0 && restarted.detachTimeouts === 0,
    { foreground: fg.detachTimeouts },
  );
  check(
    'no GPU failure or device loss',
    restarted.deviceLosses === 0 && restarted.gpuState === 'ready',
    restarted,
  );
  result.logLines = lines.length;
  result.adapter = restarted.adapter;
  result.presentation = restarted.presentation;
} catch (error) {
  check('run completed', false, String(error));
} finally {
  logStream.kill();
  result.ok = result.checks.every((c) => c.ok);
  writeFileSync(path.join(OUT, 'triangle-sim.json'), JSON.stringify(result, null, 2));
  console.log(
    `${result.ok ? 'OK' : 'FAILED'}: ${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks; ${OUT}`,
  );
  process.exitCode = result.ok ? 0 : 1;
}
