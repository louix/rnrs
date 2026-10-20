// C1 stage S3 (docs/research/ios-surface-c1-design.md): the iOS surface lifecycle in the
// simulator with the harness app (RNR_IOS_FIXTURE=surface-s3). Runs on the Mac:
//   node scripts/consumer/ios-s3-sim-test.mjs --app <HelloWorld.app> --device <simulator udid>
//     --bundle-id <id> --commit <sha> --out <result.json> [--mode <mode>] [--variant <bundle variant>]
// The app polls this script's HTTP server (127.0.0.1:8765; the simulator shares the host's
// network) for commands and posts reports. The app is launched with CA_DEBUG_TRANSACTIONS=1
// and Main Thread Checker injected (whether it actually loaded is recorded from vmmap, not
// assumed). Unified-log lines of the app process are streamed to a file.
// The read-back and retirement gates read rnr_surface info logs: build the app with
// RNR_APP_LOGGING='{"filter":"warn,rnr_surface=info,rnr_vello2d=info","iosPrivacy":"public"}'
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
// --mode probe (run 3 B, the sublayer repro): cold launch; one resize; one background/foreground
//   with the PID unchanged; one unmount/remount (the unmount closes a presenting renderer: the
//   teardown, retiring when an operation is in flight at the revoke); presents after each step;
//   the UIKit, Core Animation and read-back log gates.
// --mode control-http (run 3 D1/D3/D4; bundles control-hook-http, control-quiesced-http,
//   control-delayed-first-fetch): no surface; 10 reloads through the RnrRuntime hook, commanded
//   over the HTTP transport. With --variant s3* (the S3 harness bundle and its E variants:
//   s3-instrumented, s3-no-unmount-post) it is the matched repro: the same 10 reloads, each only
//   while the current runtime presents.
// --mode control-surface-nofetch (run 3 D2): the app reloads itself after presenting; the driver
//   reads its console.log lines from the unified log and stops after 10 reloads.
// Controls: a crash (the process gone or replaced, or no new runtime within 30 s) is recorded with
// its reload index, the app is cold-launched again and the remaining reloads run; any crash, even
// 1 in 10, fails the control, and the rate is stated. --variant names the JS bundle; the
// provenance.json next to the app (scripts/consumer/ios-bundle-variant.sh) is recorded and checked.
const MODE = process.argv.includes('--mode')
  ? process.argv[process.argv.indexOf('--mode') + 1]
  : 'full';
if (!['full', 'probe', 'control-http', 'control-surface-nofetch'].includes(MODE))
  throw new Error(`unknown --mode ${MODE}`);
const VARIANT = process.argv.includes('--variant')
  ? process.argv[process.argv.indexOf('--variant') + 1]
  : 's3';
const CONTROL_RELOADS = 10;
// --reloads N: the full sequence's reload count (default 5; run 3's full S3 uses 10, matching D).
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
  variant: VARIANT,
  appBundleSha256: sha256(`${APP}/main.jsbundle`),
  provenance: (() => {
    try {
      return JSON.parse(readFileSync(`${APP}/../provenance.json`, 'utf8'));
    } catch {
      return null;
    }
  })(),
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
// Control 2's console.log lines, parsed as they arrive (with the logging process).
const d2 = { starts: [], reloads: [] };
let logTail = '';
logStream.stdout.on('data', (chunk) => {
  const parts = (logTail + chunk).split('\n');
  logTail = parts.pop();
  for (const l of parts) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    const msg = e.eventMessage ?? '';
    const s = msg.match(/RNR-D2 start runtime=(\S+)/);
    if (s) d2.starts.push({ runtime: s[1], pid: e.processID });
    const r = msg.match(
      /RNR-D2 reload runtime=(\S+) state=(\S+) framesPresented=(\d+) surfaceKey=(\S+)/,
    );
    if (r)
      d2.reloads.push({
        runtime: r[1],
        state: r[2],
        framesPresented: Number(r[3]),
        surfaceKey: r[4],
        pid: e.processID,
      });
  }
});
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
const runtimeStarts = () => events.filter((e) => e.kind === 'runtime-start');
/** What "ready" means for the mode: a new runtime (controls) or presenting (surface modes). */
function readyFor() {
  if (MODE === 'control-http') {
    const n = runtimeStarts().length;
    return () => runtimeStarts().length > n && runtimeStarts().at(-1);
  }
  if (MODE === 'control-surface-nofetch') {
    const n = d2.starts.length;
    return () => d2.starts.length > n && d2.starts.at(-1);
  }
  return () => {
    const s = lastSnapshot();
    return s?.renderer?.state === 'attached' && s.renderer.framesPresented > 10 && s;
  };
}
function recordControl(reloads) {
  const crashes = reloads.filter((r) => r.crashed);
  result.control = {
    variant: VARIANT,
    reloads: reloads.length,
    crashIndices: crashes.map((r) => r.i),
    crashRate: `${crashes.length}/${reloads.length}`,
  };
  step('control reloads', { reloads });
  check(
    `control ${VARIANT}: no crash in ${CONTROL_RELOADS} reloads (any crash, even 1, counts as crashing)`,
    reloads.length === CONTROL_RELOADS && crashes.length === 0,
    result.control,
  );
}
try {
  if (result.provenance) {
    check(
      "the app's bundle is the recorded variant (provenance.json)",
      result.provenance.variant === VARIANT &&
        result.provenance.bundleSha256 === result.appBundleSha256 &&
        result.provenance.sourceCommit === COMMIT,
      {
        variant: [VARIANT, result.provenance.variant],
        bundle: [result.appBundleSha256, result.provenance.bundleSha256],
        commit: [COMMIT, result.provenance.sourceCommit],
      },
    );
  } else if (VARIANT !== 's3') {
    check('a swapped bundle has its provenance.json', false, `no provenance.json next to ${APP}`);
  }
  // Install the app under test (as the touch and Bevy runners do), then cold launch.
  simctl('install', DEVICE, APP);
  const { pid, first } = await coldLaunch(readyFor(), 'ready after cold launch');
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

  if (MODE === 'control-http') {
    const reloads = [];
    let pidNow = pid;
    for (let i = 0; i < CONTROL_RELOADS; i++) {
      const n = runtimeStarts().length;
      let crash = null,
        report = null,
        fresh = null,
        presentedBefore = null;
      if (VARIANT.startsWith('s3')) {
        // The matched repro (the S3 harness bundle): reload only while this runtime presents.
        const current = runtimeStarts().at(-1)?.runtime;
        const s = await waitFor(
          () => {
            const v = latest.get(current)?.snapshot;
            return v?.renderer?.state === 'attached' && v.renderer.framesPresented > 10 && v;
          },
          30000,
          `presenting before reload ${i}`,
        ).catch((e) => ({ error: String(e) }));
        if (s.error) crash = s.error;
        else presentedBefore = s.renderer.framesPresented;
      }
      if (!crash)
        try {
          report = await command('reload');
        } catch (e) {
          crash = `no reload report: ${e}`;
        }
      if (!crash) {
        fresh = await waitFor(
          () => runtimeStarts().length > n && runtimeStarts().at(-1),
          30000,
          `a new runtime after reload ${i}`,
        ).catch((e) => ({ error: String(e) }));
        if (fresh.error) crash = fresh.error;
      }
      if (!crash) {
        await sleep(3000);
        const p = pidOf();
        if (p !== pidNow) crash = `process ${pidNow} -> ${p ?? 'gone'}`;
      }
      // s3* (a surface): the new runtime's renderer stats 3 s after it started; a thread exit is
      // evidenced when renderThreadsAlive is back to renderersOpen (stats only, no harness post).
      const sample =
        !crash && VARIANT.startsWith('s3') ? (latest.get(fresh.runtime) ?? null) : null;
      const after = sample?.snapshot?.renderer ?? null;
      // How long after the new runtime started its sampled stats were taken (host clock), ~3 s.
      const sampleDelayMs = sample ? sample.hostMs - fresh.hostMs : null;
      reloads.push({
        i,
        crashed: !!crash,
        crash,
        presentedBefore,
        quiesce: report?.quiesce ?? null,
        runtime: fresh?.runtime ?? null,
        pid: pidOf(),
        ...(after
          ? {
              sampleDelayMs,
              stateAfter: after.state,
              presentedAfter: after.framesPresented,
              renderersOpen: after.renderersOpen,
              renderThreadsAlive: after.renderThreadsAlive,
            }
          : {}),
      });
      if (crash) {
        await sleep(3000);
        pidNow = (await coldLaunch(readyFor(), `ready after the crash at reload ${i}`)).pid;
      }
    }
    recordControl(reloads);
    if (VARIANT.startsWith('s3')) {
      const ok = reloads.filter((r) => !r.crashed);
      check(
        's3*: after each completed reload the new runtime is attached, presenting, and its render threads are back to the open count',
        ok.length > 0 &&
          ok.every(
            (r) =>
              r.stateAfter === 'attached' &&
              r.presentedAfter > 0 &&
              r.renderThreadsAlive === r.renderersOpen,
          ),
        ok.map((r) => [r.i, r.stateAfter, r.presentedAfter, r.renderersOpen, r.renderThreadsAlive]),
      );
    }
  }

  if (MODE === 'control-surface-nofetch') {
    const reloads = [];
    let pidNow = pid;
    for (let i = 0; i < CONTROL_RELOADS; i++) {
      const nReload = d2.reloads.length,
        nStart = d2.starts.length;
      let crash = null,
        fresh = null;
      const line = await waitFor(
        () => d2.reloads.length > nReload && d2.reloads[nReload],
        30000,
        `the reload line ${i}`,
      ).catch((e) => ({ error: String(e) }));
      if (line.error) crash = line.error;
      if (!crash) {
        fresh = await waitFor(
          () => d2.starts.length > nStart && d2.starts.at(-1),
          30000,
          `a new runtime after reload ${i}`,
        ).catch((e) => ({ error: String(e) }));
        if (fresh.error) crash = fresh.error;
      }
      if (!crash && i === CONTROL_RELOADS - 1) await sleep(3000);
      const p = pidOf();
      if (!crash && p !== pidNow) crash = `process ${pidNow} -> ${p ?? 'gone'}`;
      reloads.push({
        i,
        crashed: !!crash,
        crash,
        runtime: line.runtime ?? null,
        state: line.state ?? null,
        framesPresented: line.framesPresented ?? null,
        linePid: line.pid ?? null,
        nextRuntime: fresh?.runtime ?? null,
        pid: p,
      });
      if (crash) {
        await sleep(3000);
        pidNow = (await coldLaunch(readyFor(), `ready after the crash at reload ${i}`)).pid;
      }
    }
    recordControl(reloads);
    // Teardown is exercised only if the surface was presenting at each reload.
    const logged = reloads.filter((r) => r.state !== null);
    check(
      'control 2: every reload was logged with the surface attached and >= 30 frames presented in that runtime',
      logged.length === CONTROL_RELOADS &&
        logged.every((r) => r.state === 'attached' && r.framesPresented >= 30),
      logged.map((r) => [r.i, r.state, r.framesPresented]),
    );
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
  bound: count(/rnr-vello2d: bound /),
  acquireRefused: count(/acquire refused/),
  retiredMs: { count: retired.length, max: retired.length ? Math.max(...retired) : null },
  retireWarnings: count(/window retired .* after its asynchronous revocation/) - retired.length,
  attached: count(/RnrSurface: surface \d+: attached/),
  revoked: count(/RnrSurface: surface \d+: revoked/),
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
// Runs with a surface: every mode except the no-surface HTTP controls (s3* variants have one).
const surfaceRun = MODE !== 'control-http' || VARIANT.startsWith('s3');
if (surfaceRun)
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
if (MODE === 'full' || MODE === 'probe' || (MODE === 'control-http' && surfaceRun))
  check(
    'longest retirement under 2 s (empirical gate), no warning above 1.5 s',
    result.logs.retiredMs.count > 0 &&
      result.logs.retiredMs.max < 2000 &&
      result.logs.retireWarnings === 0,
    result.logs.retiredMs,
  );
else if (MODE === 'control-surface-nofetch')
  result.notes.push({
    name: 'retirements (recorded, not gated in the control)',
    retiredMs: result.logs.retiredMs,
    retireWarnings: result.logs.retireWarnings,
  });
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
if (MODE === 'control-surface-nofetch') {
  // Each reload line follows a native attach logged since the previous reload line.
  const ts = (l) => l.timestamp ?? '';
  let prev = '';
  const attachedBefore = lines
    .filter((l) => /RNR-D2 reload /.test(l.eventMessage ?? ''))
    .map((rl) => {
      const ok = lines.some(
        (l) =>
          /RnrSurface: surface \d+: attached/.test(l.eventMessage ?? '') &&
          ts(l) > prev &&
          ts(l) < ts(rl),
      );
      prev = ts(rl);
      return ok;
    });
  check(
    'control 2: a native attach precedes each reload line',
    attachedBefore.length >= CONTROL_RELOADS && attachedBefore.every(Boolean),
    attachedBefore,
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
const reloadSteps = [
  ...(result.steps.find((st) => st.name === 'reloads')?.reloads ?? []),
  ...(result.steps.find((st) => st.name === 'control reloads')?.reloads ?? []),
];
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
if (!surfaceRun)
  result.notes.push({
    name: 'Core Animation transaction warnings (no surface in this control)',
    warnings: result.logs.caTransactionWarnings,
  });
else if (exitsEvidenced > 0)
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
