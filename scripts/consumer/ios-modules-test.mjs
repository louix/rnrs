// Runs the clean iOS http/kv consumer (scripts/consumer/ios-app.sh with RNRS_IOS_FIXTURE=modules,
// signed device build) on a connected iPhone and checks its reports
// (fixtures/ios-modules-consumer/modules.ts).
//
// - Serves scripts/http-test-server.mjs on a Mac address the phone can reach (there is no
//   `adb reverse`): by default the USB network link's link-local address. The app must be
//   built with RNRS_IOS_LOCAL_NETWORK_USAGE and be granted iOS's Local Network permission
//   once on the phone (refused connections fail with "No route to host" until then). Plus an
//   HTTPS server with a throwaway self-signed leaf certificate generated for the run.
// - Launch 1 ('run'): smokes, a reload with work in flight, then a flushed write left open.
//   The runner lists the app's data container, kills the process with SIGKILL, and
// - launch 2 ('verify') reads the write back and deletes the test databases; the container is
//   listed again. The app is uninstalled afterwards unless --keep is given.
// Usage (on the Mac): node scripts/consumer/ios-modules-test.mjs --device <id> --bundle-id <id>
//   [--consumer <dir>] [--host <address>] [--public-https <url> | --no-public-https]
//   [--commit <hash>] [--keep] [out.json]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../http-test-server.mjs';
import { selectAppPid } from './ios-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const VALUED = ['--device', '--bundle-id', '--commit', '--consumer', '--host', '--public-https'];
const out = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith('--') && !VALUED.includes(all[i - 1]))
  .pop();
const device = arg('--device');
const bundleId = arg('--bundle-id');
const keep = process.argv.includes('--keep');
if (!device || !bundleId) {
  console.error('usage: ios-modules-test.mjs --device <id> --bundle-id <id> [--keep] [out.json]');
  process.exit(2);
}
const CONSUMER = path.resolve(
  arg('--consumer') ?? path.join(ROOT, '.generated/consumer-ios-modules'),
);
const APP = path.join(CONSUMER, 'build/Build/Products/Release-iphoneos/HelloWorld.app');
const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000 }).trim();
  } catch {
    return null;
  }
};
// Default: the Mac's link-local IPv4 address on the USB network link to a wired iPhone
// (169.254/16), else en0. A phone on Wi-Fi only needs --host <the Mac's LAN address>.
const HOST =
  arg('--host') ??
  sh('ifconfig', [])?.match(/inet (169\.254\.\d+\.\d+)/)?.[1] ??
  sh('ipconfig', ['getifaddr', 'en0']);
// A small publicly trusted page (Apple's connectivity check): the one check that leaves the
// local link. The phone makes a DNS lookup and a GET over the internet; no data is sent.
// The Android and browser consumers use only local servers. --no-public-https skips it.
const PUBLIC_HTTPS = process.argv.includes('--no-public-https')
  ? ''
  : (arg('--public-https') ?? 'https://www.apple.com/library/test/success.html');
const NONCE = `n${process.pid}-${Date.now()}`;
const PHASE_TIMEOUT_MS = 180000;

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

/** Reassembles `RNRS_IOS <id> <i>/<n> <chunk>` lines into records. */
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

const reports = collector();
const raw = [];
/** Launches the app with the console attached until a record of type `until` (or an error). */
function launch(phase, until, onRecord = () => {}) {
  const defaults = {
    rnrsPhase: phase,
    rnrsNonce: NONCE,
    rnrsHttpBase: `http://${HOST}:8787`,
    rnrsHttpsLocal: `https://${HOST}:8788/`,
    rnrsHttpsPublic: PUBLIC_HTTPS,
  };
  const launchArgs = Object.entries(defaults).flatMap(([k, v]) => [`-${k}`, v]);
  return new Promise((resolve, reject) => {
    const child = spawn(
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
        '--',
        bundleId,
        ...launchArgs,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      child.kill('SIGINT');
      finish(null);
    }, PHASE_TIMEOUT_MS);
    let buffer = '';
    const onData = async (data) => {
      buffer += data.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, nl).replace(/\r$/, ''); // devicectl writes CRLF
        buffer = buffer.slice(nl + 1);
        raw.push(text);
        const record = reports.line(text);
        if (!record) continue;
        console.log(`report: ${record.type}${record.ok === false ? ' FAILED' : ''}`);
        if (record.type === until || record.type === 'error') finish({ record, child });
        onRecord(record);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => finish(null));
    child.on('error', reject);
  });
}

/** Files of the app's data container under Library/Application Support (relative paths). */
function appSupportFiles() {
  const r = devicectl(
    'device',
    'info',
    'files',
    '--device',
    device,
    '--domain-type',
    'appDataContainer',
    '--domain-identifier',
    bundleId,
    '--subdirectory',
    'Library/Application Support',
  );
  return (r.result?.files ?? []).map((f) => f.relativePath).sort();
}

/** This bundle's process id: its installed bundle path, then that exact executable path
 *  (other apps, such as other template builds, are also "HelloWorld"). Throws unless exactly
 *  one matches (scripts/consumer/ios-process.mjs). */
function appPid() {
  const apps = devicectl('device', 'info', 'apps', '--device', device).result?.apps;
  const processes = devicectl('device', 'info', 'processes', '--device', device).result
    ?.runningProcesses;
  const executable = execFileSync(
    'plutil',
    ['-extract', 'CFBundleExecutable', 'raw', path.join(APP, 'Info.plist')],
    { encoding: 'utf8' },
  ).trim();
  return selectAppPid({ apps, processes, bundleId, executable });
}

// ---- servers -----------------------------------------------------------------------------
const certDir = mkdtempSync(path.join(tmpdir(), 'rnrs-https-'));
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    path.join(certDir, 'key.pem'),
    '-out',
    path.join(certDir, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=rnrs-ios-test',
    // A well-formed leaf for the address the app connects to: only its issuer is untrusted.
    '-addext',
    'basicConstraints=critical,CA:FALSE',
    '-addext',
    `subjectAltName=IP:${HOST}`,
    '-addext',
    'extendedKeyUsage=serverAuth',
  ],
  { stdio: 'ignore' },
);
const httpServer = await startServer(8787, HOST);
const httpsServer = https.createServer(
  {
    key: readFileSync(path.join(certDir, 'key.pem')),
    cert: readFileSync(path.join(certDir, 'cert.pem')),
  },
  (req, res) => res.end('reached'),
);
const httpsLog = { handshakeErrors: [], requests: 0 };
httpsServer.on('tlsClientError', (e) =>
  httpsLog.handshakeErrors.push(String(e.message).slice(0, 200)),
);
httpsServer.on('request', () => httpsLog.requests++);
await new Promise((resolve) => httpsServer.listen(8788, HOST, resolve));
console.log(`test servers on http://${HOST}:8787 and https://${HOST}:8788 (self-signed)`);

const info = devicectl('device', 'info', 'details', '--device', device).result;
const deviceInfo = {
  model: info.hardwareProperties?.marketingName,
  product: info.hardwareProperties?.productType,
  os: info.deviceProperties?.osVersionNumber,
  build: info.deviceProperties?.osBuildUpdate,
};
const files = {};
let killed = null,
  killError = null;
let runDone = null,
  verified = null;
try {
  devicectl('device', 'install', 'app', '--device', device, APP);
  const run = await launch('run', 'run-done');
  runDone = run?.record?.type === 'run-done' ? run.record : null;
  if (runDone) {
    files.afterRun = appSupportFiles();
    // SIGKILL: no app or Rust shutdown code runs; only the flush before it is relied on.
    // No signal is sent unless exactly this bundle's process was identified.
    try {
      const pid = appPid();
      devicectl(
        'device',
        'process',
        'signal',
        '--device',
        device,
        '--pid',
        String(pid),
        '--signal',
        'SIGKILL',
      );
      killed = { pid, signal: 'SIGKILL' };
    } catch (e) {
      killError = String(e.message ?? e);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    run.child.kill('SIGINT');
    const verify = await launch('verify', 'verified');
    verified = verify?.record?.type === 'verified' ? verify.record : null;
    verify?.child.kill('SIGINT');
    files.afterVerify = appSupportFiles();
  } else {
    run?.child.kill('SIGINT');
  }
} finally {
  if (!keep) {
    try {
      devicectl('device', 'uninstall', 'app', '--device', device, bundleId);
    } catch {
      /* best effort */
    }
  }
  httpServer.closeAllConnections();
  httpServer.close();
  httpsServer.close();
}

// ---- checks over the reports --------------------------------------------------------------
const records = reports.records;
const of = (type) => records.filter((r) => r.type === type);
const checks = [];
const check = (name, ok, detail = '') =>
  checks.push({
    name,
    ok: !!ok,
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
  });
const runtimes = of('runtime');
check(
  'three runtimes: run (initial + reload) and verify; ios backend, release Hermes, test hooks',
  runtimes.length === 3 &&
    runtimes.every(
      (r) => r.platform === 'ios' && r.env.build === 'release' && r.env.hermes && r.testHooks,
    ) &&
    JSON.stringify(runtimes.map((r) => [r.phase, r.runtime])) ===
      '[["run",0],["run",1],["verify",0]]',
  runtimes.map((r) => ({ phase: r.phase, runtime: r.runtime, platform: r.platform })),
);
for (const type of ['http-smoke', 'https', 'kv-smoke', 'kv-extra']) {
  const r = of(type)[0];
  check(
    `${type}: ${r ? `${r.checks.filter((c) => c.ok).length}/${r.checks.length}` : 'no report'}`,
    r?.ok,
    r?.checks
      .map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
      .join('; '),
  );
}
check(
  'the self-signed HTTPS server saw the handshake fail and served no request',
  httpsLog.requests === 0 && httpsLog.handshakeErrors.length > 0,
  httpsLog,
);
const armed = of('armed')[0],
  after = of('after-reload')[0];
check(
  'reload with an endless response in flight (after 24 unawaited writes): request dropped, buffers freed, connection closed by the client',
  armed &&
    after &&
    armed.http.bufferedBytes - armed.httpBefore.bufferedBytes >= 3000 &&
    after.http.active === 0 &&
    after.http.bufferedBytes === 0 &&
    after.http.droppedEarly - armed.httpBefore.droppedEarly === 1 &&
    after.closedByClient === true,
  after && {
    armedBuffered: armed?.http.bufferedBytes,
    after: after.http,
    droppedEarlyDelta: after.http.droppedEarly - (armed?.httpBefore.droppedEarly ?? 0),
    closedByClient: after.closedByClient,
  },
);
check(
  'reload: the next runtime reopened the shared database; flushed marker present, every write whole (0 torn)',
  after && after.marker === 'flushed' && after.torn === 0 && after.kv.running === 0,
  after && { marker: after.marker, applied: after.applied, torn: after.torn, kv: after.kv },
);
check(
  'run launch finished: lifecycle database deleted, token written and flushed with the handle open',
  runDone &&
    runDone.lifecycleDeleted === true &&
    runDone.persist.token === NONCE &&
    runDone.kv.openDatabases === 1,
  runDone,
);
check(
  'data container after the run: only <Application Support>/rnrs/kv/rnrs-ios-persist',
  files.afterRun &&
    files.afterRun.some((f) => f.startsWith('rnrs/kv/rnrs-ios-persist/')) &&
    files.afterRun.every(
      (f) => f === 'rnrs' || f === 'rnrs/kv' || f.startsWith('rnrs/kv/rnrs-ios-persist'),
    ),
  files.afterRun ?? 'not listed',
);
check('process killed (SIGKILL) with the database open', killed && !killError, killed ?? killError);
check(
  'after the kill and a relaunch: the flushed token was read back; test databases deleted',
  verified &&
    verified.token === NONCE &&
    Object.values(verified.cleanup).every((v) => typeof v === 'boolean') &&
    verified.cleanup['rnrs-ios-persist'] === true,
  verified ?? 'no report',
);
check(
  'data container after verify: no database left under <Application Support>/rnrs/kv',
  files.afterVerify && files.afterVerify.every((f) => f === 'rnrs' || f === 'rnrs/kv'),
  files.afterVerify ?? 'not listed',
);
check(
  'no error report',
  of('error').length === 0,
  of('error')
    .map((e) => e.error)
    .join('\n'),
);

const result = {
  ok: checks.every((c) => c.ok),
  device: deviceInfo,
  host: HOST,
  publicHttps: PUBLIC_HTTPS || null,
  nonce: NONCE,
  killed,
  files,
  httpsLog,
  provenance: {
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
    app: APP,
    appBinarySha256: sh('shasum', ['-a', '256', path.join(APP, 'HelloWorld')])?.split(' ')[0],
    lockSha256: sh('shasum', [
      '-a',
      '256',
      path.join(CONSUMER, 'rn-app/rnrs-ios.Cargo.lock'),
    ])?.split(' ')[0],
  },
  checks,
  records,
};
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name} ${c.detail}`);
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
if (out)
  writeFileSync(
    `${out}.console.txt`,
    raw.filter((l) => /RNRS_IOS|rnrs|rror|rash|xception/.test(l)).join('\n'),
  );
console.log(result.ok ? 'OK: iOS http/kv consumer device test passed' : 'FAILED');
process.exit(result.ok ? 0 : 1);
