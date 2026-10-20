// Runs the browser harness (web/) in headless Chromium and prints the conformance result.
// Usage (inside `nix develop .#web`, after scripts/build-web.sh):
//   node scripts/web-test.mjs [results/web-run.json]
// RNR_WEB_ROOT selects another static directory to serve (the Vite consumer's dist/).
// RNR_WEB_PAGE selects the page (default index.html), RNR_WEB_QUERY appends a query string,
// RNR_WEB_TIMEOUT_MS sets the result timeout (default 60 s), RNR_WEB_PRECISE_MEMORY=1 adds
// Chromium's --enable-precise-memory-info (performance.memory without quantization).
// RNR_HTTP_TEST_SERVER=1 also starts scripts/http-test-server.mjs on another port (so
// requests are cross-origin) and passes its URL to the page as ?http=.
// RNR_WEB_UNSAFE_WEBGPU=1 (test only) drops --disable-gpu and adds --enable-unsafe-webgpu, which
// in this headless Chromium exposes only SwiftShader's software WebGPU adapter: correctness
// evidence, never GPU performance. Default runs keep WebGPU unavailable.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.env.RNR_WEB_ROOT ?? 'web');
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};
const server = http.createServer(async (req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file.endsWith('/') ? path.join(file, 'index.html') : file);
    // Cross-origin isolation makes SharedArrayBuffer available, so its rejection is tested.
    res
      .writeHead(200, {
        'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      })
      .end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let httpServer;
let query = '';
if (process.env.RNR_HTTP_TEST_SERVER) {
  const { startServer } = await import('./http-test-server.mjs');
  httpServer = await startServer(0);
  query = `?http=${encodeURIComponent(`http://127.0.0.1:${httpServer.address().port}`)}`;
}
const extra = process.env.RNR_WEB_QUERY ?? '';
const pageUrl = `http://127.0.0.1:${server.address().port}/${process.env.RNR_WEB_PAGE ?? 'index.html'}${query}${extra ? (query ? '&' : '?') + extra : ''}`;

const profile = await mkdtemp(path.join(tmpdir(), 'rnr-chromium-'));
const browser = spawn(
  process.env.CHROMIUM ?? 'chromium',
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    ...(process.env.RNR_WEB_UNSAFE_WEBGPU === '1' ? ['--enable-unsafe-webgpu'] : ['--disable-gpu']),
    '--js-flags=--expose-gc',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    ...(process.env.RNR_WEB_PRECISE_MEMORY ? ['--enable-precise-memory-info'] : []),
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const wsUrl = await new Promise((resolve, reject) => {
  let log = '';
  browser.stderr.on('data', (chunk) => {
    log += chunk;
    const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) resolve(match[1]);
  });
  browser.on('exit', (code) => reject(new Error(`chromium exited ${code}: ${log}`)));
});

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 1;
const waiting = new Map();
const consoleLines = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && waiting.has(message.id)) {
    const { resolve, reject } = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  } else if (message.method === 'Runtime.consoleAPICalled') {
    consoleLines.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
  } else if (message.method === 'Runtime.exceptionThrown') {
    consoleLines.push(`exception: ${message.params.exceptionDetails.exception?.description}`);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

let exitCode = 1;
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  const version = await send('Browser.getVersion');
  await send('Page.navigate', { url: pageUrl }, sessionId);
  if (process.env.RNR_WEB_DRIVER) {
    const { drive } = await import(pathToFileURL(path.resolve(process.env.RNR_WEB_DRIVER)));
    await drive({ send: (method, params) => send(method, params, sessionId) });
  }
  const deadline = Date.now() + Number(process.env.RNR_WEB_TIMEOUT_MS ?? 60_000);
  let result;
  while (!result) {
    if (Date.now() > deadline) throw new Error('timed out waiting for __rnrResult');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const evaluated = await send(
      'Runtime.evaluate',
      { expression: 'JSON.stringify(globalThis.__rnrResult ?? null)', returnByValue: true },
      sessionId,
    );
    result = JSON.parse(evaluated.result.value ?? 'null');
  }
  result.browser = version.product;
  for (const check of result.checks)
    console.log(
      `${check.ok ? 'PASS' : 'FAIL'} ${check.name} ${check.ms === undefined ? '' : `(${check.ms.toFixed(1)} ms) `}${check.detail}`,
    );
  if (result.error) console.log(`ERROR ${result.error}`);
  if (consoleLines.length) console.log(`console:\n  ${consoleLines.join('\n  ')}`);
  if (result.blocked) console.log(`BLOCKED ${result.blocked}`);
  console.log(
    `${result.ok ? (result.blocked ? 'OK (checks only; BLOCKED items above)' : 'OK') : 'FAILED'}: ${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks in ${version.product}`,
  );
  if (process.argv[2])
    await writeFile(process.argv[2], JSON.stringify({ ...result, console: consoleLines }, null, 2));
  exitCode = result.ok ? 0 : 1;
} finally {
  ws.close();
  browser.kill();
  server.close();
  httpServer?.closeAllConnections();
  httpServer?.close();
  await new Promise((resolve) => browser.once('exit', resolve));
  // Chromium may still be flushing its profile right after exit.
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(exitCode);
