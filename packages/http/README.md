# HTTP example

`@rnrs/example-http` wraps [reqwest](https://docs.rs/reqwest/) in an async HTTP
module. Runs on Android, iOS and in the browser.

```ts
import { httpModule } from '@rnrs/example-http';

const response = await httpModule().fetch({
  url: 'https://example.com/',
  timeoutMs: 10_000,
  maxBytes: 1024 * 1024,
});

console.log(response.status, response.body.byteLength);
```

Requests accept an optional method, headers and an `ArrayBuffer` body. Responses
contain `status`, the final `url`, headers and an `ArrayBuffer` body. HTTP error
statuses such as 404 resolve normally.

- `timeoutMs` covers the whole request: 1–300,000 ms, default 30,000.
- `maxBytes` bounds the buffered response: 0–64 MiB, default 8 MiB. There is no streaming API.
- Pass `{ signal: controller.signal }` as the second argument to `fetch` to cancel with an `AbortController`. Cancellation rejects with `AbortError`.
- Invalid inputs reject with `RangeError`. Request errors use prefixes such as `timeout:`, `too-large:` and `network:`.

Browsers use Fetch and enforce CORS and browser header restrictions. Native requests
use rustls with bundled Mozilla certificate roots; device-installed certificates and
OS proxy settings are not used. On iOS, ATS settings do not apply; LAN access needs
`NSLocalNetworkUsageDescription` and the user's permission.

## How it works

- `HttpRequest` and `HttpResponse` become Rust structs; buffer fields become `Vec<u8>`. The module reuses one reqwest client per JavaScript runtime.
- `validate_fetch` checks the request before async work starts. The Rust `fetch` method reads the response in chunks and enforces `maxBytes`.
- The request races a timer and a `CancelToken`. A timeout or cancellation drops the pending reqwest future; the generated wrapper resolves or rejects the JavaScript promise.

See the [spec](http.spec.ts) and [Rust implementation](rust/src/lib.rs).
Start with the [quickstart](../../docs/quickstart.md) for setup.
