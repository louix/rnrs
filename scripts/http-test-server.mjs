// Local, deterministic HTTP server for the @rnrs/example-http integration tests (device through
// `adb reverse`, browser cross-origin). It records, per TCP connection, the requests served
// and whether the client closed the connection, so tests check observed abort and pooling
// behaviour. Never contacts anything else.
//
// Endpoints (CORS-enabled unless noted):
//   /bytes/N              N bytes (i % 251), content-length, header x-test: yes
//   /status/N             status N with a short body
//   /echo                 "<METHOD> <x-echo header> <body>"
//   /redirect             302 to /bytes/3
//   /huge                 content-length 10^12 (a large resource): HEAD gets no body; GET
//                         gets the headers and the connection is closed
//   /slow-headers/MS      headers after MS ms
//   /drip/N | /drip/forever   chunked, 1000-byte chunks every 20 ms
//   /truncated            content-length 100, 5 bytes, then the connection is destroyed
//   /nocors/bytes/N       like /bytes/N without CORS headers
//   /__log                JSON {connections: [{id, requests, closedByClient, open}]}
//   /__reset              clears the log
// Usage: node scripts/http-test-server.mjs [port]   (default 8787; prints "listening <port>")
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Listens on `host` (loopback by default; the iOS runner passes the Mac's LAN address). */
export function startServer(port = 8787, host = '127.0.0.1') {
  let nextId = 1;
  let connections = new Map();
  const server = http.createServer((req, res) => {
    const conn = connections.get(req.socket.rnrsId);
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (!path.startsWith('/__')) conn?.requests.push(`${req.method} ${path}${url.search}`);
    const cors = !path.startsWith('/nocors/');
    const headers = cors
      ? {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-expose-headers': 'x-test',
        }
      : {};
    if (req.method === 'OPTIONS' && cors) return res.writeHead(204, headers).end();
    const [, segment, arg] = path.replace(/^\/nocors/, '').split('/');
    const pattern = (n) => Buffer.from(Array.from({ length: n }, (_, i) => i % 251));
    const body = [];
    req.on('data', (chunk) => body.push(chunk));
    req.on('end', () => {
      switch (segment) {
        case '__log':
          return res
            .writeHead(200, { ...headers, 'content-type': 'application/json' })
            .end(JSON.stringify({ connections: [...connections.values()] }));
        case '__reset':
          for (const [id, c] of connections) if (!c.open) connections.delete(id);
          for (const c of connections.values())
            c.requests = c.requests.filter((r) => r.startsWith('GET /__'));
          return res.writeHead(200, headers).end('ok');
        case 'bytes': {
          const data = pattern(Number(arg));
          return res
            .writeHead(200, { ...headers, 'content-length': data.length, 'x-test': 'yes' })
            .end(data);
        }
        case 'status':
          return res.writeHead(Number(arg), headers).end('status body');
        case 'echo':
          return res
            .writeHead(200, headers)
            .end(
              Buffer.concat([
                Buffer.from(`${req.method} ${req.headers['x-echo'] ?? '-'} `),
                ...body,
              ]),
            );
        case 'huge':
          res.writeHead(200, { ...headers, 'content-length': 1e12 });
          if (req.method === 'HEAD') return res.end();
          res.flushHeaders(); // headers now, then cut the connection without a body
          return setTimeout(() => req.socket.destroy(), 20);
        case 'redirect':
          return res.writeHead(302, { ...headers, location: '/bytes/3' }).end();
        case 'slow-headers': {
          const timer = setTimeout(() => res.writeHead(200, headers).end('late'), Number(arg));
          res.on('close', () => clearTimeout(timer));
          return;
        }
        case 'drip': {
          res.writeHead(200, headers);
          let left = arg === 'forever' ? Infinity : Number(arg);
          const timer = setInterval(() => {
            if (left-- <= 0) {
              clearInterval(timer);
              res.end();
              return;
            }
            res.write(pattern(1000));
          }, 20);
          res.on('close', () => clearInterval(timer));
          return;
        }
        case 'truncated':
          res.writeHead(200, { ...headers, 'content-length': 100 });
          res.write('short');
          return setTimeout(() => req.socket.destroy(), 20);
        default:
          return res.writeHead(404, headers).end();
      }
    });
  });
  server.on('connection', (socket) => {
    const id = nextId++;
    socket.rnrsId = id;
    const record = { id, requests: [], open: true, closedByClient: false };
    connections.set(id, record);
    socket.on('end', () => {
      record.closedByClient = true;
    }); // client sent FIN
    socket.on('error', () => {
      record.closedByClient = true;
    }); // reset by the client
    socket.on('close', () => {
      record.open = false;
    });
  });
  server.keepAliveTimeout = 60_000;
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const server = await startServer(Number(process.argv[2] ?? 8787));
  console.log(`listening ${server.address().port}`);
}
