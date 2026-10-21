// The iOS surface lifecycle in the simulator with the harness app (RNRS_IOS_FIXTURE=surface-s3). Runs on the Mac:
//   node scripts/consumer/ios-s3-sim-test.mjs --app <HelloWorld.app> --device <simulator udid>
//     --bundle-id <id> --commit <sha> --out <result.json> [--mode full|probe]
// The app polls this script's HTTP server (127.0.0.1:8765; the simulator shares the host's
// network) for commands and posts reports. The app is launched with CA_DEBUG_TRANSACTIONS=1
// and Main Thread Checker injected (whether it actually loaded is recorded from vmmap, not
// assumed). Unified-log lines of the app process are streamed to a file.
// The read-back and retirement gates read rnrs_surface info logs: build the app with
// RNRS_APP_LOGGING='{"filter":"warn,rnrs_surface=info,rnrs_vello2d=info","iosPrivacy":"public"}'
// (ios-app.sh), or those gates fail for lack of lines.
//
// Sequence (--mode full): cold launch; baseline; 20 background/foreground cycles (Settings to the
// foreground and back, the app process kept); 2-minute session; resize twice; unmount and
// remount (a new surface key); React Native reloads (--reloads, default 5) with the surface attached. Memory
// (phys_footprint, `footprint`) at the start, after the cycles and after the session. All
// thresholds are the design's empirical gates, not guarantees.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

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
// --mode full (default): the sequence above.
// --mode probe: cold launch; one resize; one background/foreground
//   with the PID unchanged; one unmount/remount (the unmount closes a presenting renderer: the
//   teardown, retiring when an operation is in flight at the revoke); presents after each step;
//   the UIKit, Core Animation and read-back log gates.
const MODE = process.argv.includes('--mode')
  ? process.argv[process.argv.indexOf('--mode') + 1]
  : 'full';
if (!['full', 'probe'].includes(MODE)) throw new Error(`unknown --mode ${MODE}`);
// --reloads N: the full sequence's reload count (default 5).
const FULL_RELOADS = process.argv.includes('--reloads')
  ? Number(process.argv[process.argv.indexOf('--reloads') + 1])
  : 5;
if (!(FULL_RELOADS >= 1)) throw new Error('--reloads must be a positive number');
const MTC = '/Applications/Xcode.app/Contents/Developer/usr/lib/libMainThreadChecker.dylib';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: 120000, ...opts }).trim();
const simctl = (...args) => sh('xcrun', ['simctl', ...args]);

// --- HTTP server: commands out, reports in.
const queue = [];
let nextId = 0;
const reports = new Map();
const events = [];
const latest = new Map(); // runtime -> last periodic snapshot
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/next') {
    const seq = Number(url.searchParams.get('seq') ?? 0);
    const cmd = queue.find((c) => c.id >= seq);
    if (!cmd) {
      res.writeHead(204).end();
      return;
    }
    // Served once: a runtime started by a reload polls from seq 0 and must not see the reload
    // command again (it would reload in a loop).
    queue.splice(queue.indexOf(cmd), 1);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(cmd));
    return;
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
    data.hostMs = Date.now();
    if (url.pathname === '/report') reports.set(data.id, data);
    else if (url.pathname === '/event') events.push(data);
    else if (url.pathname === '/stats') latest.set(data.runtime, data);
    res.writeHead(204).end();
  });
});
await new Promise((r) => server.listen(8765, '127.0.0.1', r));

async function command(cmd, timeoutMs = 15000) {
  const id = nextId++;
  queue.splice(0, queue.length, { id, cmd }); // one pending command; ids grow across runtimes
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (reports.has(id)) return reports.get(id);
    await sleep(100);
  }
  throw new Error(`no report for ${cmd} (#${id})`);
}
const lastSnapshot = () =>
  [...latest.values()].sort((a, b) => b.hostMs - a.hostMs)[0]?.snapshot ?? null;
async function waitFor(pred, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
const presenting = async (since, what, timeoutMs = 20000) => {
  const base = since ?? 0;
  return waitFor(
    () => {
      const s = lastSnapshot();
      return s?.renderer?.state === 'attached' && s.renderer.framesPresented > base + 10 && s;
    },
    timeoutMs,
    what,
  );
};
const pidOf = () => {
  const out = sh('xcrun', ['simctl', 'spawn', DEVICE, 'launchctl', 'list']);
  const line = out.split('\n').find((l) => l.includes(BUNDLE));
  return line ? Number(line.trim().split(/\s+/)[0]) : null;
};
const footprint = (pid) => {
  try {
    const out = sh('footprint', [String(pid)]);
    const m =
      out.match(/phys_footprint:\s*([\d.]+\s*\w+)/) ?? out.match(/Footprint:\s*([\d.]+\s*\w+)/);
    return { raw: out.split('\n').slice(0, 6).join('\n'), physFootprint: m ? m[1] : 'unavailable' };
  } catch (e) {
    return { physFootprint: 'unavailable', error: String(e).slice(0, 200) };
  }
};

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const result = {
  mode: MODE,
  appBundleSha256: sha256(`${APP}/main.jsbundle`),
  commit: COMMIT,
  app: APP,
  appBinarySha256: sha256(`${APP}/HelloWorld`),
  runner: 'scripts/consumer/ios-s3-sim-test.mjs',
  runnerSha256: sha256(fileURLToPath(import.meta.url)),
  device: DEVICE,
  bundleId: BUNDLE,
  startedAt: new Date().toISOString(),
  steps: [],
  checks: [],
  // Items the run could not evidence: listed separately, never counted as passes.
  notEvidenced: [],
  // Recorded, not checked (weak or contract-limited evidence).
  notes: [],
  footprint: {},
  deviceRun: 'not run (no free provisioning slot; no app uninstalled)',
};
const notEvidenced = (name, detail) => result.notEvidenced.push({ name, detail });
const step = (name, data) => result.steps.push({ name, at: Date.now(), ...data });
const check = (name, ok, detail) => result.checks.push({ name, ok: !!ok, detail });

// --- Logs: the app's unified-log lines and its console (stderr: CA debug, Main Thread Checker).
const logFile = OUT.replace(/\.json$/, '.log.ndjson');
const consoleFile = OUT.replace(/\.json$/, '.console.txt');
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
logStream.stdout.pipe(createWriteStream(logFile));
// Main Thread Checker is injected only while it does not break the launch (the dylib is the
// macOS one; whether it loaded is checked with vmmap, never assumed).
let injectMtc = true;
const launchEnv = () => ({
  ...process.env,
  SIMCTL_CHILD_CA_DEBUG_TRANSACTIONS: '1',
  ...(injectMtc
    ? { SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: MTC, SIMCTL_CHILD_MTC_CRASH_ON_REPORT: '0' }
    : {}),
});
let consoleOut = null;
/** Brings the running app to the foreground without a console, so the run's single console
 *  process (and with it the app) is never killed. */
function foreground() {
  simctl('launch', DEVICE, BUNDLE);
}
function launch(terminate) {
  consoleOut?.kill();
  const args = [
    'simctl',
    'launch',
    '--console-pty',
    ...(terminate ? ['--terminate-running-process'] : []),
    DEVICE,
    BUNDLE,
  ];
  consoleOut = spawn('xcrun', args, { env: launchEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const w = createWriteStream(consoleFile, { flags: 'a' });
  consoleOut.stdout.pipe(w);
  consoleOut.stderr.pipe(w);
}

/** Cold launch until `ready` holds; once more without the Main Thread Checker insert if the
 *  first launch never got ready. */
async function coldLaunch(ready, what) {
  try {
    simctl('terminate', DEVICE, BUNDLE);
  } catch {
    /* not running */
  }
  await sleep(1000);
  launch(true);
  let first = await waitFor(ready, 90000, what).catch((e) => ({ error: String(e) }));
  if (first.error && injectMtc) {
    result.mtcLaunchFallback = `launch with the Main Thread Checker insert did not get ready (${first.error}); relaunched without it`;
    injectMtc = false;
    try {
      simctl('terminate', DEVICE, BUNDLE);
    } catch {
      /* not running */
    }
    await sleep(1000);
    launch(true);
    first = await waitFor(ready, 90000, `${what} (without the insert)`);
  } else if (first.error) {
    throw new Error(first.error);
  }
  const pid = await waitFor(() => pidOf(), 10000, 'pid');
  return { pid, first };
}
/** Ready: the surface attached and presenting. */
const ready = () => {
  const s = lastSnapshot();
  return s?.renderer?.state === 'attached' && s.renderer.framesPresented > 10 && s;
};
try {
  // Install the app under test (as the touch and Bevy runners do), then cold launch.
  simctl('install', DEVICE, APP);
  const { pid, first } = await coldLaunch(ready, 'ready after cold launch');
  step('cold launch', { pid, snapshot: first });
  let vm = '';
  try {
    vm = sh('vmmap', [String(pid)], { maxBuffer: 1 << 26 });
  } catch (e) {
    vm = String(e);
  }
  result.mainThreadChecker = injectMtc && /libMainThreadChecker/.test(vm) ? 'loaded' : 'not loaded';
  result.footprint.start = footprint(pid);
  if (MODE === 'full') {
    await sleep(10000);
    step('baseline', { snapshot: lastSnapshot() });

    // 20 background/foreground cycles.
    const cycles = [];
    // JS timers are suspended in the background, so evidence comes from the JS lifecycle's own
    // pause/resume transitions (framesSubmitted recorded at each) and from the native log.
    for (let i = 0; i < 20; i++) {
      const before = lastSnapshot();
      const pidBefore = pidOf();
      simctl('launch', DEVICE, 'com.apple.Preferences');
      await sleep(3000);
      foreground(); // a plain launch activates the running app; the console process stays
      const fg = await presenting(
        before?.renderer?.framesPresented ?? 0,
        `foreground ${i}`,
        20000,
      ).catch((e) => ({ error: String(e) }));
      const pidAfter = pidOf();
      const ts = fg.lifecycle?.transitions ?? [];
      const r = ts.map((t) => t.kind).lastIndexOf('resume');
      const pause = r > 0 ? ts[r - 1] : null,
        resume = r >= 0 ? ts[r] : null;
      cycles.push({
        i,
        resumed: !fg.error,
        error: fg.error,
        pidBefore,
        pidAfter,
        pausesDelta: (fg.lifecycle?.pauses ?? 0) - (before?.lifecycle?.pauses ?? 0),
        resumesDelta: (fg.lifecycle?.resumes ?? 0) - (before?.lifecycle?.resumes ?? 0),
        pause,
        resume,
        attachesBefore: before?.renderer?.attaches,
        attachesAfter: fg.renderer?.attaches,
        renderersOpen: fg.renderer?.renderersOpen,
        renderThreadsAlive: fg.renderer?.renderThreadsAlive,
      });
    }
    step('background cycles', { cycles });
    check(
      '20 background/foreground cycles: each resumed presenting',
      cycles.every((c) => c.resumed),
      cycles.filter((c) => !c.resumed),
    );
    check(
      'same process across every cycle (no cold relaunch)',
      cycles.every(
        (c) => c.pidBefore && c.pidBefore === c.pidAfter && c.pidBefore === cycles[0].pidBefore,
      ),
      cycles.map((c) => [c.pidBefore, c.pidAfter]),
    );
    check(
      'one pause and one resume per cycle',
      cycles.every((c) => c.pausesDelta === 1 && c.resumesDelta === 1),
      cycles.map((c) => [c.pausesDelta, c.resumesDelta]),
    );
    // Weak: JS is suspended in the background and cannot submit anyway. Native evidence of no
    // presentation between revoke and re-attach would need a counter at revoke/attach (not in
    // this build); that property rests on the admission design and its host tests.
    result.notes.push({
      name: 'framesSubmitted equal at each pause and resume (JS consistency only, weak; native no-present rests on admission host tests)',
      consistent: cycles.every(
        (c) =>
          c.pause?.kind === 'pause' &&
          c.resume &&
          c.pause.framesSubmitted === c.resume.framesSubmitted,
      ),
      values: cycles.map((c) => [c.pause?.framesSubmitted, c.resume?.framesSubmitted]),
    });
    result.notes.push({
      name: 'GPU work at backgrounding',
      detail:
        'not claimed complete: operations admitted before a revocation may still finish (contract)',
    });
    check(
      're-attached after each cycle (attach count grows)',
      cycles.every((c) => c.attachesAfter > c.attachesBefore),
      cycles.map((c) => [c.attachesBefore, c.attachesAfter]),
    );
    result.footprint.afterCycles = footprint(pidOf());

    // 2-minute session.
    const s0 = lastSnapshot();
    await sleep(120000);
    const s1 = lastSnapshot();
    step('2-minute session', {
      presentedDelta: s1?.renderer?.framesPresented - s0?.renderer?.framesPresented,
      snapshot: s1,
    });
    result.footprint.afterSession = footprint(pidOf());

    // Resize twice (layout height toggles).
    for (const which of ['shrink', 'restore']) {
      const before = lastSnapshot();
      await command('resize');
      await sleep(2500);
      const after = lastSnapshot();
      step(`resize ${which}`, {
        before: before?.renderer && [
          before.renderer.surfaceWidth,
          before.renderer.surfaceHeight,
          before.renderer.resizes,
        ],
        after: after?.renderer && [
          after.renderer.surfaceWidth,
          after.renderer.surfaceHeight,
          after.renderer.resizes,
          after.renderer.state,
        ],
      });
      check(
        `resize (${which}): the surface extent changed and it is still attached`,
        after?.renderer?.surfaceHeight !== before?.renderer?.surfaceHeight &&
          after?.renderer?.state === 'attached',
        { before: before?.renderer?.surfaceHeight, after: after?.renderer?.surfaceHeight },
      );
    }

    // Unmount and remount with a new key.
    const keyBefore = lastSnapshot()?.surfaceKey;
    await command('unmount');
    await sleep(2500);
    await command('remount');
    const remounted = await waitFor(
      () => {
        const s = lastSnapshot();
        return (
          s?.surfaceKey !== keyBefore &&
          s?.renderer?.state === 'attached' &&
          s.renderer.framesPresented > 10 &&
          s
        );
      },
      20000,
      'remounted presenting',
    ).catch((e) => ({ error: String(e) }));
    step('unmount/remount', {
      keyBefore,
      keyAfter: remounted.surfaceKey,
      renderer: remounted.renderer,
      error: remounted.error,
    });
    check(
      'unmount and remount: a new surface key attaches and presents',
      !remounted.error,
      remounted.error ?? { keyBefore, keyAfter: remounted.surfaceKey },
    );

    // FULL_RELOADS reloads with the surface attached.
    const reloads = [];
    for (let i = 0; i < FULL_RELOADS; i++) {
      const runtimesBefore = new Set(latest.keys());
      await command('reload');
      const t0 = Date.now();
      const fresh = await waitFor(
        () => {
          const r = [...latest.entries()].find(
            ([k, v]) =>
              !runtimesBefore.has(k) &&
              v.snapshot?.renderer?.state === 'attached' &&
              v.snapshot.renderer.framesPresented > 10,
          );
          return r && r[1];
        },
        30000,
        `reload ${i}`,
      ).catch((e) => ({ error: String(e) }));
      await sleep(2000);
      const s = lastSnapshot();
      reloads.push({
        i,
        ms: Date.now() - t0,
        error: fresh.error,
        renderersOpen: s?.renderer?.renderersOpen,
        renderThreadsAlive: s?.renderer?.renderThreadsAlive,
        owned: s?.renderer?.ownedByRuntime,
      });
    }
    step('reloads', { reloads });
    check(
      `${FULL_RELOADS} reloads with the surface attached: each new runtime attaches and presents`,
      reloads.every((r) => !r.error),
      reloads.filter((r) => r.error),
    );
    check(
      'render threads back to the open count within 2 s after each reload',
      reloads.every((r) => r.renderThreadsAlive === r.renderersOpen),
      reloads.map((r) => [r.renderersOpen, r.renderThreadsAlive]),
    );
    check(
      'no renderer-create failures',
      !events.some((e) => e.kind === 'renderer-create-failed'),
      events.filter((e) => e.kind === 'renderer-create-failed'),
    );
  }

  if (MODE === 'probe') {
    // B: one of each lifecycle step, presenting after each.
    await sleep(3000);
    const r0 = lastSnapshot();
    await command('resize');
    const resized = await waitFor(
      () => {
        const s = lastSnapshot();
        return (
          s?.renderer?.surfaceHeight !== r0?.renderer?.surfaceHeight &&
          s?.renderer?.state === 'attached' &&
          s.renderer.framesPresented > (r0?.renderer?.framesPresented ?? 0) + 10 &&
          s
        );
      },
      20000,
      'presenting after the resize',
    ).catch((e) => ({ error: String(e) }));
    step('resize', { before: r0?.renderer, after: resized.renderer, error: resized.error });
    check(
      'resize: the extent changed and it presents after',
      !resized.error,
      resized.error ?? {
        before: r0?.renderer?.surfaceHeight,
        after: resized.renderer.surfaceHeight,
      },
    );

    const b0 = lastSnapshot();
    const pidBefore = pidOf();
    simctl('launch', DEVICE, 'com.apple.Preferences');
    await sleep(3000);
    foreground();
    const fg = await presenting(
      b0?.renderer?.framesPresented ?? 0,
      'presenting after foreground',
      20000,
    ).catch((e) => ({ error: String(e) }));
    const pidAfter = pidOf();
    step('background/foreground', {
      pidBefore,
      pidAfter,
      before: b0?.renderer,
      after: fg.renderer,
      error: fg.error,
    });
    check(
      'background/foreground: the same process presents again',
      !fg.error && pidBefore && pidBefore === pidAfter,
      { error: fg.error, pidBefore, pidAfter },
    );

    const keyBefore = lastSnapshot()?.surfaceKey;
    await command('unmount');
    await sleep(2500);
    await command('remount');
    const re = await waitFor(
      () => {
        const s = lastSnapshot();
        return (
          s?.surfaceKey !== keyBefore &&
          s?.renderer?.state === 'attached' &&
          s.renderer.framesPresented > 10 &&
          s
        );
      },
      20000,
      'remounted presenting',
    ).catch((e) => ({ error: String(e) }));
    await sleep(2000);
    const after = lastSnapshot();
    step('unmount/remount (teardown of a presenting renderer)', {
      keyBefore,
      keyAfter: re.surfaceKey,
      renderer: after?.renderer,
      error: re.error,
    });
    check(
      'unmount/remount: a new surface key attaches and presents',
      !re.error,
      re.error ?? { keyBefore, keyAfter: re.surfaceKey },
    );
    // The closed renderer's thread has exited once the alive count is back to the open count.
    result.probeThreadExit =
      !re.error && after?.renderer?.renderThreadsAlive === after?.renderer?.renderersOpen;
  }
} catch (error) {
  check('run completed', false, String(error));
} finally {
  await sleep(2000);
  try {
    simctl('terminate', DEVICE, BUNDLE);
  } catch {
    /* best effort */
  }
  consoleOut?.kill();
  logStream.kill();
  server.close();
}

// --- Log evidence.
const lines = readFileSync(logFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
const msgs = lines.map((l) => l.eventMessage ?? '');
const consoleText = (() => {
  try {
    return readFileSync(consoleFile, 'utf8');
  } catch {
    return '';
  }
})();
const count = (re) => msgs.filter((m) => re.test(m)).length;
const retired = msgs
  .map((m) => m.match(/window retired ([\d.]+) ms/))
  .filter(Boolean)
  .map((m) => Number(m[1]));
result.logs = {
  lines: lines.length,
  readbackYes: count(/read-back allowsNextDrawableTimeout=YES/),
  readbackNo: count(/read back NO/),
  bound: count(/rnrs-vello2d: bound /),
  acquireRefused: count(/acquire refused/),
  retiredMs: { count: retired.length, max: retired.length ? Math.max(...retired) : null },
  retireWarnings: count(/window retired .* after its asynchronous revocation/) - retired.length,
  attached: count(/RnrsSurface: surface \d+: attached/),
  revoked: count(/RnrsSurface: surface \d+: revoked/),
  inactiveSkips: count(/not attached while the app is inactive/),
  resign: count(/will resign active/),
  becomeActive: count(/did become active/),
  rendererLimit: count(/renderer limit reached|cannot start the render thread/i),
  gpuErrors: count(
    /wgpu error|Execution of the command buffer|kIOGPUCommandBuffer|insufficient permission/i,
  ),
  mainThreadChecker:
    (consoleText.match(/Main Thread Checker/g) ?? []).length + count(/Main Thread Checker/),
  uikitOffMainLayer:
    count(
      /Modifying properties of a view's layer off the main thread|_raiseExceptionForBackgroundThreadLayerPropertyModification/,
    ) +
    (
      consoleText.match(
        /Modifying properties of a view's layer off the main thread|_raiseExceptionForBackgroundThreadLayerPropertyModification/g,
      ) ?? []
    ).length,
  caTransactionWarnings:
    (consoleText.match(/CoreAnimation: (warning|[^\n]*transaction)/gi) ?? []).length +
    count(/CoreAnimation: .*(warning|uncommitted)/i),
};
check(
  'read-back YES after every configure (one per bind, none NO)',
  result.logs.readbackNo === 0 &&
    result.logs.readbackYes >= result.logs.bound &&
    result.logs.bound > 0,
  result.logs,
);
if (MODE === 'full')
  check(
    'revoked on each will-resign-active (native log)',
    result.logs.resign >= 20 && result.logs.revoked >= 20,
    { resign: result.logs.resign, revoked: result.logs.revoked },
  );
if (MODE === 'probe')
  check(
    'revoked on the will-resign-active (native log)',
    result.logs.resign >= 1 && result.logs.revoked >= 1,
    { resign: result.logs.resign, revoked: result.logs.revoked },
  );
check(
  'longest retirement under 2 s (empirical gate), no warning above 1.5 s',
  result.logs.retiredMs.count > 0 &&
    result.logs.retiredMs.max < 2000 &&
    result.logs.retireWarnings === 0,
  result.logs.retiredMs,
);
if (MODE === 'probe') {
  const retiring = count(/revoked #\d+ \(retiring\)/);
  if (retiring > 0)
    result.notes.push({
      name: 'retiring teardowns (revoke returned while an operation was in flight)',
      retiring,
      retiredMs: result.logs.retiredMs,
    });
  else
    notEvidenced(
      'a retiring teardown',
      'every revoke released at once: no operation was in flight at a revoke in this run',
    );
}
check(
  "no UIKit off-main layer-modification messages (UIKit's own check, separate from Main Thread Checker)",
  result.logs.lines > 0 && result.logs.uikitOffMainLayer === 0,
  { count: result.logs.uikitOffMainLayer },
);
check(
  'no acquire refusals, renderer-limit errors or GPU-work errors in the log',
  result.logs.acquireRefused === 0 &&
    result.logs.rendererLimit === 0 &&
    result.logs.gpuErrors === 0,
  result.logs,
);
// Diagnostics that are missing are not zero: an empty log is not evidence.
if (result.logs.lines === 0)
  notEvidenced('unified log', 'no log lines captured: every log-based check is unevidenced');
if (result.mainThreadChecker === 'loaded')
  check(
    'no Main Thread Checker reports (checker verified loaded with vmmap)',
    result.logs.mainThreadChecker === 0,
    { reports: result.logs.mainThreadChecker },
  );
else
  notEvidenced('Main Thread Checker: not active in this run (not evidenced)', {
    vmmap: result.mainThreadChecker,
    launchFallback: result.mtcLaunchFallback ?? null,
  });
// "deleted thread with uncommitted CATransaction" can only appear when a thread exits: count the
// render-thread exits the run produced (closed renderers whose threads were gone afterwards).
// Thread exits come from the renderer stats only (renderThreadsAlive back to renderersOpen after a
// reload or an unmount/remount), never from a harness request (E1 removes the unmount-time post).
const reloadSteps = [...(result.steps.find((st) => st.name === 'reloads')?.reloads ?? [])];
const exitsEvidenced =
  reloadSteps.filter(
    (r) =>
      !r.error &&
      !r.crashed &&
      r.renderThreadsAlive !== undefined &&
      r.renderThreadsAlive === r.renderersOpen,
  ).length + (result.probeThreadExit ? 1 : 0);
result.renderThreadExits = {
  exitsEvidenced,
  rendererClosingPosts: events.filter((e) => e.kind === 'renderer-closing').length,
  note: 'a thread exit is evidenced (from stats) when renderThreadsAlive returned to renderersOpen after a reload or an unmount/remount; renderer-closing posts are recorded, not used',
};
if (exitsEvidenced > 0)
  check(
    'no Core Animation transaction warnings (with render-thread exits during the run)',
    result.logs.caTransactionWarnings === 0,
    { warnings: result.logs.caTransactionWarnings, exits: result.renderThreadExits },
  );
else
  notEvidenced(
    'Core Animation transaction warnings: no render-thread exit evidenced, so their absence is not evidence',
    { warnings: result.logs.caTransactionWarnings, exits: result.renderThreadExits },
  );
// Crash reports written during the run: names only (the reports stay on the Mac, not committed).
try {
  const dir = `${process.env.HOME}/Library/Logs/DiagnosticReports`;
  const since = Date.parse(result.startedAt);
  result.crashReports = readdirSync(dir).filter(
    (f) => f.startsWith('HelloWorld') && statSync(`${dir}/${f}`).mtimeMs >= since,
  );
} catch (e) {
  result.crashReports = { error: String(e).slice(0, 200) };
}
result.events = events;
result.ok = result.checks.every((c) => c.ok);
result.summary = {
  checksPassed: result.checks.filter((c) => c.ok).length,
  checksFailed: result.checks.filter((c) => !c.ok).length,
  notEvidenced: result.notEvidenced.length,
};
result.finishedAt = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(result, null, 1) + '\n');
console.log(`${result.ok ? 'PASS' : 'FAIL'} ${OUT}`);
for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`);
for (const n of result.notEvidenced) console.log(`N/E  ${n.name}`);
process.exit(result.ok ? 0 : 1);
