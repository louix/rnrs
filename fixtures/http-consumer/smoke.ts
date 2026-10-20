// HTTP consumer smoke: only the public API of @rnrs/example-http, against the local test server
// (scripts/http-test-server.mjs; on a device through `adb reverse`). Shared by the clean
// React Native app and the Vite app. Observed connection behaviour comes from the server's
// log, not from assumptions.
import {httpModule, type HttpRequest} from '@rnrs/example-http';

export interface SmokeResult {
  ok: boolean;
  platform: string;
  checks: {name: string; ok: boolean; detail: string}[];
}

const web = typeof (globalThis as any).document !== 'undefined';
const BASE: string = (globalThis as any).__RNR_HTTP_BASE ?? 'http://127.0.0.1:8787';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Date.now();
const fail = (message: string): never => { throw new Error(message); };

/** ASCII/Latin-1 text of a body, in slices (no huge argument lists, no TextDecoder needed). */
const text = (b: ArrayBuffer) => {
  const bytes = new Uint8Array(b);
  let out = '';
  for (let i = 0; i < bytes.length; i += 4096) out += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return out;
};

interface Conn { id: number; requests: string[]; open: boolean; closedByClient: boolean }

export async function runSmoke(): Promise<SmokeResult> {
  const http = httpModule();
  const checks: SmokeResult['checks'] = [];
  async function check(name: string, body: () => Promise<string | void>) {
    try {
      checks.push({name, ok: true, detail: (await body()) ?? ''});
    } catch (error) {
      checks.push({name, ok: false, detail: String((error as Error)?.message ?? error)});
    }
  }
  const get = (path: string, extra: Partial<HttpRequest> = {}) => http.fetch({url: BASE + path, ...extra});
  const rejection = async (p: () => Promise<unknown>) => {
    try { await p(); } catch (e: any) { return {name: e?.name as string, message: String(e?.message ?? e)}; }
    return fail('expected a rejection');
  };
  const log = async (): Promise<Conn[]> => {
    const r = await get('/__log');
    return JSON.parse(text(r.body)).connections;
  };
  const connectionsFor = async (request: string) => (await log()).filter(c => c.requests.includes(request));
  /** Waits until the connection(s) that carried `request` were closed by the client. */
  const closedByClient = async (request: string) => {
    for (let i = 0; i < 100; i++) {
      const conns = await connectionsFor(request);
      if (conns.length && conns.every(c => c.closedByClient || !c.open)) return true;
      await sleep(30);
    }
    return false;
  };
  const settledDiagnostics = async (baseline: {active: number; bufferedBytes: number}) => {
    for (let i = 0; i < 100; i++) {
      const d = http.diagnostics();
      if (d.active === baseline.active && d.bufferedBytes === baseline.bufferedBytes) return d;
      await sleep(20);
    }
    return fail(`requests still active: ${JSON.stringify(http.diagnostics())} (baseline ${JSON.stringify(baseline)})`);
  };

  await get('/__reset');
  await check('responses: bytes, headers, status, redirect, POST echo', async () => {
    const r = await get('/bytes/70000');
    const body = new Uint8Array(r.body);
    if (r.status !== 200 || body.length !== 70000 || body.some((b, i) => b !== i % 251)) fail(`bytes: ${r.status} ${body.length}`);
    if (!r.headers.some(h => h.name === 'x-test' && h.value === 'yes')) fail('x-test header missing');
    const s = await get('/status/503');
    if (s.status !== 503) fail(`status ${s.status}`);
    const redirect = await get('/redirect');
    if (redirect.url !== BASE + '/bytes/3' || redirect.body.byteLength !== 3) fail(`redirect: ${redirect.url}`);
    const echo = await http.fetch({url: BASE + '/echo', method: 'POST', headers: [{name: 'x-echo', value: 'hi'}], body: new Uint8Array([112, 97, 121]).buffer});
    if (text(echo.body) !== 'POST hi pay') fail(`echo: ${text(echo.body)}`);
  });

  await check('HEAD: a large Content-Length is not a body (maxBytes 0 succeeds); GET is still refused', async () => {
    const r = await http.fetch({url: BASE + '/huge', method: 'HEAD', maxBytes: 0});
    if (r.status !== 200 || r.body.byteLength !== 0) fail(`HEAD: ${r.status} ${r.body.byteLength}`);
    const length = r.headers.find(h => h.name === 'content-length')?.value;
    if (length !== '1000000000000') fail(`content-length ${length}`);
    const e = await rejection(() => get('/huge', {maxBytes: 0}));
    if (e.message !== 'too-large: the response body exceeds maxBytes (0 bytes)') fail(e.message);
  });

  await check('maxBytes: by content-length and while streaming; buffers released', async () => {
    const baseline = http.diagnostics();
    const a = await rejection(() => get('/bytes/1001', {maxBytes: 1000}));
    if (a.message !== 'too-large: the response body exceeds maxBytes (1000 bytes)') fail(a.message);
    const start = now();
    const b = await rejection(() => get('/drip/forever?t=max', {maxBytes: 2500}));
    if (!b.message.startsWith('too-large:') || now() - start > 3000) fail(`${b.message} after ${now() - start} ms`);
    if ((await get('/bytes/1000', {maxBytes: 1000})).body.byteLength !== 1000) fail('exact limit');
    await settledDiagnostics(baseline);
    return `stream stopped after ${now() - start} ms; connection closed by client: ${await closedByClient('GET /drip/forever?t=max')}`;
  });

  await check('timeouts: before headers and during the body; server sees the close', async () => {
    const start = now();
    const a = await rejection(() => get('/slow-headers/5000?t=to1', {timeoutMs: 200}));
    if (a.message !== 'timeout: no complete response within 200 ms' || now() - start > 2000) fail(`${a.message} after ${now() - start} ms`);
    const b = await rejection(() => get('/drip/forever?t=to2', {timeoutMs: 300}));
    if (!b.message.startsWith('timeout:')) fail(b.message);
    const closed = [await closedByClient('GET /slow-headers/5000?t=to1'), await closedByClient('GET /drip/forever?t=to2')];
    if (!closed.every(Boolean)) fail(`server saw client closes: ${closed}`);
  });

  await check('cancellation: AbortError, Rust future and buffer released, server sees the close', async () => {
    const baseline = http.diagnostics();
    const controller = new AbortController();
    const pending = http.fetch({url: BASE + '/drip/forever?t=cancel'}, {signal: controller.signal});
    for (let i = 0; i < 100 && http.diagnostics().bufferedBytes - baseline.bufferedBytes < 3000; i++) await sleep(20);
    const buffered = http.diagnostics().bufferedBytes - baseline.bufferedBytes;
    if (buffered < 3000) fail(`body never streamed (${buffered} bytes)`);
    controller.abort();
    const e = await rejection(() => pending);
    if (e.name !== 'AbortError') fail(`${e.name}: ${e.message}`);
    const after = await settledDiagnostics(baseline);
    if (after.droppedEarly - baseline.droppedEarly !== 1) fail(`droppedEarly +${after.droppedEarly - baseline.droppedEarly}`);
    if (!await closedByClient('GET /drip/forever?t=cancel')) fail('the server did not see the connection closed');
    return `${buffered} bytes buffered before the abort, released after`;
  });

  await check('connection reuse (observed, not required)', async () => {
    for (let i = 0; i < 3; i++) await get('/bytes/10?t=pool');
    const conns = await connectionsFor('GET /bytes/10?t=pool');
    return `3 sequential complete requests used ${conns.length} connection(s)`;
  });

  await check('validation rejects before any request', async () => {
    const cases: [Partial<HttpRequest>, RegExp][] = [
      [{timeoutMs: 0}, /timeoutMs must be an integer from 1 to 300000/],
      [{timeoutMs: 1.5}, /timeoutMs/],
      [{maxBytes: -1}, /maxBytes must be an integer from 0 to 67108864/],
      [{method: 'TRACE'}, /method must be one of/],
      [{url: 'ftp://127.0.0.1/'}, /url scheme must be http or https/],
      [{headers: [{name: 'bad name', value: 'x'}]}, /headers\[0\]\.name/],
      [{body: new ArrayBuffer(1)}, /GET request cannot have a body/],
      [{headers: [{name: 'Host', value: 'elsewhere'}]}, /controlled by the transport/],
      [{headers: [{name: 'Transfer-Encoding', value: 'chunked'}]}, /controlled by the transport/],
    ];
    const before = (await connectionsFor('GET /bytes/1?t=invalid')).length;
    for (const [extra, expected] of cases) {
      const e = await rejection(() => get('/bytes/1?t=invalid', extra));
      if (e.name !== 'RangeError' || !expected.test(e.message)) fail(`${JSON.stringify(Object.keys(extra))}: ${e.name}: ${e.message}`);
    }
    if ((await connectionsFor('GET /bytes/1?t=invalid')).length !== before) fail('an invalid request reached the server');
  });

  await check('transport errors: refused connection, truncated body', async () => {
    const refused = await rejection(() => http.fetch({url: 'http://127.0.0.1:9/'}));
    const truncated = await rejection(() => get('/truncated'));
    const ok = (web ? /^network:/ : /^connect:/).test(refused.message) && /^(body|network):/.test(truncated.message);
    if (!ok) fail(`refused: ${refused.message} | truncated: ${truncated.message}`);
    return `refused -> ${refused.message.split(':')[0]}; truncated -> ${truncated.message.split(':')[0]}`;
  });

  await check(web ? 'CORS: a response without CORS headers is a network error' : 'no CORS natively: the same response succeeds', async () => {
    if (web) {
      const e = await rejection(() => get('/nocors/bytes/4'));
      if (!/^network:/.test(e.message)) fail(e.message);
      return e.message.slice(0, 80);
    }
    const r = await get('/nocors/bytes/4');
    if (r.status !== 200 || r.body.byteLength !== 4) fail(`status ${r.status}`);
  });

  const d = http.diagnostics();
  if (d.active !== 0 || d.bufferedBytes !== 0) checks.push({name: 'no request left active', ok: false, detail: JSON.stringify(d)});
  return {ok: checks.every(c => c.ok), platform: web ? 'web' : 'native', checks};
}
