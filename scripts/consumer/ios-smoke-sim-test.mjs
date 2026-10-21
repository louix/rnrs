// Runs a smoke app on a booted iOS simulator: the fresh Expo consumer (scripts/consumer/expo-app.sh)
// or the template consumer built with RNRS_IOS_FIXTURE=smoke (scripts/consumer/ios-app.sh). Installs
// the Release app, launches it with its console attached (OS_ACTIVITY_DT_MODE mirrors os_log,
// where release builds forward console.error), waits for the app's report (`RNRS_SMOKE <i>/<n>
// <chunk>` lines: os_log truncates long messages),
// repeats the cold launch (--launches, default 2), and uninstalls it. Simulator evidence only.
// Usage (on the Mac): node scripts/consumer/ios-smoke-sim-test.mjs --device <simulator udid>
//   [--consumer <dir>] [--launches <n>] [--commit <hash>] [out.json]
//   --consumer: the script's output directory (default .generated/consumer-expo)
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const device = arg('--device');
if (!device) {
  console.error(
    'usage: ios-smoke-sim-test.mjs --device <simulator udid> [--consumer <dir>] [out.json]',
  );
  process.exit(2);
}
const consumer = path.resolve(arg('--consumer') ?? path.join(ROOT, '.generated/consumer-expo'));
const products = path.join(consumer, 'build/Build/Products/Release-iphonesimulator');
let appName;
try {
  appName = readdirSync(products).find((f) => f.endsWith('.app'));
} catch {
  /* no products directory */
}
if (!appName) throw new Error(`no .app under ${products}; build the consumer first`);
const app = path.join(products, appName);
const out = process.argv
  .slice(2)
  .filter(
    (a, i, all) =>
      !a.startsWith('--') &&
      !['--device', '--consumer', '--commit', '--launches'].includes(all[i - 1]),
  )
  .pop();
const TIMEOUT_MS = 180000;
const LAUNCHES = Number(arg('--launches') ?? 2);
const simctl = (...args) =>
  execFileSync('xcrun', ['simctl', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const bundleId = execFileSync(
  'plutil',
  ['-extract', 'CFBundleIdentifier', 'raw', path.join(app, 'Info.plist')],
  {
    encoding: 'utf8',
  },
).trim();
const sim = Object.entries(JSON.parse(simctl('list', 'devices', '-j')).devices)
  .flatMap(([runtime, ds]) => ds.map((d) => ({ ...d, runtime })))
  .find((d) => d.udid === device);
if (sim?.state !== 'Booted') throw new Error(`simulator ${device} is not booted`);

/** One cold launch: the parsed report, or null after the timeout. */
function launch() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'xcrun',
      ['simctl', 'launch', '--console-pty', '--terminate-running-process', device, bundleId],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SIMCTL_CHILD_OS_ACTIVITY_DT_MODE: 'enable' },
      },
    );
    const errors = [];
    let buffer = '';
    const chunks = new Map();
    let done = false;
    const finish = (report) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGINT');
      resolve({ report, errors });
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    const onData = (data) => {
      buffer += data.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (/rror|rash|xception/.test(text) && !text.includes('RNRS_SMOKE'))
          errors.push(text.slice(0, 400));
        const m = text.match(/RNRS_SMOKE (\d+)\/(\d+) (.*)$/);
        if (m) {
          chunks.set(Number(m[1]), m[3]);
          const n = Number(m[2]);
          if (chunks.size === n)
            finish(JSON.parse(Array.from({ length: n }, (_, k) => chunks.get(k + 1)).join('')));
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => finish(null));
    child.on('error', reject);
  });
}

simctl('install', device, app);
const launches = [];
try {
  for (let i = 0; i < LAUNCHES; i++) launches.push(await launch());
} finally {
  try {
    simctl('terminate', device, bundleId);
  } catch {
    /* not running */
  }
  simctl('uninstall', device, bundleId);
}
const checks = launches.map((l, i) => ({
  name: `cold launch ${i + 1}: smoke report ok`,
  ok: l.report?.ok === true,
  detail: JSON.stringify(l.report?.checks ?? l.report ?? 'no RNRS_SMOKE report'),
}));
const result = {
  evidence: 'iOS simulator (not a physical device)',
  commit: arg('--commit'),
  simulator: { name: sim.name, type: sim.deviceTypeIdentifier, runtime: sim.runtime },
  app,
  bundleId,
  checks,
  consoleErrors: launches.flatMap((l) => l.errors).slice(0, 50),
  ok: checks.every((c) => c.ok),
};
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
if (out) writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
process.exit(result.ok ? 0 : 1);
