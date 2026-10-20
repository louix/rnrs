// Bounded run of the quiet view in the system Firefox with a NEW temporary profile (never the
// user's), driven over WebDriver BiDi. Steps call the view's opt-in actions (rnrActions) one at a
// time; diagnostics are sampled every second. Records Firefox stderr, the effective environment,
// crash state (process exit, minidumps) and, after a crash, the persisted phase log from a second
// launch of the same temporary profile.
// Usage: node fixtures/web-bevy/firefox-run.mjs <outDir> [steps] [url]
//   steps: comma list of wait:<s> | resize | toggleMount | sequence | shot  (default: wait:20,shot)
import {spawn} from 'node:child_process';
import {mkdirSync, readdirSync, writeFileSync, existsSync, createWriteStream} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = path.resolve(process.argv[2] ?? 'firefox-run');
const steps = (process.argv[3] ?? 'wait:20,shot').split(',');
const url = process.argv[4] ?? 'http://localhost:8780/?expect=view';
const port = 9333;
mkdirSync(out, {recursive: true});
const stamp = new Date().toISOString().replace(/[:.]/g, '');
const profile = path.join(root, '.generated/tmp', 'firefox-profile-' + stamp);
mkdirSync(profile, {recursive: true});
// Opt-in prefs for this throwaway profile only, recorded in run.json. RNR_FIREFOX_WEBGPU_PREF=1 sets
// dom.webgpu.enabled (WebGPU is not on by default in Linux release builds; gpuweb implementation
// status wiki). No blocklist or force overrides.
const prefs = process.env.RNR_FIREFOX_WEBGPU_PREF === '1' ? {'dom.webgpu.enabled': true} : {};
writeFileSync(path.join(profile, 'user.js'), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});\n`).join(''));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Keeps the runner alive while it awaits the browser (Firefox must not lose its stderr pipe).
const keepAlive = setInterval(() => {}, 1000);

// The nix shell's LD_LIBRARY_PATH (alsa-lib) breaks this Firefox; it is removed. The user's
// setup prepends $GUIX_ENVIRONMENT/lib (libvulkan); that is honoured only if set and present.
const env = {...process.env};
delete env.LD_LIBRARY_PATH;
const guix = process.env.GUIX_ENVIRONMENT;
if (guix && existsSync(path.join(guix, 'lib'))) env.LD_LIBRARY_PATH = path.join(guix, 'lib');
// Explicit substitute when GUIX_ENVIRONMENT is unset (recorded): RNR_FIREFOX_LIB_DIR=<existing dir>.
const libDir = process.env.RNR_FIREFOX_LIB_DIR;
if (!env.LD_LIBRARY_PATH && libDir) {
  if (!existsSync(libDir)) throw new Error('RNR_FIREFOX_LIB_DIR does not exist: ' + libDir);
  env.LD_LIBRARY_PATH = libDir;
}
const runtime = `/run/user/${process.getuid()}`;
const wayland = !process.env.WAYLAND_DISPLAY && existsSync(path.join(runtime, 'wayland-1')) ? 'wayland-1' : process.env.WAYLAND_DISPLAY;
if (wayland) { env.WAYLAND_DISPLAY = wayland; env.XDG_RUNTIME_DIR ??= runtime; env.MOZ_ENABLE_WAYLAND = '1'; }
const headless = !wayland && !process.env.DISPLAY;
const record = {url, steps, profile, optInPrefs: prefs, mode: headless ? 'headless' : 'headed (Wayland ' + wayland + ')',
  environment: {LD_LIBRARY_PATH: env.LD_LIBRARY_PATH ?? null, GUIX_ENVIRONMENT: guix ?? null, RNR_FIREFOX_LIB_DIR: libDir ?? null, WAYLAND_DISPLAY: env.WAYLAND_DISPLAY ?? null,
    DISPLAY: env.DISPLAY ?? null, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR ?? null}, samples: [], events: []};
const note = (event, detail) => { record.events.push({t: new Date().toISOString(), event, detail}); console.log(event, detail ?? ''); };

// RNR_FIREFOX_GSC=<manifest>: run Firefox the way the user's `ff` alias does, inside their Guix
// GUI container helper (~/.scripts/gsc: --gpu shares /dev/dri and sysfs; the Wayland socket is
// shared) with the Firefox manifest and LD_LIBRARY_PATH=/lib inside the container. Unlike the
// alias, only this run's throwaway profile is shared (never ~/.mozilla or Downloads), and there
// is no audio, camera or session bus.
const gscManifest = process.env.RNR_FIREFOX_GSC;
const firefoxArgs = ['--new-instance', '--no-remote', '--profile', profile, '--remote-debugging-port', String(port),
  ...(headless ? ['--headless'] : []), 'about:blank'];
const command = gscManifest
  ? ['gsc', '--gpu', '--pipewire', '--network', '--no-cwd', `--share=${profile}`, `--manifest=${gscManifest}`, '--', 'env', 'LD_LIBRARY_PATH=/lib', 'firefox', ...firefoxArgs]
  : ['firefox', ...firefoxArgs];
record.command = command;

function launch(label) {
  const stderr = createWriteStream(path.join(out, `firefox-${label}.stderr.log`));
  const firefox = spawn(command[0], command.slice(1), {env, stdio: ['ignore', 'pipe', 'pipe']});
  firefox.stdout.pipe(stderr); firefox.stderr.pipe(stderr);
  const exited = new Promise(resolve => firefox.on('exit', (code, signal) => resolve({code, signal})));
  return {firefox, exited};
}

async function bidi() {
  for (let i = 0; i < 100; i++) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      let id = 0; const waiting = new Map();
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
      // A dropped socket fails every pending command instead of leaving it unsettled.
      const closed = new Promise(resolve => { ws.onclose = () => { for (const [, reply] of waiting) reply({type: "error", error: "socket closed", message: "BiDi connection closed"}); waiting.clear(); resolve(); }; });
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const n = ++id; waiting.set(n, m => m.type === 'error' ? reject(new Error(m.error + ': ' + m.message)) : resolve(m.result));
        ws.send(JSON.stringify({id: n, method, params}));
      });
      return {ws, send, closed};
    } catch { await sleep(300); }
  }
  throw new Error('no WebDriver BiDi endpoint');
}

async function session(label, action) {
  const {firefox, exited} = launch(label);
  let state = 'running';
  exited.then(r => { state = 'exited'; note(`${label}: firefox exited`, r); });
  try {
    const {ws, send} = await bidi();
    await send('session.new', {capabilities: {}});
    const tree = await send('browsingContext.getTree', {});
    const context = tree.contexts[0].context;
    const evaluate = async expression => {
      const r = await send('script.evaluate', {expression, target: {context}, awaitPromise: true});
      return r.type === 'success' ? r.result.value : {exception: r.exceptionDetails?.text};
    };
    await action({send, context, evaluate, alive: () => state === 'running'});
    if (state === 'running') { try { await send('session.end'); } catch {} ws.close(); }
  } catch (error) { note(`${label}: driver error`, String(error)); }
  if (state === 'running') { firefox.kill('SIGTERM'); }
  record[label + 'Exit'] = await Promise.race([exited, sleep(10_000).then(() => { firefox.kill('SIGKILL'); return 'killed'; })]);
}

await session('run', async ({send, context, evaluate, alive}) => {
  await send('browsingContext.navigate', {context, url, wait: 'complete'});
  note('navigated', url);
  const sample = async () => {
    const d = await evaluate('globalThis.rnrDiagnostics ? rnrDiagnostics() : null');
    if (typeof d === 'string') {
      const j = JSON.parse(d);
      record.samples.push({at: j.at, stats: j.stats, bevy: j.bevy, hostErrors: j.hostErrors.length, preferredCanvasFormat: j.preferredCanvasFormat});
      record.last = j;
    }
  };
  for (const step of steps) {
    if (!alive()) break;
    const [name, arg] = step.split(':');
    note('step', step);
    try {
      if (name === 'wait') { for (let i = 0; i < Number(arg) && alive(); i++) { await sleep(1000); await sample(); } }
      else if (name === 'shot') {
        const shot = await send('browsingContext.captureScreenshot', {context});
        const file = path.join(out, `screenshot-${record.events.length}.png`);
        writeFileSync(file, Buffer.from(shot.data, 'base64')); note('screenshot', path.basename(file));
      } else { await evaluate(`rnrActions.${name}()`); await sample(); }
    } catch (error) { note('step failed', `${step}: ${error}`); if (!alive()) break; }
  }
});
const dumps = path.join(profile, 'minidumps');
record.minidumps = existsSync(dumps) ? readdirSync(dumps) : [];
if (record.runExit?.code !== 0 && record.runExit?.signal !== 'SIGTERM' || record.minidumps.length) {
  // Crash: reopen the same temporary profile and read the persisted log of the crashed session.
  await session('after-crash', async ({send, context, evaluate}) => {
    await send('browsingContext.navigate', {context, url: url.replace(/\?.*/, '') + '?expect=log', wait: 'complete'});
    record.persistedLog = await evaluate("localStorage.getItem('rnr-web-bevy-log')");
  });
}
writeFileSync(path.join(out, 'run.json'), JSON.stringify(record, null, 2));
console.log('wrote', path.join(out, 'run.json'));
clearInterval(keepAlive);
