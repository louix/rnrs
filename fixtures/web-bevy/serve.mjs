// Serves the built fixture for a manual headed check on http://localhost:<port>/ (localhost is a
// secure context, which WebGPU requires). Usage: node fixtures/web-bevy/serve.mjs [port], default
// 8780. Run build.mjs first. Files are read per request (no caching), so a rebuild is served as is.
// Diagnostics: POST /log appends one JSON line per request to .generated/web-bevy-beacon.log (the
// teardown probe's steps arrive here at once, surviving a browser crash); /probe-info.json gives
// the sha256 of the teardown.html being served.
import http from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('.', import.meta.url));
const beaconLog = fileURLToPath(new URL('../../.generated/web-bevy-beacon.log', import.meta.url));
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};
const port = Number(process.argv[2] ?? 8780);
const MAX_BODY = 16_384;
async function handle(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (req.method === 'POST' && pathname === '/log') {
    // Same-origin pages only (sendBeacon sends Origin); other local pages cannot append.
    if (
      req.headers.origin !== `http://localhost:${port}` &&
      req.headers.origin !== `http://127.0.0.1:${port}`
    )
      return res.writeHead(403).end();
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) return res.writeHead(413).end();
    }
    await mkdir(path.dirname(beaconLog), { recursive: true });
    await appendFile(
      beaconLog,
      JSON.stringify({ receivedAt: new Date().toISOString(), body }) + '\n',
    );
    return res.writeHead(204).end();
  }
  if (pathname === '/probe-info.json') {
    const sha256 = createHash('sha256')
      .update(await readFile(path.join(fixture, 'teardown.html')))
      .digest('hex');
    return res
      .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ sha256 }));
  }
  const file = path.join(fixture, pathname.slice(1) || 'index.html');
  if (!file.startsWith(fixture)) return res.writeHead(403).end();
  let body;
  try {
    body = await readFile(file);
  } catch {
    return res.writeHead(404).end();
  }
  res
    .writeHead(200, {
      'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    .end(body);
}
// A failed request (bad URI, write error) answers 500 and never stops the server.
http
  .createServer((req, res) =>
    handle(req, res).catch((error) => {
      console.error('request failed', req.url, error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }),
  )
  .listen(port, '127.0.0.1', () => console.log(`serving http://localhost:${port}/?expect=view`));
