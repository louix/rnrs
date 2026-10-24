// Runs the comparison app (build-android.sh) on one Android device: installs the build's APK,
// checks the installed copy's hash, then makes fresh-process runs, each with an independent
// CSPRNG seed, recording device state (thermal, battery, CPU frequencies) before and after.
// Every adb command names the serial. No device setting is changed; logcat is read, not cleared.
//   node benchmarks/turbo-compare/run-android.mjs --build <dir> --out <dir> --serial <s>
//     --expect-model "<model>" [--runs 2] [--rounds 4] [--warmup 2] [--target-ms 10]
//     [--mode timed|smoke] [--settle-ms 1500] [--timeout-s 900] [--uninstall]
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collector, newSeed } from './runner-lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) {
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
  }
  return args[i + 1];
};
const BUILD = path.resolve(opt('build'));
const OUT = path.resolve(opt('out'));
const SERIAL = opt('serial');
const MODEL = opt('expect-model');
const RUNS = Number(opt('runs', '2'));
const MODE = opt('mode', 'timed');
const RUN_CONFIG = {
  mode: MODE,
  rounds: Number(opt('rounds', '4')),
  warmupRounds: Number(opt('warmup', '2')),
  targetMs: Number(opt('target-ms', '10')),
  settleMs: Number(opt('settle-ms', '1500')),
  // --fixed-n <json file>: iterations per sample by workload for every path and process.
  ...(args.includes('--fixed-n')
    ? { fixedN: JSON.parse(readFileSync(opt('fixed-n'), 'utf8')) }
    : {}),
};
const TIMEOUT_MS = Number(opt('timeout-s', '900')) * 1000;
const APP_ID = 'dev.rustjsilab.rnrscmp';
const ACTIVITY = `${APP_ID}/com.helloworld.MainActivity`;

if (existsSync(OUT) && readdirSync(OUT).length) throw new Error(`${OUT} is not empty`);
mkdirSync(OUT, { recursive: true });
const provenance = JSON.parse(readFileSync(path.join(BUILD, 'provenance.json'), 'utf8'));
const APK = path.join(BUILD, 'app-release.apk');
const sha256 = (f) => execFileSync('sha256sum', [f], { encoding: 'utf8' }).split(' ')[0];
if (sha256(APK) !== provenance.apkSha256) throw new Error('APK does not match provenance.json');

const adb = (...a) =>
  execFileSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 120000 }).trim();
const shell = (cmd) => adb('shell', cmd);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Device identity: the serial must be attached, and report itself and the expected model.
const listed = execFileSync('adb', ['devices', '-l'], { encoding: 'utf8' });
if (!listed.split('\n').some((l) => l.startsWith(`${SERIAL} `) && /\bdevice\b/.test(l)))
  throw new Error(`${SERIAL} is not attached:\n${listed}`);
const device = {
  serial: shell('getprop ro.serialno'),
  model: shell('getprop ro.product.model'),
  device: shell('getprop ro.product.device'),
  fingerprint: shell('getprop ro.build.fingerprint'),
  sdk: shell('getprop ro.build.version.sdk'),
  abi: shell('getprop ro.product.cpu.abi'),
  pageSize: shell('getconf PAGE_SIZE'),
};
if (device.serial !== SERIAL || device.model !== MODEL)
  throw new Error(`device mismatch: ${JSON.stringify(device)} (expected ${SERIAL}, ${MODEL})`);

function deviceState() {
  const thermal = shell('dumpsys thermalservice').match(/Thermal Status: (\d+)/)?.[1] ?? null;
  const battery = Object.fromEntries(
    shell('dumpsys battery')
      .split('\n')
      .map((l) => l.trim().match(/^(level|temperature|AC powered|USB powered|status): (.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
  const cpus = shell(
    'for p in /sys/devices/system/cpu/cpufreq/policy*; do echo "$p $(cat $p/scaling_governor) $(cat $p/scaling_cur_freq) $(cat $p/scaling_min_freq) $(cat $p/scaling_max_freq 2>/dev/null || echo NA) $(cat $p/related_cpus | tr " " ,)"; done',
  )
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .map(([policy, governor, cur, min, max, cpus]) => ({
      policy: path.basename(policy),
      governor,
      cur: +cur,
      min: +min,
      max: max === 'NA' ? null : +max,
      cpus,
    }));
  const wakefulness = shell('dumpsys power').match(/mWakefulness=(\w+)/)?.[1] ?? null;
  return {
    at: new Date().toISOString(),
    wakefulness,
    thermalStatus: thermal === null ? null : +thermal,
    battery,
    cpus,
  };
}

const runnerGit = (...a) =>
  execFileSync('git', a, {
    encoding: 'utf8',
    cwd: path.dirname(new URL(import.meta.url).pathname),
  }).trim();
const runnerProvenance = {
  runnerCommit: runnerGit('rev-parse', 'HEAD'),
  runnerStatus: runnerGit('status', '--porcelain=v1').split('\n').filter(Boolean),
  build: BUILD,
  buildCommit: provenance.commit,
  apkSha256: provenance.apkSha256,
  device,
  runConfig: RUN_CONFIG,
  plannedRuns: RUNS,
  runs: [],
  startedAt: new Date().toISOString(),
};

adb('install', '-r', APK);
writeFileSync(path.join(OUT, 'build-provenance.json'), JSON.stringify(provenance, null, 1) + '\n');
const installedPath = shell(`pm path ${APP_ID}`)
  .replace(/^package:/, '')
  .split('\n')[0];
runnerProvenance.installedApkSha256 = shell(`sha256sum ${installedPath}`).split(/\s+/)[0];
if (runnerProvenance.installedApkSha256 !== provenance.apkSha256)
  throw new Error(
    `installed APK hash ${runnerProvenance.installedApkSha256} != build ${provenance.apkSha256}`,
  );

async function oneRun(index) {
  const seed = newSeed();
  const runId = `a${Date.now().toString(36)}-${index}`;
  const config = { runId, seed, ...RUN_CONFIG };
  const serial = shell('getprop ro.serialno');
  if (serial !== SERIAL) throw new Error(`serial changed: ${serial}`);
  const before = deviceState();
  shell(`am force-stop ${APP_ID}`);
  await sleep(1000);
  const lines = [];
  const reports = collector(runId);
  let report = null;
  let done = false;
  const logcat = spawn(
    'adb',
    [
      '-s',
      SERIAL,
      'logcat',
      '-v',
      'threadtime',
      '-T',
      '1',
      'ReactNativeJS:*',
      'AndroidRuntime:E',
      'DEBUG:*',
      '*:S',
    ],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const finished = new Promise((resolve) => {
    let buffer = '';
    const timer = setTimeout(resolve, TIMEOUT_MS);
    logcat.stdout.on('data', (d) => {
      buffer += d.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        lines.push(text);
        const r = reports.line(text);
        if (r?.type === 'report' || r?.type === 'error') report = r;
        if (r?.type === 'done' || r?.type === 'error') {
          done = r.type === 'done';
          clearTimeout(timer);
          resolve();
        }
      }
    });
  });
  await sleep(500);
  const url = `rnrscmp://run?config=${encodeURIComponent(JSON.stringify(config))}`;
  const launchedAt = new Date().toISOString();
  shell(`am start -W -a android.intent.action.VIEW -d '${url}' -n ${ACTIVITY}`);
  await finished;
  logcat.kill();
  const pid = shell(`pidof ${APP_ID} || true`);
  shell(`am force-stop ${APP_ID}`);
  const after = deviceState();
  const crash = adb('logcat', '-d', '-b', 'crash')
    .split('\n')
    .filter((l) => l.includes(APP_ID));
  const record = {
    runId,
    seed,
    index,
    serial,
    apkSha256: provenance.apkSha256,
    launchedAt,
    done,
    pidAtEnd: pid,
    before,
    after,
    crash,
    report,
  };
  writeFileSync(path.join(OUT, `run-${index}.json`), JSON.stringify(record) + '\n');
  writeFileSync(path.join(OUT, `run-${index}.logcat.txt`), lines.join('\n') + '\n');
  runnerProvenance.runs.push({
    index,
    runId,
    seed,
    done,
    thermalBefore: before.thermalStatus,
    thermalAfter: after.thermalStatus,
  });
  console.log(
    `run ${index} ${runId} seed ${seed}: ${done ? 'done' : 'FAILED'}` +
      (report?.type === 'error' ? ` (${report.message})` : '') +
      `, thermal ${before.thermalStatus}->${after.thermalStatus}, battery ${before.battery.temperature}->${after.battery.temperature}`,
  );
  if (!done) return 'run failed';
  if (before.thermalStatus !== 0 || after.thermalStatus !== 0)
    return `thermal status ${before.thermalStatus}->${after.thermalStatus}`;
  return 'ok';
}

let ok = true;
try {
  for (let i = 1; i <= RUNS; i++) {
    const result = await oneRun(i);
    if (result !== 'ok') {
      // Stop on a failed run (correctness, crash, timeout) or a non-nominal thermal state.
      runnerProvenance.stoppedAfterRun = { index: i, reason: result };
      console.log(`stopping after run ${i}: ${result}`);
      ok = false;
      break;
    }
  }
} finally {
  runnerProvenance.finishedAt = new Date().toISOString();
  if (args.includes('--uninstall')) {
    adb('uninstall', APP_ID);
    runnerProvenance.uninstalled = true;
  }
  writeFileSync(
    path.join(OUT, 'runner-provenance.json'),
    JSON.stringify(runnerProvenance, null, 1) + '\n',
  );
}
process.exit(ok ? 0 : 1);
