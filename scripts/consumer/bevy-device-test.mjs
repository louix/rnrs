// Device run of the Bevy example consumer (fixtures/bevy-consumer), built by
// `FIXTURE=bevy-consumer MODULES=example-bevy3d PACKS=rnrs-surface NAME=bevy-app scripts/consumer/rn-app.sh`
// with RUSTUP_TOOLCHAIN=1.97.1 (docs/bevy3d.md).
//
// Usage (inside `nix develop`): node scripts/consumer/bevy-device-test.mjs <adb-serial>
//
// 1. Installs the APK, starts it, waits for `RNR_SMOKE` (the in-app sequence) and screenshots.
// 2. Taps the TSX overlay's Color and Pause buttons and checks the pause in `RNR_BEVY_STATS`;
//    then Resume. uiautomator cannot dump a continuously animating window ("could not get idle
//    state"), so the app logs each button's layout (`RNR_BUTTON`, layout units relative to its
//    root view); screen pixels = layout × (wm density / 160), plus the status bar height for y
//    (the template is not edge-to-edge). Whether a tap landed is checked through the stats.
// 3. Background (HOME) and foreground: the window detaches and re-attaches, presenting resumes.
//
// Writes results/bevy3d/runs/<UTC timestamp>-<serial>/{bevy-device.json,*.png,logcat.txt};
// never overwrites results. Uninstalls the fixture app (com.helloworld) afterwards.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serial = process.argv[2];
if (!serial) throw new Error('usage: bevy-device-test.mjs <adb-serial>');
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
    .replace(/\.\d+Z$/, 'Z')}-${serial}`,
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
try {
  adb('install', '-r', APK);
  adb('logcat', '-b', 'all', '-c');
  start();
  await sleep(1000);
  notePid();
  const smoke = await waitFor(() => logLines('RNR_SMOKE')[0], 120000, 'RNR_SMOKE');
  result.smoke = { ...smoke, details: logLines('RNR_SMOKE_CHECK') };
  check(
    'in-app sequence (mount, simulate, pause, color, resize, unmount, remount)',
    smoke.ok,
    smoke.checks?.filter((c) => !c.ok),
  );
  const steady = await waitFor(() => latestStats(), 10000, 'stats');
  result.steady = steady;
  await sleep(1000);
  screenshot('steady');

  // Overlay input: TSX buttons → TypeScript API → render thread.
  result.taps = { color: tap('color') };
  await sleep(1500);
  screenshot('after-color-tap');
  result.taps.pause = tap('pause');
  const paused = await waitFor(
    () => {
      const s = latestStats();
      return s?.paused && s;
    },
    5000,
    'paused stats',
  ).catch((e) => ({ error: String(e) }));
  await sleep(1200);
  const pausedLater = latestStats();
  check(
    'overlay Pause tap pauses the Rust simulation',
    paused.paused && pausedLater?.paused && pausedLater.angle === paused.angle,
    { paused, pausedLater },
  );
  screenshot('paused');
  result.taps.resume = tap('pause');
  const resumed = await waitFor(
    () => {
      const s = latestStats();
      return s && !s.paused && s.angle !== paused.angle && s;
    },
    5000,
    'resumed stats',
  ).catch((e) => ({ error: String(e) }));
  check('overlay Resume tap resumes it', resumed.paused === false, resumed);

  // Background and foreground.
  const before = latestStats();
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(2500);
  start();
  await sleep(1000);
  notePid();
  const fg = await waitFor(
    () => {
      const s = latestStats();
      return (
        s &&
        s.state === 'attached' &&
        s.attaches > before.attaches &&
        s.framesPresented > before.framesPresented + 30 &&
        s
      );
    },
    15000,
    'presenting after foreground',
  ).catch((e) => ({ error: String(e) }));
  check(
    'background/foreground: detached, re-attached and presenting',
    fg.state === 'attached' && fg.detaches > before.detaches,
    {
      before: {
        attaches: before.attaches,
        detaches: before.detaches,
        framesPresented: before.framesPresented,
      },
      after: fg,
    },
  );
  check(
    'no detach timeouts or errors',
    fg.detachTimeouts === 0 && fg.lastError === null && fg.gpuState === 'ready',
    fg,
  );
  screenshot('foreground');
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
writeFileSync(path.join(run, 'bevy-device.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`${result.ok ? 'PASS' : 'FAIL'} ${run}`);
for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`);
process.exit(result.ok ? 0 : 1);
