// Simulator run of the Bevy example consumer on iOS (fixtures/bevy-consumer), built by
// `RNRS_IOS_FIXTURE=bevy RUSTUP_TOOLCHAIN=1.97.1 RNRS_IOS_SDKS=iphonesimulator scripts/consumer/ios-app.sh`
// (packages/bevy3d/README.md). Runs on the Mac:
//   node scripts/consumer/ios-bevy-sim-test.mjs --app <HelloWorld.app> --device <simulator udid>
//     --bundle-id <id> --commit <sha> --out <run dir>
//
// 1. Installs and launches the app, waits for `RNRS_SMOKE` (the in-app sequence: mount, simulate,
//    pause, colour, resize, unmount, remount) and screenshots the cube with the TSX overlay.
// 2. Background (Settings to the foreground) and foreground: the window detaches, re-attaches
//    and presents again.
// 3. Checks the final stats: no detach timeouts, no error, GPU ready.
// Visual check (part of the pass): presenting alone is not evidence that Bevy drew (a stopped
// Bevy renderer once left a black surface while frames were still presented). Each screenshot of
// the app must contain at least VISIBLE_MIN strongly coloured pixels (the lit cube; the clear
// colour, the overlay and the app background are all near-grey).
// The app's reports are console.error lines `<TAG> <i>/<n> <part>` (release builds forward only
// console.error to os_log), read from the simulator's unified log. simctl cannot tap, so the
// overlay buttons are not driven here; the in-app sequence uses the same TypeScript API.
// Writes <out>/{bevy-sim.json,reports.ndjson,*.png} (the run dir must not exist) and uninstalls
// the app from the simulator afterwards.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png.mjs';

export { decodePng };

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
};
const APP = arg('app'),
  DEVICE = arg('device'),
  BUNDLE = arg('bundle-id'),
  COMMIT = arg('commit'),
  OUT = arg('out');
if (existsSync(OUT)) throw new Error(`${OUT} exists`);
mkdirSync(OUT, { recursive: true });
const sh = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 26 }).trim();
const simctl = (...args) => sh('xcrun', ['simctl', ...args]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const binary = path.join(APP, 'HelloWorld');

const result = {
  device: DEVICE,
  simulator: JSON.parse(simctl('list', 'devices', '-j')).devices,
  provenance: {
    commit: COMMIT,
    app: APP,
    binarySha256: sha256(binary),
    binaryBytes: readFileSync(binary).length,
    runner: path.basename(fileURLToPath(import.meta.url)),
    runnerSha256: sha256(fileURLToPath(import.meta.url)),
    xcode: sh('xcodebuild', ['-version']).split('\n'),
    macos: sh('sw_vers', ['-productVersion']),
  },
  checks: [],
};
// Keep only this simulator's entry.
for (const [runtime, list] of Object.entries(result.simulator)) {
  const d = list.find((x) => x.udid === DEVICE);
  if (d) result.simulator = { runtime, name: d.name, deviceType: d.deviceTypeIdentifier };
}
const check = (name, ok, detail) => result.checks.push({ name, ok: !!ok, detail });

// Reports: joined from the unified log as they arrive.
const reports = [];
const partial = new Map();
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
  const lines = (tail + chunk).split('\n');
  tail = lines.pop();
  for (const l of lines) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    const m = /(RNRS_[A-Z_]+) (\d+)\/(\d+) (.*)$/s.exec(e.eventMessage ?? '');
    if (!m) continue;
    const [, tag, i, n, part] = m;
    const key = `${e.processID} ${tag}`;
    const parts = Number(i) === 1 ? [] : (partial.get(key) ?? []);
    parts.push(part);
    partial.set(key, parts);
    if (Number(i) === Number(n)) {
      partial.delete(key);
      let value;
      try {
        value = JSON.parse(parts.join(''));
      } catch {
        value = { unparsed: parts.join('').length };
      }
      reports.push({ at: Date.now(), pid: e.processID, tag, value });
    }
  }
});
const all = (tag) => reports.filter((r) => r.tag === tag).map((r) => r.value);
const latestStats = () => all('RNRS_BEVY_STATS').at(-1);
async function waitFor(pred, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}
const screenshot = (name) => simctl('io', DEVICE, 'screenshot', path.join(OUT, `${name}.png`));

const VISIBLE_MIN = 2000;
/** Strongly coloured pixels (max - min channel > 80, max > 100) in a screenshot. */
export function colouredPixels(file) {
  const { width, height, channels, pixels } = decodePng(readFileSync(file));
  let n = 0;
  for (let i = 0; i < width * height * channels; i += channels) {
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    if (Math.max(r, g, b) > 100 && Math.max(r, g, b) - Math.min(r, g, b) > 80) n++;
  }
  return n;
}
const visible = (name) => {
  const n = colouredPixels(path.join(OUT, `${name}.png`));
  check(`visible: the cube is on screen in ${name}.png`, n >= VISIBLE_MIN, {
    colouredPixels: n,
    min: VISIBLE_MIN,
  });
};

try {
  simctl('install', DEVICE, APP);
  await sleep(1500); // the log stream is up before the launch
  simctl('launch', DEVICE, BUNDLE);
  const smoke = await waitFor(() => all('RNRS_SMOKE')[0], 300000, 'RNRS_SMOKE');
  result.smoke = { ...smoke, details: all('RNRS_SMOKE_CHECK') };
  check(
    'in-app sequence (mount, simulate, pause, color, resize, unmount, remount)',
    smoke.ok,
    smoke.checks?.filter((c) => !c.ok) ?? smoke.error,
  );
  const first = await waitFor(() => latestStats(), 10000, 'stats');
  await sleep(2000);
  const steady = latestStats();
  result.steady = steady;
  check(
    'presenting in steady state',
    steady.state === 'attached' &&
      steady.gpuState === 'ready' &&
      steady.framesPresented > first.framesPresented,
    { first: first.framesPresented, steady },
  );
  screenshot('steady');
  visible('steady');

  // Background (another app to the foreground) and foreground.
  const before = latestStats();
  simctl('launch', DEVICE, 'com.apple.Preferences');
  await sleep(3000);
  screenshot('background');
  simctl('launch', DEVICE, BUNDLE);
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
    20000,
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
  await sleep(1000);
  screenshot('foreground');
  visible('foreground');
  check('one app process', new Set(reports.map((r) => r.pid)).size === 1, [
    ...new Set(reports.map((r) => r.pid)),
  ]);
} catch (error) {
  check('run completed', false, String(error));
} finally {
  logStream.kill();
  writeFileSync(
    path.join(OUT, 'reports.ndjson'),
    reports.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  try {
    simctl('terminate', DEVICE, BUNDLE);
  } catch {
    /* not running */
  }
  try {
    simctl('uninstall', DEVICE, BUNDLE);
  } catch {
    /* best effort */
  }
}
result.ok = result.checks.length > 0 && result.checks.every((c) => c.ok);
writeFileSync(path.join(OUT, 'bevy-sim.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`${result.ok ? 'PASS' : 'FAIL'} ${OUT}`);
for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`);
process.exit(result.ok ? 0 : 1);
