// JS-contention pilot on the paddle game. Runs an explicit
// manifest of contention runs of the consumer built with
// `FIXTURE=paddle-game FIXTURE_FILES="game.ts contention.ts" MODULES=example-vello2d PACKS=rnrs-surface NAME=game-app scripts/consumer/rn-app.sh`.
//
// Usage (inside `nix develop`): node scripts/consumer/contention-device-test.mjs <adb-serial> [pilot|feasibility|A|B]
//
// Trials: "pilot"; "feasibility", "A" and "B": throughput phase only, at least 30 s rest between
// runs (longer, up to 5 min, while the thermal status is above 0; recorded, and the run goes ahead),
// thermal status recorded as a result, and one retry only for a capture failure (incomplete data,
// crash, timeout) with the first attempt's files kept as run-<n>-attempt1.*.
//
// Per run: force-stop (a fresh process), clear all log buffers, record thermal status, stream
// logcat to a file, start the activity with the run's rnrsgame://contention data URI (VIEW action,
// read by Linking.getInitialURL). During the warm-up: meminfo and a gfxinfo reset, the
// SurfaceFlinger layer list. 9.2 s into each measured phase (after the burst-500 stall):
// `dumpsys SurfaceFlinger --latency` for each SurfaceView layer of the app. In the touch phase:
// `input swipe` at fixed offsets. After "done": gfxinfo framestats, meminfo, thermal status.
// Captures run on the device while the app runs and may perturb it; their times are recorded.
//
// Writes results/surface/runs/<UTC>-<serial>-contention/ (never overwrites): manifest.json,
// run-<n>.json (app data and captures), run-<n>-logcat.txt (this app process only),
// summary.json (scripts/contention-summarize.mjs). Uninstalls the fixture app afterwards.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateTrial, summarizeRun, table } from '../contention-summarize.mjs';

const serial = process.argv[2];
if (!serial) throw new Error('usage: contention-device-test.mjs <adb-serial>');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = process.env.NAME ?? 'game-app';
const APK = path.join(
  ROOT,
  '.generated/consumer',
  NAME,
  'android/app/build/outputs/apk/release/app-release.apk',
);
const PACKAGE = 'com.helloworld';
const adb = (...args) =>
  execFileSync('adb', ['-s', serial, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 1 << 26,
  }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (adb('get-state') !== 'device') throw new Error(`${serial} is not connected`);
if (!existsSync(APK)) throw new Error(`${APK} missing; build the consumer first`);

const TRIAL = process.argv[3] ?? 'pilot';
const BASE = { placement: 'raf', instrumented: true, touch: false, churn: 0, hermes: 'phase' };
// Nominal churn bytes per tick: about 2 and 8 MB/s at 60 ticks/s.
const CHURN_L = 33334,
  CHURN_H = 133334;
const A_ARMS = {
  C: { profile: 'control' },
  R: { profile: 'periodic-100', placement: 'raf' },
  T: { profile: 'periodic-100', placement: 'task' },
};
const B_ARMS = {
  S: { profile: 'control', hermes: 'tick' },
  L: { profile: 'control', hermes: 'tick', churn: CHURN_L },
  H: { profile: 'control', hermes: 'tick', churn: CHURN_H },
  U: { profile: 'control' },
};
const blocks = (order, per, arms) =>
  order.map((arm, i) => ({
    id: i + 1,
    block: Math.floor(i / per) + 1,
    arm,
    ...BASE,
    ...arms[arm],
  }));
const TRIALS = {
  // The pilot manifest (plan: controls first and last around the stall profiles).
  pilot: [
    {
      id: 1,
      profile: 'control',
      placement: 'raf',
      instrumented: false,
      touch: false,
      role: 'uninstrumented baseline',
    },
    {
      id: 2,
      profile: 'control',
      placement: 'raf',
      instrumented: true,
      touch: true,
      role: 'instrumented control + touch validation',
    },
    {
      id: 3,
      profile: 'periodic-100',
      placement: 'raf',
      instrumented: true,
      touch: true,
      role: 'periodic stalls + touch validation',
    },
    {
      id: 4,
      profile: 'burst-500',
      placement: 'raf',
      instrumented: true,
      touch: false,
      role: 'burst stall',
    },
    {
      id: 5,
      profile: 'control',
      placement: 'raf',
      instrumented: true,
      touch: false,
      role: 'instrumented control (closing)',
    },
  ].map((r) => ({ churn: 0, hermes: 'phase', ...r })),
  feasibility: blocks(['U', 'S', 'H', 'T'], 4, { ...B_ARMS, T: A_ARMS.T }),
  // Latin-square blocks C R T / R T C / T C R.
  A: blocks(['C', 'R', 'T', 'R', 'T', 'C', 'T', 'C', 'R'], 3, A_ARMS),
  // Reversed-order paired pilot (not a full counterbalance).
  B: blocks(['S', 'L', 'H', 'U', 'U', 'H', 'L', 'S'], 4, B_ARMS),
};
const MANIFEST = TRIALS[TRIAL];
if (!MANIFEST) throw new Error(`unknown trial ${TRIAL}`);
const REST_MS = TRIAL === 'pilot' ? 3000 : 30000;
const THERMAL_WAIT_MAX_MS = 300000;
const SF_AT_MS = 9200;
const SWIPES_AT_MS = [2000, 5000, 10500, 12500];

const dir = path.join(
  ROOT,
  'results/surface/runs',
  `${new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}-${serial}-contention${TRIAL === 'pilot' ? '' : `-${TRIAL}`}`,
);
if (existsSync(dir)) throw new Error(`${dir} exists`);
mkdirSync(dir, { recursive: true });
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
const buildRecordFile = path.join(ROOT, '.generated/consumer', `${NAME}.build.json`);
const provenance = {
  apk: APK,
  apkSha256: sha256(APK),
  buildRecord: existsSync(buildRecordFile)
    ? JSON.parse(readFileSync(buildRecordFile, 'utf8'))
    : null,
  runner: path.relative(ROOT, fileURLToPath(import.meta.url)),
  runnerSha256: sha256(fileURLToPath(import.meta.url)),
  summarizerSha256: sha256(path.join(ROOT, 'scripts/contention-summarize.mjs')),
  runHead: git('rev-parse', 'HEAD').trim(),
  runStatusPorcelain: git('status', '--porcelain=v1', '--untracked-files=all')
    .split('\n')
    .filter(Boolean),
};
/** The Hermes artifact Gradle resolves for the consumer, its hashes, and the APK's copy. */
function hermesIdentity() {
  const out = {};
  const androidDir = path.join(ROOT, '.generated/consumer', NAME, 'android');
  const gradleHome = process.env.GRADLE_USER_HOME ?? path.join(ROOT, '.generated/gradle');
  try {
    out.dependencyInsight = execFileSync(
      './gradlew',
      [
        '--offline',
        '-q',
        ':app:dependencyInsight',
        '--configuration',
        'releaseRuntimeClasspath',
        '--dependency',
        'hermes-android',
      ],
      {
        cwd: androidDir,
        encoding: 'utf8',
        timeout: 600000,
        env: { ...process.env, GRADLE_USER_HOME: gradleHome },
      },
    )
      .split('\n')
      .filter((l) => /hermes-android/.test(l))
      .join('\n');
  } catch (e) {
    out.dependencyInsight = `unavailable: ${String(e.message).split('\n')[0]}`;
  }
  out.selectedVersion =
    out.dependencyInsight.match(/com\.facebook\.hermes:hermes-android:(\S+)/)?.[1] ?? 'unavailable';
  const base = path.join(
    gradleHome,
    'caches/modules-2/files-2.1/com.facebook.hermes/hermes-android',
    out.selectedVersion,
  );
  const aar = existsSync(base)
    ? readdirSync(base)
        .map((h) => path.join(base, h, `hermes-android-${out.selectedVersion}-release.aar`))
        .find(existsSync)
    : undefined;
  const unzipSha = (zip, entry) => {
    try {
      return createHash('sha256')
        .update(execFileSync('unzip', ['-p', zip, entry], { maxBuffer: 1 << 28 }))
        .digest('hex');
    } catch {
      return 'unavailable';
    }
  };
  out.aar = aar ? path.relative(ROOT, aar) : 'unavailable';
  out.aarSha256 = aar ? sha256(aar) : 'unavailable';
  out.aarLibhermesvmSha256 = aar ? unzipSha(aar, 'jni/arm64-v8a/libhermesvm.so') : 'unavailable';
  out.apkLibhermesvmSha256 = unzipSha(APK, 'lib/arm64-v8a/libhermesvm.so');
  out.identicalInApk =
    out.aarLibhermesvmSha256 !== 'unavailable' &&
    out.aarLibhermesvmSha256 === out.apkLibhermesvmSha256;
  out.sourceRevision = 'not recorded by the artifact (POM has no tag or commit); unproven';
  return out;
}
const identity = TRIAL === 'pilot' ? null : hermesIdentity();
const device = {
  serial,
  model: adb('shell', 'getprop', 'ro.product.model'),
  build: adb('shell', 'getprop', 'ro.build.fingerprint'),
  sdk: adb('shell', 'getprop', 'ro.build.version.sdk'),
};
writeFileSync(
  path.join(dir, 'manifest.json'),
  JSON.stringify(
    {
      trial: TRIAL,
      device,
      provenance,
      hermesIdentity: identity,
      runs: MANIFEST,
      sfAtMs: SF_AT_MS,
      swipesAtMs: SWIPES_AT_MS,
      freshProcess: 'force-stop before each run (one install per trial)',
      rest: {
        minMs: REST_MS,
        thermalWaitMaxMs: TRIAL === 'pilot' ? 0 : THERMAL_WAIT_MAX_MS,
        note: 'thermal status is recorded as a result; runs are never excluded or re-run for it',
      },
      retry:
        'once, only for a capture failure (incomplete data, crash, timeout); first attempt kept as run-<n>-attempt1.*',
      redactions: [
        'captures.sfList: only the layer lines naming com.helloworld are kept; filtered before anything is written',
      ],
    },
    null,
    2,
  ) + '\n',
);
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
check(
  'APK matches its build record (clean source)',
  provenance.buildRecord?.apkSha256 === provenance.apkSha256 &&
    provenance.buildRecord?.sourceClean === true,
  {
    built: provenance.buildRecord?.apkSha256 ?? null,
    installed: provenance.apkSha256,
    sourceClean: provenance.buildRecord?.sourceClean ?? null,
  },
);

const uriOf = (r) =>
  `rnrsgame://contention?profile=${r.profile}&placement=${r.placement}&instrumented=${r.instrumented ? 1 : 0}&touch=${r.touch ? 1 : 0}&churn=${r.churn}&hermes=${r.hermes}&run=${r.id}`;
const thermalStatus = (text) => Number(text.match(/Thermal Status:\s*(\d+)/)?.[1] ?? NaN);
/** App log lines (this pid) from the streamed logcat file: {t (epoch s), text}. */
function appLines(file, pid) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((l) => {
      const m = l.match(/^\s*(\d+\.\d+)\s+(\d+)\s+\d+\s+\w\s+[^:]*:\s(.*)$/);
      return m && m[2] === pid ? [{ t: Number(m[1]), text: m[3] }] : [];
    });
}
const events = (lines) =>
  lines
    .filter((l) => l.text.startsWith('RNRS_CONTENTION '))
    .map((l) => ({ ...JSON.parse(l.text.slice(15)), _t: l.t }));
function assemble(lines) {
  const parts = {};
  for (const l of lines) {
    if (!l.text.startsWith('RNRS_CONTENTION_DATA ')) continue;
    const c = JSON.parse(l.text.slice(20));
    (parts[c.key] ??= { parts: c.parts, chunks: [] }).chunks[c.part] = c.data;
  }
  const data = {};
  const incomplete = [];
  for (const [k, v] of Object.entries(parts)) {
    if (v.chunks.filter((x) => x !== undefined).length !== v.parts) incomplete.push(k);
    else data[k] = JSON.parse(v.chunks.join(''));
  }
  return { data, incomplete };
}
async function waitFor(pred, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const runs = [];
let w = 0,
  h = 0; // screen size (swipes in the pilot's touch phase)
try {
  adb('install', '-r', APK);
  [w, h] = adb('shell', 'wm', 'size')
    .match(/(\d+)x(\d+)/)
    .slice(1)
    .map(Number);
  let lastEnd = null;
  /** At least REST_MS since the last run; then, while the thermal status is above 0, up to THERMAL_WAIT_MAX_MS more. */
  const restBefore = async () => {
    const rest = { restMs: 0, thermalWaitMs: 0, statusBefore: null };
    if (lastEnd !== null) {
      const wait = Math.max(0, lastEnd + REST_MS - Date.now());
      await sleep(wait);
      rest.restMs = Date.now() - lastEnd;
    }
    const t0 = Date.now();
    rest.statusBefore = thermalStatus(adb('shell', 'dumpsys', 'thermalservice'));
    while (
      TRIAL !== 'pilot' &&
      lastEnd !== null &&
      rest.statusBefore > 0 &&
      Date.now() - t0 < THERMAL_WAIT_MAX_MS
    ) {
      await sleep(15000);
      rest.statusBefore = thermalStatus(adb('shell', 'dumpsys', 'thermalservice'));
    }
    rest.thermalWaitMs = Date.now() - t0;
    return rest;
  };
  const captureFailed = (run) =>
    run.errors.length > 0 || !run.data || run.incomplete.length > 0 || run.crashed;
  for (const r of MANIFEST) {
    let run = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const rest = await restBefore();
      run = await runOnce(r, attempt);
      run.rest = rest;
      lastEnd = Date.now();
      if (!captureFailed(run) || attempt === 2) break;
      // Keep the failed attempt's files; retry once.
      if (existsSync(path.join(dir, `run-${r.id}-logcat.txt`)))
        renameSync(
          path.join(dir, `run-${r.id}-logcat.txt`),
          path.join(dir, `run-${r.id}-attempt1-logcat.txt`),
        );
      writeFileSync(
        path.join(dir, `run-${r.id}-attempt1.json`),
        JSON.stringify(run, null, 1) + '\n',
      );
    }
    if (run.attempt === 2) run.previousAttempt = `run-${r.id}-attempt1.json`;
    writeFileSync(path.join(dir, `run-${r.id}.json`), JSON.stringify(run, null, 1) + '\n');
    runs.push(run);
    check(
      `run ${r.id} (${r.arm ?? r.profile}${r.instrumented ? '' : ', uninstrumented'}): completed with complete data, no crash${run.attempt === 2 ? ' (second attempt)' : ''}`,
      !captureFailed(run),
      { errors: run.errors, incomplete: run.incomplete, crashed: run.crashed },
    );
    check(
      `run ${r.id}: launch URI received via Linking.getInitialURL`,
      run.feasibility?.initialUrl?.url === run.uri,
      run.feasibility,
    );
  }
} catch (error) {
  check('trial completed', false, String(error));
} finally {
  try {
    adb('uninstall', PACKAGE);
  } catch {}
}

async function runOnce(r, attempt) {
  const run = {
    id: r.id,
    attempt,
    config: r,
    uri: uriOf(r),
    captures: { surfaceFlinger: [] },
    timeline: [],
    errors: [],
  };
  const mark = (what) => run.timeline.push({ what, hostMs: Date.now() });
  const logFile = path.join(dir, `run-${r.id}-logcat.all.tmp`);
  adb('shell', 'am', 'force-stop', PACKAGE);
  adb('logcat', '-b', 'all', '-c');
  run.captures.thermalBefore = adb('shell', 'dumpsys', 'thermalservice');
  const fd = openSync(logFile, 'w');
  const stream = spawn('adb', ['-s', serial, 'logcat', '-v', 'epoch'], {
    stdio: ['ignore', fd, 'ignore'],
  });
  let pid = null;
  try {
    await sleep(300);
    mark('start');
    adb(
      'shell',
      `am start -W -a android.intent.action.VIEW -n ${PACKAGE}/.MainActivity -d '${run.uri}'`,
    );
    pid = await waitFor(
      () => {
        try {
          return adb('shell', 'pidof', PACKAGE) || null;
        } catch {
          return null;
        }
      },
      15000,
      'app process',
    );
    run.pid = pid;
    const ev = () => events(appLines(logFile, pid));
    const phaseAt = (ph) => ev().find((e) => e.event === 'phase' && e.phase === ph);
    run.feasibility = {
      initialUrl: await waitFor(
        () => ev().find((e) => e.event === 'config'),
        20000,
        'config line (Linking.getInitialURL)',
      ).catch((e) => ({ error: String(e) })),
    };
    await waitFor(() => phaseAt('warmup'), 30000, 'warm-up');
    mark('warmup seen');
    run.captures.meminfoBefore = adb('shell', 'dumpsys', 'meminfo', PACKAGE);
    adb('shell', 'dumpsys', 'gfxinfo', PACKAGE, 'reset');
    // Only the app's own layers are kept (the full list names other installed apps).
    run.captures.sfList = adb('shell', 'dumpsys', 'SurfaceFlinger', '--list')
      .split('\n')
      .filter((l) => l.includes(PACKAGE))
      .join('\n');
    const layers = run.captures.sfList
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('SurfaceView') && l.includes(PACKAGE));
    run.captures.sfLayers = layers;
    mark('warmup captures done');
    for (const ph of r.touch ? ['throughput', 'touch'] : ['throughput']) {
      await waitFor(() => phaseAt(ph), 30000, ph);
      const seen = Date.now();
      mark(`${ph} seen`);
      const at = (ms) => sleep(Math.max(0, seen + ms - Date.now()));
      const todo = [
        { ms: SF_AT_MS, what: 'sf' },
        ...(ph === 'touch' ? SWIPES_AT_MS.map((ms, i) => ({ ms, what: 'swipe', i })) : []),
      ].sort((a, b) => a.ms - b.ms);
      for (const job of todo) {
        await at(job.ms);
        if (job.what === 'sf') {
          for (const layer of layers) {
            const hostMs = Date.now();
            run.captures.surfaceFlinger.push({
              phase: ph,
              layer,
              atPhaseMs: hostMs - seen,
              text: adb('shell', 'dumpsys', 'SurfaceFlinger', '--latency', `'${layer}'`),
            });
          }
        } else {
          const y = Math.round(h * 0.7);
          const [x0, x1] = job.i % 2 === 0 ? [w * 0.5, w * 0.1] : [w * 0.1, w * 0.9];
          mark(`swipe ${job.i}`);
          adb(
            'shell',
            'input',
            'swipe',
            String(Math.round(x0)),
            String(y),
            String(Math.round(x1)),
            String(y),
            '300',
          );
        }
      }
    }
    const done = await waitFor(() => ev().find((e) => e.event === 'done'), 60000, 'done');
    mark('done seen');
    await sleep(1500); // the data lines precede "done"; let the stream flush
    run.captures.gfxinfo = adb('shell', 'dumpsys', 'gfxinfo', PACKAGE, 'framestats');
    run.captures.meminfoAfter = adb('shell', 'dumpsys', 'meminfo', PACKAGE);
    run.captures.thermalAfter = adb('shell', 'dumpsys', 'thermalservice');
    const { data, incomplete } = assemble(appLines(logFile, pid));
    run.done = done;
    run.data = data;
    run.incomplete = incomplete;
    run.events = ev();
  } catch (error) {
    run.errors.push(String(error));
  } finally {
    stream.kill();
    closeSync(fd);
    if (pid)
      writeFileSync(
        path.join(dir, `run-${r.id}-logcat.txt`),
        appLines(logFile, pid)
          .map((l) => `${l.t} ${l.text}`)
          .join('\n') + '\n',
      );
    execFileSync('rm', ['-f', logFile]); // other processes' logs are not kept
    const crashes = (() => {
      try {
        return adb('logcat', '-d', '-b', 'crash');
      } catch {
        return '';
      }
    })();
    run.crashed = !!pid && (crashes.includes(PACKAGE) || crashes.includes(`pid: ${pid}`));
    adb('shell', 'am', 'force-stop', PACKAGE);
  }
  return run;
}

const summaries = runs.map((run) => {
  try {
    return summarizeRun(run);
  } catch (e) {
    return { id: run.id, config: run.config, valid: false, notes: [`summary failed: ${e}`] };
  }
});
for (const s of summaries) {
  if (s.frameCorrelation)
    check(
      `run ${s.id}: each JS submit's ring record lies inside its JS tick (mapped clock ± bound); no sequence gaps`,
      s.frameCorrelation.ok,
      { ...s.frameCorrelation, ring: s.ring },
    );
  if (s.touch)
    check(
      `run ${s.id}: touches correlated (used touches carried by a frame)`,
      s.touch.used > 0 && s.touch.carriedByFrame === s.touch.used,
      s.touch,
    );
  check(`run ${s.id}: no lifecycle pause during measured phases`, s.valid, s.notes);
}
const evaluation = evaluateTrial(TRIAL, runs, summaries, identity);
const result = {
  ok: checks.every((c) => c.ok),
  checks,
  table: table(summaries),
  evaluation,
  summaries,
};
writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`${result.ok ? 'PASS' : 'FAIL'} ${dir}`);
for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`);
console.table(result.table);
if (evaluation)
  console.log(
    JSON.stringify(
      TRIAL === 'feasibility'
        ? {
            proceed: evaluation.proceed,
            conditions: Object.fromEntries(
              Object.entries(evaluation.conditions).map(([k, v]) => [k, v.met]),
            ),
          }
        : evaluation,
      null,
      1,
    ).slice(0, 6000),
  );
process.exit(result.ok ? 0 : 1);
