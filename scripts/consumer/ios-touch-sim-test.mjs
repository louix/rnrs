// iOS surface touch input in the simulator (docs/surface.md, "Touch input"): the harness app
// (RNR_IOS_FIXTURE=touch-probe: fixtures/touch-probe-ios, a GPU-free @rnrs/labs-touch-probe surface)
// gets real UIKit touches from the XCUITest runner (tools/ios-touch-uitest), and this script reads
// the probe's explicit drain over the app's HTTP command channel (127.0.0.1:8765). Runs on the Mac:
//   node scripts/consumer/ios-touch-sim-test.mjs --app <HelloWorld.app> --device <simulator udid>
//     --bundle-id <id> --commit <sha> --out <result.json> --derived <runner derived data dir>
// Sequence: cold launch; drag; overlay tap; hold cancelled by touchInput="none"; hold across a
// detach and reattach of the same surface; hold across background/foreground; two-finger pinch;
// remount (new surface). Each step drains the probe once afterwards. Nothing here calls Rust or
// fabricates touches: the runner synthesizes them through the simulator's HID path.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
};
const APP = arg('app'),
  DEVICE = arg('device'),
  BUNDLE = arg('bundle-id'),
  COMMIT = arg('commit'),
  OUT = arg('out'),
  DERIVED = arg('derived');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER = path.join(ROOT, 'tools/ios-touch-uitest/TouchUITests.xcodeproj');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: 300000, ...opts }).trim();
const simctl = (...args) => sh('xcrun', ['simctl', ...args]);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// --- HTTP command channel (one pending command; ids grow across runtimes).
const queue = [];
const reports = new Map();
const events = [];
let nextId = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/next') {
    const seq = Number(url.searchParams.get('seq') ?? 0);
    const cmd = queue.find((c) => c.id >= seq);
    if (!cmd) return void res.writeHead(204).end();
    queue.splice(queue.indexOf(cmd), 1);
    return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(cmd));
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let data = {};
    try {
      data = JSON.parse(body || '{}');
    } catch {
      /* ignore */
    }
    if (url.pathname === '/report') reports.set(data.id, data);
    else if (url.pathname === '/event') events.push(data);
    res.writeHead(204).end();
  });
});
await new Promise((r) => server.listen(8765, '127.0.0.1', r));

async function command(cmd, timeoutMs = 15000) {
  const id = nextId++;
  queue.splice(0, queue.length, { id, cmd });
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (reports.has(id)) return reports.get(id);
    await sleep(100);
  }
  throw new Error(`no report for ${cmd} (#${id})`);
}

const result = {
  commit: COMMIT,
  app: APP,
  appBinarySha256: sha256(`${APP}/HelloWorld`),
  appBundleSha256: sha256(`${APP}/main.jsbundle`),
  runner: 'scripts/consumer/ios-touch-sim-test.mjs',
  runnerSha256: sha256(fileURLToPath(import.meta.url)),
  uitestSha256: sha256(path.join(ROOT, 'tools/ios-touch-uitest/TouchUITests/TouchUITests.swift')),
  device: DEVICE,
  bundleId: BUNDLE,
  startedAt: new Date().toISOString(),
  simulator:
    simctl('list', 'devices', DEVICE)
      .split('\n')
      .find((l) => l.includes(DEVICE))
      ?.trim() ?? null,
  xcode: sh('xcodebuild', ['-version']).replace(/\n/g, ' '),
  steps: [],
  checks: [],
  notEvidenced: [],
};
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};
const step = (name, data) => {
  result.steps.push({ name, at: new Date().toISOString(), ...data });
  console.log(`step: ${name}`);
};

/** One gesture through the XCUITest runner; resolves with its exit status and log tail. */
function gesture(name, env = {}) {
  return new Promise((resolve) => {
    const vars = { RNR_BUNDLE_ID: BUNDLE, RNR_GESTURE: name, ...env };
    const childEnv = {
      ...process.env,
      ...Object.fromEntries(Object.entries(vars).map(([k, v]) => [`TEST_RUNNER_${k}`, String(v)])),
    };
    const p = spawn(
      'xcodebuild',
      [
        'test-without-building',
        '-project',
        RUNNER,
        '-scheme',
        'TouchUITests',
        '-destination',
        `id=${DEVICE}`,
        '-derivedDataPath',
        DERIVED,
        '-only-testing:TouchUITests/TouchUITests/testGesture',
      ],
      { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    p.on('close', (status) =>
      resolve({
        gesture: name,
        status,
        done: log.includes(`RNR-GESTURE-DONE ${name}`),
        tail: log
          .split('\n')
          .filter((l) => /error|fail|passed|RNR-GESTURE/i.test(l))
          .slice(-8),
      }),
    );
  });
}

const stats = async () => (await command('stats')).probe;
/** Records of `after` not in `before` (the recent ring holds the last 32; steps stay below that). */
const fresh = (before, after) =>
  after.recent.slice(Math.max(0, after.recent.length - (after.records - before.records)));
const delta = (a, b, k) => b[k] - a[k];
const fails = () => result.checks.filter((c) => !c.ok).length;

try {
  // --- Runner (the app is already built by ios-app.sh).
  sh(
    'xcodebuild',
    [
      'build-for-testing',
      '-project',
      RUNNER,
      '-scheme',
      'TouchUITests',
      '-destination',
      `id=${DEVICE}`,
      '-derivedDataPath',
      DERIVED,
    ],
    { timeout: 600000 },
  );
  step('runner built', {});

  // --- Cold launch.
  try {
    simctl('boot', DEVICE);
  } catch {
    /* already booted */
  }
  simctl('bootstatus', DEVICE, '-b');
  simctl('install', DEVICE, APP);
  simctl('launch', '--terminate-running-process', DEVICE, BUNDLE);
  const end = Date.now() + 60000;
  while (!events.some((e) => e.kind === 'ready') && Date.now() < end) await sleep(200);
  check(
    'app ready',
    events.some((e) => e.kind === 'ready'),
    events,
  );
  await sleep(1000);
  const frames = await command('frames');
  const s0 = await stats();
  step('baseline', { frames, probe: s0 });
  check(
    'attached with touch enabled and nothing queued',
    s0.state === 'attached' && s0.records === 0 && s0.scale > 0,
    s0,
  );
  const [fx, fy, fw, fh] = frames.surface;
  const FRAME = frames.surface.join(',');

  // --- Drag: down, moves, up of one new pointer at the expected physical position.
  const g1 = await gesture('drag', { RNR_FRAME: FRAME });
  const s1 = await stats();
  const r1 = fresh(s0, s1);
  step('drag', { gesture: g1, probe: s1 });
  const down1 = r1.find((r) => r.kind === 'down');
  check(
    'drag: one down, moves, one up, nothing left down',
    g1.done &&
      delta(s0, s1, 'downs') === 1 &&
      delta(s0, s1, 'moves') >= 1 &&
      delta(s0, s1, 'ups') === 1 &&
      s1.down.length === 0 &&
      s1.producerDown === 0,
    { g1, r1 },
  );
  const want = [0.4 * fw * s1.scale, 0.5 * fh * s1.scale];
  check(
    'drag: down at view-local physical pixels (within 2 pt), attachment extent and scale',
    down1 &&
      Math.abs(down1.xPx - want[0]) <= 2 * s1.scale &&
      Math.abs(down1.yPx - want[1]) <= 2 * s1.scale &&
      down1.width === s1.surfaceWidth &&
      down1.scale === s1.scale &&
      down1.attachment === s1.attachment,
    { down1, want, frame: frames.surface },
  );
  const up1 = r1.find((r) => r.kind === 'up');
  check(
    'drag: up near the drag end (within 4 pt)',
    up1 &&
      Math.abs(up1.xPx - 0.8 * fw * s1.scale) <= 4 * s1.scale &&
      Math.abs(up1.yPx - 0.8 * fh * s1.scale) <= 4 * s1.scale,
    { up1 },
  );
  check(
    'drag: event times increase',
    r1.every((r, i) => i === 0 || r.timeMs >= r1[i - 1].timeMs) && r1.length > 0,
    r1.map((r) => r.timeMs),
  );

  // --- Overlay: a tap on the Pressable above the surface reaches JS and not Rust.
  const [ox, oy, ow, oh] = frames.overlay;
  const before = await command('stats');
  const g2 = await gesture('tap', { RNR_POINT: `${ox + ow / 2},${oy + oh / 2}` });
  await sleep(500);
  const after = await command('stats');
  step('overlay tap', { gesture: g2, js: after.js, probe: after.probe });
  check(
    'overlay: JS onPress ran, nothing reached Rust',
    g2.done &&
      after.js.overlayTaps === before.js.overlayTaps + 1 &&
      after.probe.records === before.probe.records &&
      after.probe.refusedStale === before.probe.refusedStale,
    { before: before.js, after: after.js, records: [before.probe.records, after.probe.records] },
  );
  void fx;
  void fy;

  // --- Hold cancelled by the prop: touchInput="none" mid-gesture cancels; the tail is swallowed.
  const s2 = await stats();
  // The runner takes seconds to start: actions begin once the held pointer is down in Rust
  // (polled with explicit drains), then run after their delays.
  const hold = (env, actions) =>
    Promise.all([
      gesture('hold', { RNR_FRAME: FRAME, RNR_HOLD_S: 5, ...env }),
      (async () => {
        const until = Date.now() + 90000;
        while ((await stats()).producerDown < 1) {
          if (Date.now() > until) throw new Error('the held pointer never went down');
          await sleep(250);
        }
        const done = [];
        for (const [ms, act] of actions) {
          await sleep(ms);
          done.push(await act());
        }
        return done;
      })(),
    ]);
  const [g3, a3] = await hold({}, [[500, () => command('touch-off')]]);
  const s3 = await stats();
  const r3 = fresh(s2, s3);
  step('hold, touchInput none', { gesture: g3, actions: a3, probe: s3 });
  const id3 = r3.find((r) => r.kind === 'down')?.id;
  const cancel3 = r3.findIndex((r) => r.kind === 'cancel' && r.id === id3);
  check(
    'opt-out: the held pointer is canceled, nothing of it after the cancel, nothing down',
    id3 &&
      cancel3 >= 0 &&
      !r3.slice(cancel3 + 1).some((r) => r.id === id3) &&
      s3.down.length === 0 &&
      s3.producerDown === 0,
    r3,
  );
  check(
    'opt-out: the drag tail after the opt-out was not sent',
    delta(s2, s3, 'ups') === 0 && delta(s2, s3, 'refusedStale') === 0,
    { s2: [s2.ups, s2.refusedStale], s3: [s3.ups, s3.refusedStale] },
  );
  await command('touch-on');
  await sleep(300);

  // --- Hold across a detach and reattach of the same surface.
  const s4 = await stats();
  const [g4, a4] = await hold({}, [
    [500, () => command('detach')],
    [800, () => command('attach')],
  ]);
  const s4b = await stats();
  const r4 = fresh(s4, s4b);
  step('hold, detach + reattach', { gesture: g4, actions: a4, probe: s4b });
  const id4 = r4.find((r) => r.kind === 'down')?.id;
  const reset4 = r4.findIndex((r) => r.kind === 'reset' && r.reason === 'detached');
  check(
    'reattach: a detached reset ends the held pointer, which never appears again',
    id4 && reset4 >= 0 && !r4.slice(reset4 + 1).some((r) => r.id === id4) && s4b.down.length === 0,
    r4,
  );
  check(
    "reattach: a new attachment, and the old touch's tail was not a new pointer in it",
    s4b.attachment > s4.attachment && delta(s4, s4b, 'downs') === 1 && s4b.state === 'attached',
    { attachments: [s4.attachment, s4b.attachment], downs: delta(s4, s4b, 'downs') },
  );
  const g4b = await gesture('drag', { RNR_FRAME: FRAME });
  const s4c = await stats();
  const r4c = fresh(s4b, s4c);
  step('drag after reattach', { gesture: g4b, probe: s4c });
  check(
    'reattach: a new gesture gets a new id in the new attachment',
    g4b.done &&
      r4c.find((r) => r.kind === 'down')?.id > id4 &&
      r4c.every((r) => r.attachment === s4c.attachment) &&
      s4c.down.length === 0,
    r4c,
  );

  // --- Hold across background and foreground.
  const s5 = await stats();
  const [g5, a5] = await hold({}, [
    [500, () => simctl('launch', DEVICE, 'com.apple.Preferences')],
    [1500, () => simctl('launch', DEVICE, BUNDLE)],
  ]);
  await sleep(1500);
  const s5b = await stats();
  const r5 = fresh(s5, s5b);
  step('hold, background + foreground', { gesture: g5, actions: a5, probe: s5b });
  const id5 = r5.find((r) => r.kind === 'down')?.id;
  const end5 = r5.findIndex((r) => (r.id === id5 && r.kind === 'cancel') || r.kind === 'reset');
  check(
    'background: the held pointer ends (cancel or detached reset), nothing down, reattached after foreground',
    id5 &&
      end5 >= 0 &&
      !r5.slice(end5 + 1).some((r) => r.id === id5) &&
      s5b.down.length === 0 &&
      s5b.producerDown === 0 &&
      s5b.attachment > s5.attachment &&
      s5b.state === 'attached',
    { r5, attachments: [s5.attachment, s5b.attachment] },
  );

  // --- Two touches (multi-touch).
  const s6 = await stats();
  const g6 = await gesture('pinch');
  const s6b = await stats();
  const r6 = fresh(s6, s6b);
  step('pinch', { gesture: g6, probe: s6b });
  const ids6 = [...new Set(r6.filter((r) => r.kind === 'down').map((r) => r.id))];
  check(
    'pinch: two pointers down at once with distinct ids, both ended',
    g6.done &&
      ids6.length === 2 &&
      s6b.maxDown >= 2 &&
      ids6.every((id) => r6.some((r) => r.id === id && (r.kind === 'up' || r.kind === 'cancel'))) &&
      s6b.down.length === 0,
    r6,
  );

  // --- Remount: the old probe closes (closed reset), a new surface attaches and gets touches.
  const rm = await command('remount');
  await sleep(1500);
  const s7 = await stats();
  step('remount', { closed: rm.closed, probe: s7 });
  check(
    'remount: old probe closed with a closed reset, new surface attached',
    rm.closed &&
      rm.closed.state === 'closed' &&
      rm.closed.resetsClosed >= 1 &&
      s7.state === 'attached',
    {
      closed: rm.closed && { state: rm.closed.state, resetsClosed: rm.closed.resetsClosed },
      s7: s7.state,
    },
  );
  const g7 = await gesture('drag', { RNR_FRAME: FRAME });
  const s7b = await stats();
  step('drag on the new surface', { gesture: g7, probe: s7b });
  check(
    'remount: the new surface gets a whole gesture',
    g7.done && s7b.downs === 1 && s7b.ups === 1 && s7b.down.length === 0,
    s7b,
  );

  const all = [s1, s3, s4b, s4c, s5b, s6b, rm.closed, s7b];
  check(
    'no contradiction of the queue contract in any drain',
    all.every((s) => s && s.contradictions === 0),
    all.map((s) => s?.lastContradiction),
  );
  check(
    'no overflow or refused capacity',
    all.every((s) => s && s.overflows === 0 && s.refusedCapacity === 0),
    all.map((s) => s && [s.overflows, s.refusedCapacity]),
  );
  result.notEvidenced.push(
    'Touches of an owned stream are not forwarded to super after a revoke or opt-out: by code review only (the responder chain above the view has no observer in this app).',
    'Parent UIScrollView or React Native gesture handler interplay: not run.',
    'Physical iPhone: not run (no runner install on the device; simulator only).',
    'Background consumption: none exists; every record was drained by an explicit stats command.',
  );
} catch (e) {
  check('run completed', false, String(e?.stack ?? e));
} finally {
  try {
    simctl('terminate', DEVICE, BUNDLE);
  } catch {
    /* best effort */
  }
  server.close();
  result.finishedAt = new Date().toISOString();
  result.passed = fails() === 0;
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(
    `${result.checks.length - fails()}/${result.checks.length} checks passed; wrote ${OUT}`,
  );
  process.exit(result.passed ? 0 : 1);
}
