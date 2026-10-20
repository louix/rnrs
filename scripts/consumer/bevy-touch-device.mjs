// Bounded device proof of native touch input for the Bevy example (fixtures/bevy-consumer,
// docs/bevy3d.md "Native touch input"). Same build as bevy-device-test.mjs:
// `FIXTURE=bevy-consumer MODULES=example-bevy3d PACKS=rnrs-surface NAME=bevy-app scripts/consumer/rn-app.sh`
// with RUSTUP_TOOLCHAIN=1.97.1 and ANDROID_MIN_SDK=26.
//
// Usage (inside `nix develop`): node scripts/consumer/bevy-touch-device.mjs <adb-serial>
//
// After the in-app sequence, with the cube paused (so only touch moves it):
// 1. Overlay: tapping the TSX Pause button above the surface pauses and feeds no touch to Rust.
// 2. Drag: `input swipe` across the surface → one touch started and ended, the angle changes.
// 3. (No separate cancel step: Android 11's `input motionevent` has no CANCEL; run
//    20261020T175144Z-…-touch failed on it. Step 4 is the cancel case.)
// 4. Background mid-gesture: DOWN, MOVE, HOME, foreground → the touch is canceled (by Android's
//    cancel or the detach reset), nothing stays pressed, and a new drag works after reattach.
// 5. JS stall: the overlay's Stall JS button blocks JS for 1.5 s between two synchronous
//    stats() calls; a drag during it reaches Rust and rotates the cube (RNR_STALL).
// Screen pixels = layout × (wm density / 160), plus the status bar for y (bevy-device-test.mjs).
//
// Writes results/bevy3d/runs/<UTC>-<serial>-touch/{bevy-touch.json,*.png,logcat.txt}; never
// overwrites results. Uninstalls the fixture app (com.helloworld) afterwards.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serial = process.argv[2];
if (!serial) throw new Error('usage: bevy-touch-device.mjs <adb-serial>');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = process.env.NAME ?? 'bevy-app';
const APK = path.join(
  ROOT,
  '.generated/consumer',
  NAME,
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
  execFileSync('adb', ['-s', serial, ...args], { timeout: 60000, maxBuffer: 1 << 26 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (adb('get-state') !== 'device') throw new Error(`${serial} is not connected`);
if (!existsSync(APK)) throw new Error(`${APK} missing; build the consumer first`);

const run = path.join(
  ROOT,
  'results/bevy3d/runs',
  `${new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}-${serial}-touch`,
);
if (existsSync(run)) throw new Error(`${run} exists`);
mkdirSync(run, { recursive: true });

const logLines = (tag) =>
  adb('logcat', '-d', '-s', 'ReactNativeJS:*')
    .split('\n')
    .filter((l) => l.includes(`${tag} `))
    .map((l) => {
      const text = l.slice(l.indexOf(`${tag} `) + tag.length + 1);
      try {
        return JSON.parse(text);
      } catch {
        return { truncated: true, length: text.length };
      }
    });
const latestStats = () => logLines('RNR_BEVY_STATS').at(-1);
async function waitFor(pred, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}
const pids = new Set();
const notePid = () => {
  try {
    for (const p of adb('shell', 'pidof', PACKAGE).split(/\s+/)) if (p) pids.add(p);
  } catch {}
};
const relevantLog = () => [...pids].map((p) => adb('logcat', '-d', `--pid=${p}`)).join('\n') + '\n';
const screenshot = (name) =>
  writeFileSync(path.join(run, `${name}.png`), adbRaw('exec-out', 'screencap', '-p'));
const start = () => adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
function screenGeometry() {
  const density = adb('shell', 'wm', 'density');
  const dpi = Number(
    (/Override density: (\d+)/.exec(density) ?? /Physical density: (\d+)/.exec(density))[1],
  );
  const bar = /ITYPE_STATUS_BAR, mFrame=\[0,0\]\[\d+,(\d+)\]/.exec(
    adb('shell', 'dumpsys', 'window', 'windows'),
  );
  return { scale: dpi / 160, statusBarPx: bar ? Number(bar[1]) : 0 };
}
/** Taps the centre of the button `id` from its latest RNR_BUTTON layout line. */
function tap(id) {
  const b = logLines('RNR_BUTTON')
    .filter((l) => l.id === id)
    .at(-1);
  if (!b) throw new Error(`no RNR_BUTTON for ${id}`);
  const g = (result.screen ??= screenGeometry());
  const [x, y] = [
    Math.round((b.x + b.w / 2) * g.scale),
    Math.round((b.y + b.h / 2) * g.scale + g.statusBarPx),
  ];
  adb('shell', 'input', 'tap', String(x), String(y));
  return { layout: b, x, y };
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
const buildRecordFile = path.join(ROOT, '.generated/consumer', `${NAME}.build.json`);
const result = {
  serial,
  model: adb('shell', 'getprop', 'ro.product.model'),
  build: adb('shell', 'getprop', 'ro.build.fingerprint'),
  provenance: {
    apk: APK,
    apkSha256: sha256(APK),
    apkBytes: readFileSync(APK).length,
    buildRecord: existsSync(buildRecordFile)
      ? JSON.parse(readFileSync(buildRecordFile, 'utf8'))
      : null,
    runner: path.relative(ROOT, fileURLToPath(import.meta.url)),
    runnerSha256: sha256(fileURLToPath(import.meta.url)),
    runHead: git('rev-parse', 'HEAD').trim(),
    runStatusPorcelain: git('status', '--porcelain=v1', '--untracked-files=all')
      .split('\n')
      .filter(Boolean),
  },
  checks: [],
};
const check = (name, ok, detail) => result.checks.push({ name, ok: !!ok, detail });
check(
  'APK matches its build record',
  result.provenance.buildRecord?.apkSha256 === result.provenance.apkSha256,
  {
    built: result.provenance.buildRecord?.apkSha256 ?? null,
    installed: result.provenance.apkSha256,
    sourceClean: result.provenance.buildRecord?.sourceClean ?? null,
  },
);

const pick = (s) =>
  s && {
    state: s.state,
    paused: s.paused,
    angle: s.angle,
    attaches: s.attaches,
    detaches: s.detaches,
    touchesStarted: s.touchesStarted,
    touchesEnded: s.touchesEnded,
    touchesCanceled: s.touchesCanceled,
    touchResets: s.touchResets,
    touchesActive: s.touchesActive,
    touchesPressed: s.touchesPressed,
    lastTouchX: s.lastTouchX,
    lastTouchY: s.lastTouchY,
    touchAccepted: s.touchAccepted,
    touchCoalesced: s.touchCoalesced,
    touchOverflows: s.touchOverflows,
    touchRefused: s.touchRefused,
    touchDropped: s.touchDropped,
    framesRendered: s.framesRendered,
    detachTimeouts: s.detachTimeouts,
    lastError: s.lastError,
    gpuState: s.gpuState,
  };
/** A stats line logged after `afterMs` (device clock is not compared; we wait for fresh lines). */
async function freshStats(pred = () => true, timeoutMs = 6000) {
  const seen = logLines('RNR_BEVY_STATS').length;
  return waitFor(
    () => {
      const all = logLines('RNR_BEVY_STATS');
      return all.length > seen + 1 && pred(all.at(-1)) && all.at(-1);
    },
    timeoutMs,
    'fresh stats',
  );
}
const motion = (action, x, y) => adb('shell', 'input', 'motionevent', action, String(x), String(y));
const delta = (a, b, k) => b[k] - a[k];

try {
  adb('install', '-r', APK);
  adb('logcat', '-b', 'all', '-c');
  start();
  await sleep(1000);
  notePid();
  const smoke = await waitFor(() => logLines('RNR_SMOKE')[0], 120000, 'RNR_SMOKE');
  check(
    'in-app sequence',
    smoke.ok,
    smoke.checks?.filter((c) => !c.ok),
  );
  await waitFor(() => latestStats(), 10000, 'stats');
  const g = (result.screen = screenGeometry());
  const rect = await waitFor(() => logLines('RNR_SURFACE').at(-1), 5000, 'RNR_SURFACE');
  const cx = Math.round((rect.x + rect.w / 2) * g.scale),
    cy = Math.round((rect.y + rect.h / 2) * g.scale + g.statusBarPx);
  const half = Math.round(rect.w * g.scale * 0.3);
  result.surface = { layout: rect, centerPx: [cx, cy], dragHalfPx: half };

  // 1. Overlay tap above the surface: pauses through JS; Rust gets no touch.
  const s0 = await freshStats();
  result.overlayTap = tap('pause');
  const s1 = await freshStats((s) => s.paused);
  check(
    'overlay Pause tap pauses and feeds no touch to Rust',
    s1.paused && delta(s0, s1, 'touchesStarted') === 0 && delta(s0, s1, 'touchAccepted') === 0,
    { before: pick(s0), after: pick(s1) },
  );

  // 2. Drag across the surface.
  adb(
    'shell',
    'input',
    'swipe',
    String(cx - half),
    String(cy),
    String(cx + half),
    String(cy),
    '600',
  );
  const s2 = await freshStats((s) => s.touchesEnded > s1.touchesEnded);
  check(
    'drag: one touch down/move/up reaches Bevy and rotates the paused cube',
    delta(s1, s2, 'touchesStarted') === 1 &&
      delta(s1, s2, 'touchesEnded') === 1 &&
      s2.touchesActive === 0 &&
      s2.touchesPressed === 0 &&
      s2.angle !== s1.angle &&
      s2.paused,
    { before: pick(s1), after: pick(s2) },
  );
  screenshot('after-drag');

  result.skipped = ['separate platform-cancel step: Android 11 input has no "motionevent CANCEL"'];

  // 4. Background mid-gesture, then foreground and a new drag.
  motion('DOWN', cx, cy);
  motion('MOVE', cx + 100, cy);
  const s4a = await freshStats((s) => s.touchesActive === 1);
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(2500);
  start();
  await sleep(1000);
  notePid();
  motion('UP', cx + 100, cy); // the injected stream's end; dropped (its window is gone)
  const s4 = await freshStats(
    (s) =>
      s.state === 'attached' && s.attaches > s4a.attaches && s.framesRendered > s4a.framesRendered,
    15000,
  );
  check(
    'background mid-gesture: canceled (not ended), nothing pressed after reattach',
    delta(s4a, s4, 'touchesCanceled') === 1 &&
      delta(s4a, s4, 'touchesEnded') === 0 &&
      s4.touchesActive === 0 &&
      s4.touchesPressed === 0 &&
      s4.detaches > s4a.detaches,
    {
      during: pick(s4a),
      after: pick(s4),
      canceledBy: delta(s4a, s4, 'touchResets') > 0 ? 'reset (detach) seen' : 'platform cancel',
    },
  );
  adb(
    'shell',
    'input',
    'swipe',
    String(cx + half),
    String(cy),
    String(cx - half),
    String(cy),
    '600',
  );
  const s5 = await freshStats((s) => s.touchesEnded > s4.touchesEnded);
  check(
    'after reattach a new drag works',
    delta(s4, s5, 'touchesStarted') === 1 &&
      delta(s4, s5, 'touchesEnded') === 1 &&
      s5.angle !== s4.angle &&
      s5.touchesActive === 0,
    { before: pick(s4), after: pick(s5) },
  );

  // 5. Controlled JS stall with a drag during it.
  result.stallTap = tap('stall');
  await sleep(250);
  adb(
    'shell',
    'input',
    'swipe',
    String(cx - half),
    String(cy),
    String(cx + half),
    String(cy),
    '500',
  );
  const stall = await waitFor(() => logLines('RNR_STALL').at(-1), 10000, 'RNR_STALL');
  result.stall = { ms: stall.ms, before: pick(stall.before), after: pick(stall.after) };
  check(
    'JS stall: touch reaches Rust and moves the cube while JS is blocked',
    stall.ms >= 1400 &&
      delta(stall.before, stall.after, 'touchesStarted') >= 1 &&
      delta(stall.before, stall.after, 'touchesEnded') >= 1 &&
      stall.after.angle !== stall.before.angle,
    result.stall,
  );

  const end = await freshStats();
  result.final = pick(end);
  check(
    'no detach timeouts, errors or overflows',
    end.detachTimeouts === 0 &&
      end.lastError === null &&
      end.gpuState === 'ready' &&
      end.touchOverflows === 0,
    pick(end),
  );
  screenshot('final');
} catch (error) {
  check('run completed', false, String(error));
} finally {
  try {
    writeFileSync(path.join(run, 'logcat.txt'), relevantLog());
  } catch {}
  const crashes = (() => {
    try {
      return adb('logcat', '-d', '-b', 'crash');
    } catch {
      return '';
    }
  })();
  if (crashes.includes(PACKAGE)) check('no crash', false, crashes);
  try {
    adb('uninstall', PACKAGE);
  } catch {}
}
result.ok = result.checks.every((c) => c.ok);
writeFileSync(path.join(run, 'bevy-touch.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`${result.ok ? 'PASS' : 'FAIL'} ${run}`);
for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`);
process.exit(result.ok ? 0 : 1);
