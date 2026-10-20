// Device run of the surface consumer (fixtures/surface-consumer, built by
// `FIXTURE=surface-consumer MODULES=example-vello2d PACKS=rnrs-surface NAME=surface-app scripts/consumer/rn-app.sh`).
//
// Usage (inside `nix develop`): node scripts/consumer/surface-device-test.mjs <adb-serial>
//
// 1. Installs the APK, starts it, waits for `RNR_SMOKE` (the in-app lifecycle sequence) and
//    takes a screenshot.
// 2. Background (HOME) and foreground (relaunch the activity): reads `RNR_SURFACE_STATS` to
//    check that the window detaches and re-attaches and that presenting resumes.
// 3. Rotation (user_rotation, auto-rotate disabled for the run, both restored afterwards):
//    checks a resize or re-attach at the rotated size.
// 4. Process restart (force-stop, start): a fresh runtime attaches with new keys.
//
// Writes results/surface/runs/<UTC timestamp>-<serial>/{surface-device.json,*.png,logcat.txt};
// never overwrites existing results. Uninstalls the fixture app (com.helloworld) afterwards.
// Not covered here: JS reload inside one process (release builds have no dev reload).
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const serial = process.argv[2];
if (!serial) throw new Error('usage: surface-device-test.mjs <adb-serial>');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APK = path.join(ROOT, '.generated/consumer', process.env.NAME ?? 'surface-app', 'android/app/build/outputs/apk/release/app-release.apk');
const PACKAGE = 'com.helloworld';
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], {encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 26}).trim();
const adbRaw = (...args) => execFileSync('adb', ['-s', serial, ...args], {timeout: 60000, maxBuffer: 1 << 26});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
if (adb('get-state') !== 'device') throw new Error(`${serial} is not connected`);
if (!existsSync(APK)) throw new Error(`${APK} missing; build the consumer first`);

const run = path.join(ROOT, 'results/surface/runs', `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${serial}`);
if (existsSync(run)) throw new Error(`${run} exists`);
mkdirSync(run, {recursive: true});

// Lines are JSON after the tag; a line logcat truncated (near 4 KB) is reported, not fatal.
const logLines = tag => adb('logcat', '-d', '-s', 'ReactNativeJS:*').split('\n').filter(l => l.includes(`${tag} `))
  .map(l => {
    const text = l.slice(l.indexOf(`${tag} `) + tag.length + 1);
    try { return JSON.parse(text); } catch { return {truncated: true, length: text.length}; }
  });
const latestStats = () => logLines('RNR_SURFACE_STATS').at(-1);
async function waitFor(pred, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}
// Only the app's own processes' log lines are kept (the device log names other installed apps).
const pids = new Set();
const notePid = () => { try { const p = adb('shell', 'pidof', PACKAGE); if (p) pids.add(p); } catch {} };
const relevantLog = () => [...pids].map(p => adb('logcat', '-d', `--pid=${p}`)).join('\n') + '\n';
const screenshot = name => writeFileSync(path.join(run, `${name}.png`), adbRaw('exec-out', 'screencap', '-p'));
const start = () => adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], {encoding: 'utf8'});
const buildRecordFile = path.join(ROOT, '.generated/consumer', `${process.env.NAME ?? 'surface-app'}.build.json`);
const result = {
  serial, model: adb('shell', 'getprop', 'ro.product.model'), build: adb('shell', 'getprop', 'ro.build.fingerprint'),
  // What was built (scripts/consumer/rn-app.sh's record: source HEAD and full porcelain status at
  // pack time, APK sha256) and what ran it (this script's hash and the tree at run time).
  provenance: {
    apk: APK, apkSha256: sha256(APK),
    buildRecord: existsSync(buildRecordFile) ? JSON.parse(readFileSync(buildRecordFile, 'utf8')) : null,
    runner: path.relative(ROOT, fileURLToPath(import.meta.url)), runnerSha256: sha256(fileURLToPath(import.meta.url)),
    runHead: git('rev-parse', 'HEAD').trim(), runStatusPorcelain: git('status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean),
  },
  checks: [],
};
const check = (name, ok, detail) => result.checks.push({name, ok: !!ok, detail});
check('APK matches its build record', result.provenance.buildRecord?.apkSha256 === result.provenance.apkSha256,
  {built: result.provenance.buildRecord?.apkSha256 ?? null, installed: result.provenance.apkSha256, sourceClean: result.provenance.buildRecord?.sourceClean ?? null});
const rotation = {auto: adb('shell', 'settings', 'get', 'system', 'accelerometer_rotation'), user: adb('shell', 'settings', 'get', 'system', 'user_rotation')};
try {
  adb('install', '-r', APK);
  adb('logcat', '-b', 'all', '-c');
  start();
  await sleep(1000);
  notePid();
  const smoke = await waitFor(() => logLines('RNR_SMOKE')[0], 120000, 'RNR_SMOKE');
  result.smoke = {...smoke, details: logLines('RNR_SMOKE_CHECK'), samples: logLines('RNR_SMOKE_SAMPLES')[0]};
  check('in-app lifecycle sequence', smoke.ok, smoke.checks?.filter(c => !c.ok));
  await waitFor(() => latestStats(), 10000, 'steady stats');
  await sleep(1500);
  screenshot('steady');

  // Background and foreground.
  // JS timers pause in the background, so the detach is checked through the platform view's
  // log lines (RnrSurface tag) while backgrounded and through the counters after foreground.
  const before = latestStats().A;
  const surfaceLog = () => adb('logcat', '-d', '-s', 'RnrSurface:*').split('\n').filter(l => l.includes('surface '));
  const logBefore = surfaceLog().length;
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  const bgLines = await waitFor(() => { const l = surfaceLog().slice(logBefore); return l.some(x => / detached #/.test(x)) && l; }, 10000, 'detach log line in background').catch(e => [String(e)]);
  check('background: window detached (platform log, while backgrounded)', bgLines.some(x => / detached #/.test(x)), bgLines);
  await sleep(1500);
  start();
  await sleep(1000);
  notePid();
  const fg = await waitFor(() => { const s = latestStats()?.A; return s && s.state === 'attached' && s.attaches > before.attaches && s.framesPresented > before.framesPresented + 10 && s; }, 15000, 'presenting after foreground').catch(e => ({error: String(e)}));
  check('foreground: re-attached and presenting; counters show the background detach', fg.state === 'attached' && fg.detaches > before.detaches, {before: {attaches: before.attaches, detaches: before.detaches}, after: fg, log: surfaceLog().slice(logBefore)});
  check('no detach timeouts or surface errors', fg.detachTimeouts === 0 && fg.surfaceErrors === 0, fg);
  screenshot('foreground');

  // Rotation.
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '1');
  const rot = await waitFor(() => { const s = latestStats()?.A; return s && s.state === 'attached' && s.surfaceWidth > fg.surfaceWidth && s.framesPresented > fg.framesPresented + 10 && s; }, 15000, 'rotated presenting').catch(e => ({error: String(e)}));
  check('rotation: presenting at the wider size', rot.surfaceWidth > fg.surfaceWidth, {before: `${fg.surfaceWidth}x${fg.surfaceHeight}`, after: rot});
  screenshot('rotated');
  adb('shell', 'settings', 'put', 'system', 'user_rotation', rotation.user === 'null' ? '0' : rotation.user);
  await sleep(1500);

  // Process restart.
  adb('shell', 'am', 'force-stop', PACKAGE);
  writeFileSync(path.join(run, 'logcat-before-restart.txt'), relevantLog());
  adb('logcat', '-b', 'all', '-c');
  start();
  await sleep(1000);
  notePid();
  const restarted = await waitFor(() => logLines('RNR_SMOKE')[0], 120000, 'RNR_SMOKE after restart').catch(e => ({ok: false, error: String(e)}));
  check('process restart: lifecycle sequence passes again', restarted.ok, restarted.checks?.filter(c => !c.ok) ?? restarted.error);
} catch (error) {
  check('run completed', false, String(error));
} finally {
  try { adb('shell', 'settings', 'put', 'system', 'user_rotation', rotation.user === 'null' ? '0' : rotation.user); } catch {}
  try { adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', rotation.auto === 'null' ? '1' : rotation.auto); } catch {}
  try { writeFileSync(path.join(run, 'logcat.txt'), relevantLog()); } catch {}
  const crashes = (() => { try { return adb('logcat', '-d', '-b', 'crash'); } catch { return ''; } })();
  if (crashes.includes(PACKAGE)) check('no crash', false, crashes);
  try { adb('uninstall', PACKAGE); } catch {}
}
result.ok = result.checks.every(c => c.ok);
writeFileSync(path.join(run, 'surface-device.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`${result.ok ? 'PASS' : 'FAIL'} ${run}`);
for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`);
process.exit(result.ok ? 0 : 1);
