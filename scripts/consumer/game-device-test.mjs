// Device run of the paddle game consumer (fixtures/paddle-game, built by
// `FIXTURE=paddle-game FIXTURE_FILES="game.ts contention.ts" MODULES=example-vello2d PACKS=rnrs-surface NAME=game-app scripts/consumer/rn-app.sh`).
//
// Usage (inside `nix develop`): node scripts/consumer/game-device-test.mjs <adb-serial>
//
// 1. The app's scripted session (seeded autopilot, 20 s of running time): its checks.
// 2. Interactive session with real touches (`adb shell input swipe` on the game overlay): the
//    paddle follows the finger left and right.
// 3. Background (HOME, 4 s) and resume. Lifecycle evidence (counts are relative to the
//    interactive session, so the startup attach is not a resume):
//    - exactly one pause and one resume for the cycle;
//    - at the recorded pause and resume transitions, the game tick and the renderer's
//      framesSubmitted are equal: no steps and no submitted frames while paused;
//    - the first running tick after the resume runs no steps; presenting resumes;
//    - sizes after the resume: the surface equals its size before the background, or a resize
//      followed the re-attach; and the game's layout size × scale matches the surface (±2 px).
//    The surface attach/resize/detach dimensions (RnrSurface log) are recorded; no cause is
//    inferred for a transient size.
// Consistency values (simulated vs active time, dropped time, steps per tick) are recorded but
// are not lifecycle evidence; the clock's cap is covered by unit tests.
//
// Writes results/surface/runs/<UTC>-<serial>-game/ (never overwrites). Logs are captured for
// the app's own process only, and all log buffers (including crash) are cleared first, so only
// this run's crashes count. Uninstalls the fixture app (com.helloworld) afterwards.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serial = process.argv[2];
if (!serial) throw new Error('usage: game-device-test.mjs <adb-serial>');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = process.env.NAME ?? 'game-app';
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
  'results/surface/runs',
  `${new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}-${serial}-game`,
);
if (existsSync(run)) throw new Error(`${run} exists`);
mkdirSync(run, { recursive: true });

let pid = null;
/** This app process's log only. */
const appLog = (...extra) => (pid ? adb('logcat', '-d', `--pid=${pid}`, ...extra) : '');
const tagged = (tag) =>
  appLog('-v', 'epoch')
    .split('\n')
    .filter((l) => l.includes(`${tag} `))
    .map((l) => {
      const text = l.slice(l.indexOf(`${tag} `) + tag.length + 1);
      try {
        return { ...JSON.parse(text), _t: Number(l.trim().split(/\s+/)[0]) };
      } catch {
        return { truncated: true };
      }
    });
const latest = () => tagged('RNR_GAME_STATS').at(-1);
async function waitFor(pred, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}
const screenshot = (name) =>
  writeFileSync(path.join(run, `${name}.png`), adbRaw('exec-out', 'screencap', '-p'));
const start = () => adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
const buildRecordFile = path.join(ROOT, '.generated/consumer', `${NAME}.build.json`);
const sameSize = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
const agrees = (s) =>
  !!s?.sizes?.game &&
  Math.abs(s.sizes.game[0] * s.sizes.scale - s.sizes.surface[0]) <= 2 &&
  Math.abs(s.sizes.game[1] * s.sizes.scale - s.sizes.surface[1]) <= 2;

const result = {
  serial,
  model: adb('shell', 'getprop', 'ro.product.model'),
  build: adb('shell', 'getprop', 'ro.build.fingerprint'),
  provenance: {
    apk: APK,
    apkSha256: sha256(APK),
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
  adb('logcat', '-b', 'all', '-c'); // only this run's logs and crashes from here on
  start();
  pid = await waitFor(
    () => {
      try {
        return adb('shell', 'pidof', PACKAGE) || null;
      } catch {
        return null;
      }
    },
    15000,
    'app process',
  );
  result.pid = pid;
  // 1. Scripted session.
  const summary = await waitFor(() => tagged('RNR_GAME')[0], 120000, 'RNR_GAME');
  result.scripted = { summary, checks: tagged('RNR_GAME_CHECK'), data: tagged('RNR_GAME_DATA') };
  check(
    'scripted session (seeded autopilot): app checks',
    summary.ok,
    summary.checks?.filter((c) => !c.ok),
  );
  screenshot('scripted');

  // 2. Touch: swipe on the overlay, low on the screen (physical pixels).
  const [w, h] = adb('shell', 'wm', 'size')
    .match(/(\d+)x(\d+)/)
    .slice(1)
    .map(Number);
  const y = Math.round(h * 0.7);
  const s0 = await waitFor(() => latest(), 15000, 'interactive stats');
  const gameWidth = (s) => s.sizes.game[0];
  adb(
    'shell',
    'input',
    'swipe',
    String(Math.round(w / 2)),
    String(y),
    String(Math.round(w * 0.08)),
    String(y),
    '400',
  );
  const left = await waitFor(
    () => {
      const s = latest();
      return s && s.touches > s0.touches && s.paddleX < gameWidth(s) * 0.35 && s;
    },
    8000,
    'paddle left',
  ).catch((e) => ({ error: String(e) }));
  check(
    'touch: the paddle follows a swipe to the left',
    !left.error,
    left.error ?? { paddleX: left.paddleX, width: gameWidth(left) },
  );
  adb(
    'shell',
    'input',
    'swipe',
    String(Math.round(w * 0.1)),
    String(y),
    String(Math.round(w * 0.92)),
    String(y),
    '400',
  );
  const right = await waitFor(
    () => {
      const s = latest();
      return s && s.touches > (left.touches ?? 0) && s.paddleX > gameWidth(s) * 0.65 && s;
    },
    8000,
    'paddle right',
  ).catch((e) => ({ error: String(e) }));
  check(
    'touch: the paddle follows a swipe to the right',
    !right.error,
    right.error ?? { paddleX: right.paddleX, width: gameWidth(right) },
  );
  screenshot('interactive');

  // 3. Background and resume.
  await sleep(1500);
  const before = latest();
  const backgroundS = 4;
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(backgroundS * 1000);
  start();
  const after = await waitFor(
    () => {
      const s = latest();
      return (
        s &&
        s.resumes > before.resumes &&
        s.renderer === 'attached' &&
        s.running &&
        s.presented > before.presented + 10 &&
        s
      );
    },
    20000,
    'resumed and presenting',
  ).catch((e) => ({ error: String(e) }));
  result.background = { before, after, backgroundS };
  check(
    'resume: attached, running and presenting again after the background',
    !after.error,
    after.error ?? { renderer: after.renderer, presented: after.presented },
  );
  if (!after.error) {
    await sleep(1500); // let any re-layout after the resume settle
    const settled = latest();
    result.background.settled = settled;
    result.sizeEvents = appLog('-s', 'RnrSurface:*')
      .split('\n')
      .filter((l) => / (attached|resized|detached) #/.test(l))
      .map((l) => l.slice(l.indexOf('surface ')));
    check(
      'exactly one pause and one resume for the background cycle (startup attach excluded)',
      settled.resumes === before.resumes + 1 && settled.pauses === before.pauses + 1,
      { resumes: [before.resumes, settled.resumes], pauses: [before.pauses, settled.pauses] },
    );
    const ts = settled.transitions;
    const resumeAt = ts.map((t) => t.kind).lastIndexOf('resume');
    const pause = resumeAt > 0 ? ts[resumeAt - 1] : null;
    const resume = resumeAt >= 0 ? ts[resumeAt] : null;
    check(
      'no steps and no submitted frames while paused (game tick and framesSubmitted equal at pause and resume)',
      pause?.kind === 'pause' &&
        resume &&
        pause.tick === resume.tick &&
        pause.framesSubmitted === resume.framesSubmitted,
      { pause, resume },
    );
    check(
      'no catch-up: the first running tick after the resume runs no steps',
      settled.firstTickAfterResumeSteps.at(-1) === 0,
      settled.firstTickAfterResumeSteps,
    );
    const resizedAfterReattach = settled.sizes.resizes > after.sizes.resizes;
    check(
      'size after resume: the surface equals its size before the background, or a resize followed the re-attach',
      sameSize(settled.sizes.surface, before.sizes.surface) || resizedAfterReattach,
      {
        before: before.sizes,
        atResume: after.sizes,
        settled: settled.sizes,
        sizeEvents: result.sizeEvents,
      },
    );
    check(
      'size after resume: game layout size × scale matches the surface (±2 px)',
      agrees(settled) && settled.sizeAgrees,
      settled.sizes,
    );
    check(
      'no surface errors after resume',
      settled.surfaceErrors === 0 && settled.gpu === 'ready',
      { surfaceErrors: settled.surfaceErrors, gpu: settled.gpu },
    );
    check(
      'renderer owned by the runtime; one open',
      settled.ownedByRuntime === true && settled.renderersOpen === 1,
      { ownedByRuntime: settled.ownedByRuntime, renderersOpen: settled.renderersOpen },
    );
    result.consistency = {
      note: 'recorded, not lifecycle evidence (the clock cap is unit-tested)',
      before: before.consistency,
      settled: settled.consistency,
    };
  }
  await sleep(1000);
  screenshot('resumed');
} catch (error) {
  check('run completed', false, String(error));
} finally {
  try {
    writeFileSync(path.join(run, 'logcat.txt'), appLog() + '\n');
  } catch {}
  const crashes = (() => {
    try {
      return adb('logcat', '-d', '-b', 'crash');
    } catch {
      return '';
    }
  })();
  if (crashes.trim())
    check(
      'no crash during this run',
      !crashes.includes(PACKAGE) && !(pid && crashes.includes(`pid: ${pid}`)),
      crashes.includes(PACKAGE) ? crashes : 'other processes only (not recorded)',
    );
  try {
    adb('uninstall', PACKAGE);
  } catch {}
}
result.ok = result.checks.every((c) => c.ok);
writeFileSync(path.join(run, 'game-device.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`${result.ok ? 'PASS' : 'FAIL'} ${run}`);
for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`);
process.exit(result.ok ? 0 : 1);
