// Runs the clean consumer APK (scripts/consumer/rn-app.sh) on a connected device and reads
// its smoke result from logcat. The fixture app (com.helloworld) is uninstalled afterwards.
// Usage (inside `nix develop`): node scripts/consumer/rn-smoke.mjs [out.json]
// NAME selects the consumer (.generated/consumer/<NAME>, default rn-app). RNRS_HTTP_TEST_SERVER=1
// starts scripts/http-test-server.mjs on 127.0.0.1:8787 and maps the device's port 8787 to it
// with `adb reverse` for the run (removed afterwards). RNRS_EXPECT_LOG='["regex", ...]': lines that
// logcat must contain for the Rust log tags RNRS_LOG_TAGS (comma-separated, default rnrs_log),
// RNRS_FORBID_LOG lines it must not (Rust logging, docs/logging.md);
// RNRS_COMMIT is recorded with the result.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APK = path.join(
  ROOT,
  '.generated/consumer',
  process.env.NAME ?? 'rn-app',
  'android/app/build/outputs/apk/release/app-release.apk',
);
const PACKAGE = 'com.helloworld';
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', timeout: 60000 }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let result;
let httpServer;
try {
  if (process.env.RNRS_HTTP_TEST_SERVER) {
    const { startServer } = await import('../http-test-server.mjs');
    httpServer = await startServer(8787);
    adb('reverse', 'tcp:8787', 'tcp:8787');
  }
  adb('install', '-r', APK);
  adb('logcat', '-c');
  adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
  for (let i = 0; i < 180 && !result; i++) {
    await sleep(1000);
    const line = adb('logcat', '-d', '-s', 'ReactNativeJS:*')
      .split('\n')
      .find((l) => l.includes('RNRS_SMOKE '));
    if (line) result = JSON.parse(line.slice(line.indexOf('RNRS_SMOKE ') + 'RNRS_SMOKE '.length));
  }
  // Rust logging (docs/logging.md): Android tags each line with its target's crate.
  const expectLog = JSON.parse(process.env.RNRS_EXPECT_LOG ?? '[]').map((re) => new RegExp(re));
  const forbidLog = JSON.parse(process.env.RNRS_FORBID_LOG ?? '[]').map((re) => new RegExp(re));
  if (expectLog.length || forbidLog.length) {
    const tags = (process.env.RNRS_LOG_TAGS ?? 'rnrs_log').split(',');
    const rustLog = adb('logcat', '-d', '-s', ...tags.map((t) => `${t}:*`))
      .split('\n')
      .filter((l) => tags.some((t) => l.includes(t)));
    result = result ?? { ok: false, checks: [] };
    result.rustLog = rustLog;
    const add = (name, ok, detail) => {
      result.checks = [...(result.checks ?? []), { name, ok, detail }];
      if (!ok) result.ok = false;
    };
    for (const re of expectLog) {
      const line = rustLog.find((l) => re.test(l));
      add(`logcat (${tags.join(', ')}) has a line matching ${re}`, !!line, line ?? 'none');
    }
    for (const re of forbidLog) {
      const lines = rustLog.filter((l) => re.test(l));
      add(
        `logcat (${tags.join(', ')}) has no line matching ${re}`,
        lines.length === 0,
        lines.join(' | ') || 'none',
      );
    }
  }
  const crashes = adb('logcat', '-d', '-b', 'crash');
  if (crashes.includes(PACKAGE)) result = { ...result, ok: false, crash: crashes };
} finally {
  try {
    adb('shell', 'am', 'force-stop', PACKAGE);
    adb('uninstall', PACKAGE);
  } catch {
    /* best effort */
  }
  if (httpServer) {
    try {
      adb('reverse', '--remove', 'tcp:8787');
    } catch {
      /* best effort */
    }
    httpServer.closeAllConnections();
    httpServer.close();
  }
}
if (!result) result = { ok: false, error: 'no RNRS_SMOKE line within 180 s' };
// The build's own checks (scripts/consumer/rn-app.sh), recorded with the run.
const buildRecord = path.join(
  ROOT,
  '.generated/consumer',
  `${process.env.NAME ?? 'rn-app'}.build.json`,
);
if (existsSync(buildRecord)) result.build = JSON.parse(readFileSync(buildRecord, 'utf8'));
result.device = {
  model: adb('shell', 'getprop', 'ro.product.model'),
  sdk: adb('shell', 'getprop', 'ro.build.version.sdk'),
};
result.provenance = {
  commit: process.env.RNRS_COMMIT ?? null,
  apkSha256: execFileSync('sha256sum', [APK], { encoding: 'utf8' }).split(' ')[0],
};
for (const c of result.checks ?? []) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name} ${c.detail}`);
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2));
console.log(
  result.ok
    ? 'OK: clean consumer smoke passed on device'
    : `FAILED: ${result.error ?? 'see checks'}`,
);
process.exit(result.ok ? 0 : 1);
