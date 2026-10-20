// Serves the built fixture for a manual headed check on http://localhost:<port>/ (localhost is a
// secure context, which WebGPU requires). Usage: node fixtures/web-webgpu/serve.mjs [port]
// Run build.mjs first; /probe/ maps to fixtures/web-webgpu-probe for repro.html.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const fixture = fileURLToPath(new URL('.', import.meta.url));
const probe = fileURLToPath(new URL('../web-webgpu-probe/', import.meta.url));
const types = {'.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json'};
const port = Number(process.argv[2] ?? 8765);
http.createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const [base, rel] = url.startsWith('/probe/') ? [probe, url.slice(7)] : [fixture, url.slice(1)];
  const file = path.join(base, rel || 'index.html');
  if (!file.startsWith(base)) return res.writeHead(403).end();
  let body;
  try { body = await readFile(file); } catch { return res.writeHead(404).end(); }
  res.writeHead(200, {'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store'}).end(body);
}).listen(port, '127.0.0.1', () => console.log(`serving http://localhost:${port}/?expect=view`));
