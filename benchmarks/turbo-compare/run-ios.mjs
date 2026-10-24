// Runs the comparison app (build-ios.sh) on a physical iPhone from the Mac: checks the device's
// UDID and model, installs the build's .app once (after checking its manifest hash against the
// build), then makes fresh-process runs (devicectl launch --terminate-existing), each with an
// independent CSPRNG seed in RNRSCMP_CONFIG. Reports arrive as console.error lines; the launch
// environment's OS_ACTIVITY_DT_MODE mirrors os_log to the captured console. iOS gives no hash of
// the installed bundle, so the check is on the local bundle. No device setting is changed.
//   node benchmarks/turbo-compare/run-ios.mjs --build <dir> --out <dir> --device <devicectl id>
//     --udid <UDID> --expect-model "iPhone 12 Pro" [--runs 2] [--rounds 4] [--warmup 2]
//     [--target-ms 10] [--mode timed|smoke] [--settle-ms 1500] [--timeout-s 900]
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
const DEVICE = opt('device');
const UDID = opt('udid');
const MODEL = opt('expect-model');
const RUNS = Number(opt('runs', '2'));
const RUN_CONFIG = {
  mode: opt('mode', 'timed'),
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

if (existsSync(OUT) && readdirSync(OUT).length) throw new Error(`${OUT} is not empty`);
mkdirSync(OUT, { recursive: true });
const provenance = JSON.parse(readFileSync(path.join(BUILD, 'provenance.json'), 'utf8'));
const BUNDLE = path.join(BUILD, 'build/Build/Products/Release-iphoneos/HelloWorld.app');
const BUNDLE_ID = provenance.bundleId;

function manifestSha() {
  const files = execFileSync('find', ['.', '-type', 'f'], { cwd: BUNDLE, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : 1));
  const lines = files.map(
    (f) =>
      `${f} ${execFileSync('shasum', ['-a', '256', f], { cwd: BUNDLE, encoding: 'utf8' }).split(' ')[0]}\n`,
  );
  const tmp = mkdtempSync(path.join(tmpdir(), 'rnrscmp-'));
  writeFileSync(path.join(tmp, 'm.txt'), lines.join(''));
  return execFileSync('shasum', ['-a', '256', path.join(tmp, 'm.txt')], { encoding: 'utf8' }).split(
    ' ',
  )[0];
}
if (manifestSha() !== provenance.appManifestSha256)
  throw new Error('local .app does not match provenance.json');

const devicectl = (...a) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rnrscmp-devicectl-'));
  const json = path.join(dir, 'out.json');
  execFileSync('xcrun', ['devicectl', ...a, '--json-output', json, '--quiet'], {
    stdio: 'ignore',
    timeout: 300000,
  });
  return JSON.parse(readFileSync(json, 'utf8'));
};
function deviceInfo() {
  const info = devicectl('device', 'info', 'details', '--device', DEVICE).result;
  return {
    at: new Date().toISOString(),
    udid: info.hardwareProperties?.udid,
    model: info.hardwareProperties?.marketingName,
    product: info.hardwareProperties?.productType,
    os: info.deviceProperties?.osVersionNumber,
    build: info.deviceProperties?.osBuildUpdate,
    bootState: info.deviceProperties?.bootState,
  };
}
const device = deviceInfo();
if (device.udid !== UDID || device.model !== MODEL)
  throw new Error(`device mismatch: ${JSON.stringify(device)}`);

// The runner's source: a git archive's REVISION file (the Mac copy), or the git checkout.
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const runnerRevision = existsSync(path.join(ROOT, 'REVISION'))
  ? { commit: readFileSync(path.join(ROOT, 'REVISION'), 'utf8').trim(), source: 'git archive' }
  : {
      commit: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      source: 'git checkout',
    };
const runnerProvenance = {
  runnerCommit: runnerRevision.commit,
  runnerSource: runnerRevision.source,
  build: BUILD,
  buildCommit: provenance.commit,
  binarySha256: provenance.binarySha256,
  appManifestSha256: provenance.appManifestSha256,
  localBundleVerified: true,
  device,
  runConfig: RUN_CONFIG,
  plannedRuns: RUNS,
  runs: [],
  startedAt: new Date().toISOString(),
};
writeFileSync(path.join(OUT, 'build-provenance.json'), JSON.stringify(provenance, null, 1) + '\n');
devicectl('device', 'install', 'app', '--device', DEVICE, BUNDLE);
const apps =
  devicectl('device', 'info', 'apps', '--device', DEVICE, '--bundle-id', BUNDLE_ID).result?.apps ??
  [];
runnerProvenance.installed = apps.map((a) => ({
  bundleIdentifier: a.bundleIdentifier,
  version: a.version,
  bundleVersion: a.bundleVersion,
  url: a.url,
}));

async function oneRun(index) {
  const seed = newSeed();
  const runId = `i${Date.now().toString(36)}-${index}`;
  const config = { runId, seed, ...RUN_CONFIG };
  const before = deviceInfo();
  const raw = [];
  const reports = collector(runId);
  let report = null;
  let done = false;
  const launchedAt = new Date().toISOString();
  await new Promise((resolve, reject) => {
    const child = spawn(
      'xcrun',
      [
        'devicectl',
        'device',
        'process',
        'launch',
        '--device',
        DEVICE,
        '--console',
        '--terminate-existing',
        '--environment-variables',
        JSON.stringify({ OS_ACTIVITY_DT_MODE: 'enable', RNRSCMP_CONFIG: JSON.stringify(config) }),
        BUNDLE_ID,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const timer = setTimeout(() => {
      child.kill('SIGINT');
      resolve();
    }, TIMEOUT_MS);
    let buffer = '';
    const onData = (data) => {
      buffer += data.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        raw.push(text);
        const r = reports.line(text);
        if (r?.type === 'report' || r?.type === 'error') report = r;
        if (r?.type === 'done' || r?.type === 'error') {
          done = r.type === 'done';
          clearTimeout(timer);
          child.kill('SIGINT');
          resolve();
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', reject);
  });
  await new Promise((r) => setTimeout(r, 2000));
  const after = deviceInfo();
  if (before.udid !== UDID || after.udid !== UDID)
    throw new Error(`device changed: ${before.udid} ${after.udid}`);
  const record = {
    runId,
    seed,
    index,
    udid: before.udid,
    binarySha256: provenance.binarySha256,
    launchedAt,
    done,
    before,
    after,
    report,
  };
  writeFileSync(path.join(OUT, `run-${index}.json`), JSON.stringify(record) + '\n');
  writeFileSync(path.join(OUT, `run-${index}.console.txt`), raw.join('\n') + '\n');
  runnerProvenance.runs.push({
    index,
    runId,
    seed,
    done,
    thermalStateStart: report?.env?.thermalStateStart ?? null,
    thermalStateEnd: report?.thermalStateEnd ?? null,
  });
  console.log(
    `run ${index} ${runId} seed ${seed}: ${done ? 'done' : 'FAILED'}${report?.type === 'error' ? ` (${report.message})` : ''}, thermalState ${report?.env?.thermalStateStart}->${report?.thermalStateEnd}`,
  );
  if (!done) return 'run failed';
  const t0 = report?.env?.thermalStateStart,
    t1 = report?.thermalStateEnd;
  if (t0 !== 0 || t1 !== 0) return `thermalState ${t0}->${t1}`;
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
  writeFileSync(
    path.join(OUT, 'runner-provenance.json'),
    JSON.stringify(runnerProvenance, null, 1) + '\n',
  );
}
process.exit(ok ? 0 : 1);
