// Runs the clean iOS consumer (scripts/consumer/ios-app.sh, signed device build) on a
// connected iPhone and checks its reports. The app runs the smoke test and the shared suites,
// then reloads itself through React Native's reload path five times with work in flight
// (fixtures/consumer/ios/device.ts). Reports arrive as console.error lines: a release build
// forwards them to os_log, and OS_ACTIVITY_DT_MODE mirrors os_log to the console devicectl
// captures. The fixture app is uninstalled afterwards unless --keep is given.
// --simulator: --device is a booted simulator's UDID; installs the iphonesimulator build with
// simctl instead (simulator evidence, labelled so in the report).
// Usage (on the Mac): node scripts/consumer/ios-device-test.mjs --device <id> --bundle-id <id> [--simulator] [--commit <hash>] [--keep] [out.json]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The consumer directory of scripts/consumer/ios-app.sh (RNRS_IOS_OUT there), --consumer here.
const arg0 = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const CONSUMER = path.resolve(arg0('--consumer') ?? path.join(ROOT, '.generated/consumer-ios'));
const simulator = process.argv.includes('--simulator');
const APP = path.join(
  CONSUMER,
  `build/Build/Products/Release-${simulator ? 'iphonesimulator' : 'iphoneos'}/HelloWorld.app`,
);
// --default: the default package (no RNRS_TEST_HOOKS); the app then runs only the smoke.
const defaultMode = process.argv.includes('--default');
// --expect-console <regex> (repeatable): a device console line (os_log is mirrored there)
// must match, e.g. the Rust logging startup lines.
const expectConsole = process.argv.flatMap((a, i, all) =>
  a === '--expect-console' ? [new RegExp(all[i + 1])] : [],
);
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const device = arg('--device');
const bundleId = arg('--bundle-id');
const keep = process.argv.includes('--keep');
const out = process.argv
  .slice(2)
  .filter(
    (a, i, all) =>
      !a.startsWith('--') &&
      !['--device', '--bundle-id', '--commit', '--consumer', '--expect-console'].includes(
        all[i - 1],
      ),
  )
  .pop();
if (!device || !bundleId) {
  console.error('usage: ios-device-test.mjs --device <id> --bundle-id <id> [--keep] [out.json]');
  process.exit(2);
}
const TIMEOUT_MS = 240000;

const devicectl = (...args) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rnrs-devicectl-'));
  const json = path.join(dir, 'out.json');
  execFileSync('xcrun', ['devicectl', ...args, '--json-output', json, '--quiet'], {
    encoding: 'utf8',
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(readFileSync(json, 'utf8'));
};

/** Reassembles `RNRS_IOS <id> <i>/<n> <chunk>` lines into records, in order of completion. */
function collector() {
  const parts = new Map();
  const records = [];
  return {
    records,
    line(text) {
      const m = text.match(/RNRS_IOS (\S+) (\d+)\/(\d+) (.*)$/);
      if (!m) return null;
      const [, id, i, n, chunk] = m;
      const entry = parts.get(id) ?? { n: Number(n), chunks: new Map() };
      entry.chunks.set(Number(i), chunk);
      parts.set(id, entry);
      if (entry.chunks.size !== entry.n) return null;
      parts.delete(id);
      const record = JSON.parse(
        Array.from({ length: entry.n }, (_, k) => entry.chunks.get(k + 1)).join(''),
      );
      records.push(record);
      return record;
    },
  };
}

const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' });
function describeDevice() {
  if (simulator) {
    const sim = Object.entries(JSON.parse(simctl('list', 'devices', '-j')).devices)
      .flatMap(([runtime, ds]) => ds.map((d) => ({ ...d, runtime })))
      .find((d) => d.udid === device);
    if (!sim) throw new Error(`no simulator ${device}`);
    return { simulator: true, model: sim.name, product: sim.deviceTypeIdentifier, os: sim.runtime };
  }
  const info = devicectl('device', 'info', 'details', '--device', device).result;
  return {
    model: info.hardwareProperties?.marketingName,
    product: info.hardwareProperties?.productType,
    os: info.deviceProperties?.osVersionNumber,
    build: info.deviceProperties?.osBuildUpdate,
  };
}
const deviceInfo = describeDevice();
if (simulator) simctl('install', device, APP);
else devicectl('device', 'install', 'app', '--device', device, APP);
const reports = collector();
const log = [];
const raw = [];
let done = false;
try {
  await new Promise((resolve, reject) => {
    // OS_ACTIVITY_DT_MODE mirrors os_log to the captured console (simctl passes SIMCTL_CHILD_*).
    const child = simulator
      ? spawn(
          'xcrun',
          ['simctl', 'launch', '--console-pty', '--terminate-running-process', device, bundleId],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, SIMCTL_CHILD_OS_ACTIVITY_DT_MODE: 'enable' },
          },
        )
      : spawn(
          'xcrun',
          [
            'devicectl',
            'device',
            'process',
            'launch',
            '--device',
            device,
            '--console',
            '--terminate-existing',
            '--environment-variables',
            JSON.stringify({ OS_ACTIVITY_DT_MODE: 'enable' }),
            bundleId,
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
        const text = buffer.slice(0, nl).replace(/\r$/, ''); // devicectl writes CRLF
        buffer = buffer.slice(nl + 1);
        raw.push(text);
        if (/\brnrs\b|RNRS_IOS|rror|rash|xception/.test(text)) log.push(text.slice(0, 400));
        const record = reports.line(text);
        if (record)
          console.log(
            `report: ${record.type}${record.phase !== undefined ? ` (phase ${record.phase})` : ''}${record.ok === false ? ' FAILED' : ''}`,
          );
        if (record?.type === 'done' || record?.type === 'error') {
          done = record.type === 'done';
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
} finally {
  if (!keep) {
    try {
      if (simulator) simctl('uninstall', device, bundleId);
      else devicectl('device', 'uninstall', 'app', '--device', device, bundleId);
    } catch {
      /* best effort */
    }
  }
}

// ---- checks over the reports ----------------------------------------------------------
const records = reports.records;
const of = (type) => records.filter((r) => r.type === type);
const checks = [];
const check = (name, ok, detail = '') =>
  checks.push({
    name,
    ok: !!ok,
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
  });
const after = of('after-reload')[0];
const runtimes = of('runtime');
if (defaultMode) {
  const smoke = of('smoke')[0],
    finished = of('done')[0];
  check(
    'one runtime: ios backend, release Hermes, built without the native test hooks',
    runtimes.length === 1 &&
      runtimes[0].platform === 'ios' &&
      runtimes[0].env.build === 'release' &&
      runtimes[0].env.hermes &&
      runtimes[0].testHooks === false,
    runtimes.map((r) => ({ platform: r.platform, testHooks: r.testHooks })),
  );
  check(
    'consumer smoke (counter, 35 blake3 vectors, validation, async)',
    smoke?.ok,
    smoke?.checks?.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}`).join('; '),
  );
  check(
    'no native test hook is exposed to JS',
    finished?.defaultBuild && finished.hooksExposed.length === 0,
    finished?.hooksExposed ?? 'no report',
  );
  check(
    'finished without an error report',
    done && of('error').length === 0,
    of('error')
      .map((e) => e.error)
      .join('\n'),
  );
} else {
  check(
    'six runtimes in one process (initial + 5 reloads)',
    runtimes.length === 6 && runtimes.every((r, i) => r.phase === i),
    runtimes.map((r) => `phase ${r.phase} scope ${r.scopeId} gen ${r.generation}`).join(', '),
  );
  check(
    'platform backend is ios, release Hermes build',
    runtimes.every((r) => r.platform === 'ios' && r.env.build === 'release' && r.env.hermes),
  );
  const smoke = of('smoke')[0];
  check(
    'consumer smoke (counter, 35 blake3 vectors, validation, async)',
    smoke?.ok,
    smoke?.checks?.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}`).join('; '),
  );
  const suites = of('suites')[0];
  check(
    'shared suites (conformance, meter, values, blake3)',
    suites?.ok,
    suites && `${suites.passed}/${suites.total}`,
  );
  for (const c of of('check').filter((c) => !c.ok))
    check(`suite check: ${c.name}`, false, c.detail);
  // On a test-hooks build the number[] check must exercise its forced mid-fill failure (the
  // shared suite only reports "hook not compiled in" when the hook is unwired).
  const numberCheck = of('check').find((c) => c.name.startsWith('values: number[] results'));
  check(
    'number[] forced mid-fill failure ran (test hooks)',
    !!numberCheck &&
      /number fill failure forced/.test(numberCheck.detail ?? '') &&
      !/hook not compiled in/.test(numberCheck.detail ?? ''),
    numberCheck?.detail ?? 'no number[] check reported',
  );
  // On iOS the next runtime starts while the old one still waits for its invalidation (queued
  // behind its busy JS thread); judge the hook once the new runtime has waited for old work.
  const firstLifecycle = after?.drained.lifecycle;
  check(
    'reload with work in flight: the old scope was invalidated once, off the JS thread, tearing down its adapters',
    firstLifecycle?.scopesInvalidated === 1 &&
      firstLifecycle.invalidateOnJsThread === 0 &&
      firstLifecycle.adaptersTornDownAtInvalidate === firstLifecycle.adaptersAliveAtInvalidate &&
      firstLifecycle.adaptersTornDownAtInvalidate > 0,
    firstLifecycle && {
      newRuntimeStartedBeforeInvalidation: runtimes[1]?.lifecycle.scopesInvalidated === 0,
      thread: firstLifecycle.lastInvalidateThread,
      js: firstLifecycle.jsThreadName,
      tornDown: firstLifecycle.adaptersTornDownAtInvalidate,
      alive: firstLifecycle.adaptersAliveAtInvalidate,
      drains: [firstLifecycle.drainsPosted, firstLifecycle.drainsRun, firstLifecycle.drainsSkipped],
    },
  );
  check(
    'reload: old work drained (budget 0 running, 0 orphaned), new generation works, no violations',
    after &&
      after.drained.stats.budgetRunning === 0 &&
      after.drained.stats.budgetOrphaned === 0 &&
      after.value === 2 &&
      after.violations.length === 0,
    after && {
      first: {
        running: after.first.stats.budgetRunning,
        orphaned: after.first.stats.budgetOrphaned,
      },
      value: after.value,
      tornDown: {
        lifecycle: after.drained.stats.tornDownLifecycle,
        destructor: after.drained.stats.tornDownDestructor,
      },
      teardown: {
        cancelled: after.drained.stats.teardownCancelled,
        discardedQueued: after.drained.stats.teardownDiscardedQueued,
        stillRunning: after.drained.stats.teardownStillRunning,
      },
      finalizers: {
        total: after.drained.stats.nativeFinalizers,
        offJs: after.drained.stats.nativeFinalizersOffJsThread,
        bytesOffJs: after.drained.stats.bytesFinalizedOffJsThread,
      },
    },
  );
  const churn = of('churned');
  const admitted = churn.map((c) => c.admitted),
    saturated = churn.map((c) => c.saturated);
  check(
    'repeated reloads with uncancellable jobs stay within the executor budget (admitted 12,12,8,0)',
    JSON.stringify(admitted) === '[12,12,8,0]' &&
      JSON.stringify(saturated) === '[0,0,4,12]' &&
      churn.every((c) => (c.stats.budgetPeak ?? 0) <= 32),
    {
      admitted,
      saturated,
      peak: churn.map((c) => c.stats.budgetPeak),
      message: churn.at(-1)?.message,
    },
  );
  const drained = of('drained')[0];
  check(
    'after the jobs exit: 0 running, 0 orphaned, admission works, no violations',
    drained &&
      drained.stats.budgetRunning === 0 &&
      drained.stats.budgetOrphaned === 0 &&
      drained.value === 2 &&
      drained.violations.length === 0,
    drained && {
      lifecycle: {
        invalidated: drained.lifecycle.scopesInvalidated,
        onJs: drained.lifecycle.invalidateOnJsThread,
        tornDown: drained.lifecycle.adaptersTornDownAtInvalidate,
        created: drained.lifecycle.scopesCreated,
        destroyed: drained.lifecycle.scopesDestroyed,
      },
      destructorTeardowns: drained.stats.tornDownDestructor,
      native: drained.after.stats.native,
    },
  );
  const refused = of('refused')[0];
  check(
    'registration after invalidation is refused and freed at once',
    refused &&
      refused.error.includes('runtime is being torn down') &&
      refused.after.hostsCreated - refused.before.hostsCreated === 1 &&
      refused.after.hostsFreed - refused.before.hostsFreed === 1 &&
      refused.after.tornDownRefused - refused.before.tornDownRefused === 1 &&
      refused.after.tornDownDestructor === refused.before.tornDownDestructor,
    refused && { error: refused.error, mainAfter: refused.mainAfter },
  );
  check(
    'every phase finished without an error report',
    done && of('error').length === 0,
    of('error')
      .map((e) => e.error)
      .join('\n'),
  );
  // Observations documented in docs/ios.md, asserted so that a React Native change is noticed.
  check(
    'no destructor-fallback teardown and no invalidation on a JS thread in any runtime',
    drained &&
      drained.stats.tornDownDestructor === 0 &&
      drained.lifecycle.invalidateOnJsThread === 0 &&
      runtimes.every((r) => (r.stats.tornDownDestructor ?? 0) === 0),
    drained && {
      destructor: drained.stats.tornDownDestructor,
      onJs: drained.lifecycle.invalidateOnJsThread,
    },
  );
  check(
    'React Native starts the next runtime before invalidating the old one (iOS reload overlap)',
    runtimes[1]?.lifecycle.scopesInvalidated === 0 &&
      runtimes[1]?.lifecycle.bindingsInstalled === 2,
    runtimes[1] && { invalidatedWhenPhase1Started: runtimes[1].lifecycle.scopesInvalidated },
  );
}
for (const re of expectConsole) {
  const line = raw.find((l) => re.test(l));
  check(`device console has a line matching ${re}`, line, line ?? 'none');
}
/** Build/toolchain provenance, from the Mac this runs on (commit: --commit, or RNRS_COMMIT). */
function provenance() {
  const sh = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000 }).trim();
    } catch {
      return null;
    }
  };
  return {
    commit: arg('--commit') ?? process.env.RNRS_COMMIT ?? null,
    macos: sh('sw_vers', ['-productVersion']),
    xcode: sh('xcodebuild', ['-version'])?.split('\n').join(' '),
    node: process.version,
    rustc: sh('env', [
      `RUSTUP_HOME=${process.env.RUSTUP_HOME ?? path.join(ROOT, '.generated/rustup')}`,
      'rustup',
      'run',
      process.env.RUSTUP_TOOLCHAIN ?? '1.90.0',
      'rustc',
      '--version',
    ]),
    cocoapods: sh('pod', ['--version']),
    reactNative: JSON.parse(
      readFileSync(path.join(CONSUMER, 'rn-app/node_modules/react-native/package.json'), 'utf8'),
    ).version,
    testHooksBuild: !defaultMode,
    appLogging:
      JSON.parse(readFileSync(path.join(CONSUMER, 'rn-app/package.json'), 'utf8')).rustNativeApp
        ?.logging ?? null,
    app: APP,
    appBinarySha256: sh('shasum', ['-a', '256', path.join(APP, 'HelloWorld')])?.split(' ')[0],
  };
}

const result = {
  ok: checks.every((c) => c.ok),
  device: deviceInfo,
  provenance: provenance(),
  checks,
  records,
  log: log.slice(-200),
};
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name} ${c.detail}`);
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
if (out) writeFileSync(`${out}.console.txt`, raw.join('\n'));
console.log(result.ok ? 'OK: iOS consumer device test passed' : 'FAILED');
process.exit(result.ok ? 0 : 1);
