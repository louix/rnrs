// iOS device test of @rnrs/example-http and @rnrs/example-kv in a clean consumer app
// (scripts/consumer/ios-app.sh with RNR_IOS_FIXTURE=modules builds it,
// scripts/consumer/ios-modules-test.mjs runs it). Public APIs and @rnrs/runtime/testing only.
//
// The runner passes its configuration as launch arguments (`-rnrPhase run`), which iOS puts in
// the NSUserDefaults argument domain, read here through React Native's Settings:
//   rnrHttpBase      the runner's HTTP test server (scripts/http-test-server.mjs) on the Mac's LAN address
//   rnrHttpsLocal    an HTTPS server on the Mac with a throwaway self-signed certificate
//   rnrHttpsPublic   optional publicly trusted HTTPS URL ('' skips the check)
//   rnrPhase         'run' (first launch) or 'verify' (after the runner killed and relaunched the app)
//   rnrNonce         the token the 'run' launch flushes and the 'verify' launch must read back
// Within the 'run' launch, runtime 0 runs the smokes, arms in-flight work and reloads; runtime 1
// checks what the reload left, then flushes the token with its handle left open for the
// runner's SIGKILL. Reports are chunked console.error lines (os_log), as in
// fixtures/consumer/ios/device.ts. Databases used: consumer-smoke (kv smoke), rnr-ios-lifecycle,
// rnr-ios-persist; all are deleted by the end of the 'verify' launch.
import { Settings } from 'react-native';
import { runtimeBindings } from '@rnrs/runtime/testing';
import { httpModule } from '@rnrs/example-http';
import { kvModule } from '@rnrs/example-kv';
import { runSmoke as runHttpSmoke } from './http-smoke';
import { runSmoke as runKvSmoke } from './kv-smoke';

const global = globalThis as any;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const setting = (key: string) => {
  const v = Settings.get(key);
  return typeof v === 'string' ? v : '';
};
const BASE = setting('rnrHttpBase');
const LIFECYCLE = 'rnr-ios-lifecycle';
const PERSIST = 'rnr-ios-persist';
const WRITES = 24;
const VALUE_BYTES = 4096;
const value = (i: number) => new Uint8Array(VALUE_BYTES).fill(i % 251).buffer;
const isValue = (b: ArrayBuffer, i: number) =>
  b.byteLength === VALUE_BYTES && new Uint8Array(b).every((x) => x === i % 251);
const ascii = (b: ArrayBuffer | null) => (b ? String.fromCharCode(...new Uint8Array(b)) : null);
const asciiBytes = (s: string) => new Uint8Array(Array.from(s, (c) => c.charCodeAt(0))).buffer;

let sequence = 0;
/** One report as console.error lines of at most 700 characters (os_log truncates long ones). */
function report(record: object) {
  const text = JSON.stringify(record);
  const id = `${Date.now()}-${sequence++}`;
  const parts = Math.ceil(text.length / 700) || 1;
  for (let i = 0; i < parts; i++)
    console.error(`RNR_IOS ${id} ${i + 1}/${parts} ${text.slice(i * 700, (i + 1) * 700)}`);
}

type Check = { name: string; ok: boolean; detail: string };
async function checked(name: string, body: () => Promise<string | void>): Promise<Check> {
  try {
    return { name, ok: true, detail: (await body()) ?? '' };
  } catch (error) {
    return { name, ok: false, detail: String((error as Error)?.message ?? error) };
  }
}
const fail = (message: string): never => {
  throw new Error(message);
};
const rejection = async (p: () => Promise<unknown>) => {
  try {
    await p();
  } catch (e: any) {
    return { name: String(e?.name), message: String(e?.message ?? e) };
  }
  return fail('expected a rejection');
};

/** Deletes a database, waiting while a closed handle's final release is still in progress. */
async function deleteDatabase(name: string) {
  for (let i = 0; i < 100; i++) {
    try {
      return await kvModule().deleteDatabase(name);
    } catch (e: any) {
      if (!String(e.message).startsWith('busy:')) throw e;
      await sleep(50);
    }
  }
  return fail(`${name} stayed busy`);
}

/** HTTPS: rustls with the bundled webpki roots only. */
async function httpsChecks(): Promise<Check[]> {
  const http = httpModule();
  const checks = [
    await checked(
      'https: a local certificate from an untrusted issuer is refused (UnknownIssuer; webpki roots only)',
      async () => {
        const e = await rejection(() =>
          http.fetch({ url: setting('rnrHttpsLocal'), timeoutMs: 10000 }),
        );
        if (
          !e.message.startsWith('connect:') ||
          !/invalid peer certificate: UnknownIssuer/.test(e.message)
        )
          fail(e.message);
        return e.message;
      },
    ),
  ];
  const pub = setting('rnrHttpsPublic');
  if (pub) {
    checks.push(
      await checked(
        `https: a publicly trusted endpoint (${pub}) verifies and responds`,
        async () => {
          const r = await http.fetch({ url: pub, timeoutMs: 20000, maxBytes: 1 << 20 });
          if (r.status !== 200 || r.body.byteLength === 0)
            fail(`status ${r.status}, ${r.body.byteLength} bytes`);
          return `status ${r.status}, ${r.body.byteLength} bytes, final url ${r.url}`;
        },
      ),
    );
  }
  return checks;
}

/** kv semantics beyond the consumer smoke: cancellation of writes, concurrent close calls. */
async function kvChecks(): Promise<Check[]> {
  const kv = kvModule();
  return [
    await checked(
      'kv: an aborted put rejects with AbortError; the value is whole or absent',
      async () => {
        const store = await kv.open(LIFECYCLE);
        const controller = new AbortController();
        const pending = store.put('abort/1', value(1), { signal: controller.signal });
        controller.abort();
        const e = await rejection(() => pending);
        if (e.name !== 'AbortError') fail(`${e.name}: ${e.message}`);
        for (let i = 0; i < 100 && kv.diagnostics().running > 0; i++) await sleep(20);
        const v = await store.get('abort/1');
        if (v && !isValue(v, 1)) fail('torn value');
        await store.close();
        return v ? 'the write was still applied (allowed)' : 'the write was not applied';
      },
    ),
    await checked(
      'kv: concurrent close() calls wait for in-flight writes and share one outcome',
      async () => {
        const store = await kv.open(LIFECYCLE);
        const writes = Array.from({ length: WRITES }, (_, i) =>
          store.put(`cc/${i}`, value(i)).then(
            () => 'ok',
            (e) => String(e.message),
          ),
        );
        const closes = await Promise.allSettled([store.close(), store.close(), store.close()]);
        const settledWrites =
          (await Promise.race([Promise.all(writes), sleep(0).then(() => null)])) ??
          fail('a close() resolved before the in-flight writes settled');
        if (!closes.every((c) => c.status === 'fulfilled')) fail(JSON.stringify(closes));
        const later = await rejection(() => store.close().then(() => store.get('cc/0')));
        if (!later.message.startsWith('closed:')) fail(later.message);
        const reopened = await kv.open(LIFECYCLE);
        let applied = 0;
        for (let i = 0; i < WRITES; i++) {
          const v = await reopened.get(`cc/${i}`);
          if (settledWrites[i] === 'ok' ? !(v && isValue(v, i)) : v !== null)
            fail(`cc/${i}: ${settledWrites[i]} but ${v ? v.byteLength : 'absent'}`);
          if (v) applied++;
        }
        await reopened.close();
        return `${applied} written before close, ${WRITES - applied} refused as closed`;
      },
    ),
  ];
}

/** Runtime 0 of the 'run' launch. */
async function phaseRun(update: (s: string) => void) {
  update('HTTP smoke…');
  global.__RNR_HTTP_BASE = BASE;
  const http = await runHttpSmoke();
  report({ type: 'http-smoke', ...http });
  const https = await httpsChecks();
  report({ type: 'https', ok: https.every((c) => c.ok), checks: https });
  update('kv smoke…');
  const kv = await runKvSmoke();
  report({ type: 'kv-smoke', ...kv });
  await deleteDatabase(LIFECYCLE);
  const extra = await kvChecks();
  report({ type: 'kv-extra', ok: extra.every((c) => c.ok), checks: extra });

  // Work in flight across a reload: an endless HTTP response and unawaited kv writes.
  update('Reloading with work in flight…');
  await httpModule().fetch({ url: `${BASE}/__reset` });
  const httpBefore = httpModule().diagnostics();
  httpModule()
    .fetch({ url: `${BASE}/drip/forever?t=reload`, timeoutMs: 300000 })
    .catch(() => {});
  for (
    let i = 0;
    i < 100 && httpModule().diagnostics().bufferedBytes - httpBefore.bufferedBytes < 3000;
    i++
  )
    await sleep(20);
  const store = await kvModule().open(LIFECYCLE);
  global.__rnrLifecycle = store;
  await store.put('marker', asciiBytes('flushed'));
  await store.flush();
  for (let i = 0; i < WRITES; i++) store.put(`reload/${i}`, value(i)).catch(() => {});
  report({
    type: 'armed',
    httpBefore,
    http: httpModule().diagnostics(),
    kv: kvModule().diagnostics(),
  });
  runtimeBindings().reloadForTesting!();
}

/** Runtime 1 of the 'run' launch: what the reload left behind. */
async function phaseAfterReload(update: (s: string) => void) {
  update('Checking after reload…');
  const deadline = Date.now() + 10000;
  while (
    Date.now() < deadline &&
    (httpModule().diagnostics().active > 0 || kvModule().diagnostics().running > 0)
  )
    await sleep(50);
  const http = httpModule().diagnostics();
  let closedByClient: boolean | null = null;
  for (let i = 0; i < 100 && !closedByClient; i++) {
    const log = JSON.parse(
      ascii((await httpModule().fetch({ url: `${BASE}/__log` })).body) ?? '{}',
    );
    const conns = (log.connections ?? []).filter((c: any) =>
      c.requests.includes('GET /drip/forever?t=reload'),
    );
    closedByClient = conns.length > 0 && conns.every((c: any) => c.closedByClient || !c.open);
    if (!closedByClient) await sleep(30);
  }
  // The old runtime's handle may not be released yet: the database is shared, so this opens it.
  const store = await kvModule().open(LIFECYCLE);
  const marker = ascii(await store.get('marker'));
  let applied = 0,
    torn = 0;
  for (let i = 0; i < WRITES; i++) {
    const v = await store.get(`reload/${i}`);
    if (!v) continue;
    if (isValue(v, i)) applied++;
    else torn++;
  }
  await store.close();
  report({
    type: 'after-reload',
    http,
    closedByClient,
    marker,
    applied,
    torn,
    kv: kvModule().diagnostics(),
  });
  // Released when the old runtime's handle is finalized (rnr-kv-closer); deleteDatabase waits.
  const lifecycleDeleted = await deleteDatabase(LIFECYCLE);

  // Durability across a process kill: written and flushed, the handle left open (the runner
  // kills the process next).
  await deleteDatabase(PERSIST);
  const persist = await kvModule().open(PERSIST);
  global.__rnrPersist = persist;
  await persist.put('token', asciiBytes(setting('rnrNonce')));
  const flushed = await persist.flush();
  report({
    type: 'run-done',
    lifecycleDeleted,
    persist: { token: setting('rnrNonce'), flushed },
    kv: kvModule().diagnostics(),
  });
  update('Run launch finished.');
}

/** The 'verify' launch, after the runner killed the process. */
async function phaseVerify(update: (s: string) => void) {
  update('Verifying persistence…');
  const store = await kvModule().open(PERSIST);
  const token = ascii(await store.get('token'));
  await store.close();
  const cleanup: Record<string, boolean | string> = {};
  for (const name of [PERSIST, LIFECYCLE, 'consumer-smoke']) {
    try {
      cleanup[name] = await deleteDatabase(name);
    } catch (e: any) {
      cleanup[name] = String(e.message);
    }
  }
  report({
    type: 'verified',
    token,
    expected: setting('rnrNonce'),
    cleanup,
    kv: kvModule().diagnostics(),
  });
  update('Verify launch finished.');
}

export async function runIosModulesTest(update: (s: string) => void) {
  // One run per runtime; a remounted surface reuses it.
  if (global.__rnrIosRun) return;
  global.__rnrIosRun = true;
  const runtime = runtimeBindings().lifecycle().bindingsInstalled - 1;
  const phase = setting('rnrPhase');
  report({
    type: 'runtime',
    phase,
    runtime,
    platform: runtimeBindings().platform,
    testHooks: runtimeBindings().testHooks,
    env: { build: __DEV__ ? 'debug' : 'release', hermes: !!global.HermesInternal },
    base: BASE,
  });
  try {
    if (phase === 'run' && runtime === 0) await phaseRun(update);
    else if (phase === 'run' && runtime === 1) await phaseAfterReload(update);
    else if (phase === 'verify' && runtime === 0) await phaseVerify(update);
    else update(`Nothing to do (phase ${JSON.stringify(phase)}, runtime ${runtime}).`);
  } catch (error) {
    report({ type: 'error', phase, runtime, error: String((error as Error)?.stack ?? error) });
    update(`Error: ${error}`);
  }
}
