# `@rnrs/example-http`: reqwest on Android, iOS and in the browser

Experimental, 2026-10-19. An author package like `@rnrs/example-blake3`: a TS spec (`packages/http/http.spec.ts`), a Rust crate wrapping reqwest 0.12, and the generated, committed interface. It has no platform code. Targets: `android`, `ios` and `web`. iOS runs the same native code as Android: the crate has no iOS-specific branch (see [iOS](#ios)).

## Contract

`httpModule().fetch({url, method?, headers?, body?, timeoutMs?, maxBytes?}, {signal?})` resolves to `{status, url, headers, body: ArrayBuffer}`.

- Any HTTP status is a response, not an error. `url` is the final URL after redirects.
- **Validation** runs before admission, on the JS thread, and rejects with RangeError (`invalid: …`). Nothing is sent. It checks:
  - http/https URLs;
  - methods GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS;
  - header names and values;
  - no body on GET or HEAD;
  - `timeoutMs` an integer from 1 to 300000 (default 30000);
  - `maxBytes` an integer from 0 to 64 MiB (default 8 MiB).
- **Bounded body:** a declared `content-length` over `maxBytes` fails before the body is read. Otherwise the body is read chunk by chunk and the request fails at the first chunk past the limit (`too-large: …`). The whole body is buffered: there is no streaming API to JS.
- **Deadline:** `timeoutMs` covers connect, headers and body (`timeout: no complete response within N ms`). It is the module's own timer, the same on both targets.
- **Cancellation:** an aborted signal rejects with AbortError. Errors are prefixed `timeout:`, `too-large:`, `connect:` (native only), `network:`, `body:` or `invalid:`.
- **Diagnostics:** `diagnostics()` returns process-wide counters: `active` request futures, `started`, `droppedEarly` (cancelled or dropped mid-way) and `bufferedBytes`.

Every request races its work against the deadline and the cancellation token. The loser is dropped, which drops reqwest's future.

## Native vs browser

| | Android and iOS (native) | Browser (Wasm) |
| --- | --- | --- |
| Transport | reqwest + hyper on the framework's Tokio runtime (HTTP/1.1, HTTP/2 via ALPN) | reqwest's fetch backend: the browser's `fetch`, browser-local futures, no Tokio |
| TLS trust | rustls with the bundled webpki (Mozilla) roots only. **User-installed, device, MDM and OS CAs are not trusted** (Android user CAs; iOS configuration-profile roots). A platform verifier would need framework init and is not implemented. No revocation (OCSP/CRL) checking. | The browser's trust store and policies |
| CORS | None | Applies: a response without CORS headers is a `network:` error |
| Abort | Dropping the future drops the hyper request | reqwest's AbortController aborts the fetch when its future or response is dropped |
| Refused connection | `connect: …` | `network: …` (fetch reports a TypeError) |
| Proxy | No OS proxy integration: reqwest is built without its `system-proxy` feature, so Android and iOS proxy settings (including PAC) are ignored; VPNs work at the IP layer. reqwest does honour the process's `ALL_PROXY`/`HTTPS_PROXY`/`HTTP_PROXY` (and `NO_PROXY`) environment variables, because the client does not call `no_proxy()`. Apps normally have none set; a launch environment that sets them would route requests through that proxy. No runtime policy is changed for this. | The browser's |
| Headers | As sent | The browser may drop or override forbidden headers (Host, Cookie, …) |

## Lifecycle

The lab runner streams an endless response, then reloads React Native. In the next runtime the process-wide counters show `active` 0, `bufferedBytes` 0 and `droppedEarly` +1, and the server saw the connection closed by the client. The old runtime's promise never settles: late results are discarded with the runtime. Teardown cancels the operation, as for any module.

## iOS

- **Same code:** reqwest + hyper + rustls (ring) on the framework's binding-owned Tokio runtime, built for `aarch64-apple-ios` (device) and `aarch64-apple-ios-sim`/`x86_64-apple-ios` (simulator, build only). Trust, timeouts, bounds and cancellation are as on Android. Cancellation is not tied to the platform: dropping the future closes the socket.
- **Not URLSession:** connections are BSD sockets opened by hyper. App Transport Security therefore does not apply, in either direction: plain `http://` is not blocked, and the app's ATS exceptions or pinning settings have no effect. Nor do URLSession features such as the system proxy, cellular/expensive-network policies, or background transfers.
- **Local Network privacy (iOS 14+):** a connection to a LAN or link-local address fails with `connect: … No route to host (os error 65)` until the user allows the app's Local Network access. The prompt appeared only once the app declared `NSLocalNetworkUsageDescription`; without the key there was no prompt and no Settings entry (observed on iOS 26.7.1). This is app configuration, like any Info.plist permission string; the framework does not add it. Loopback (`127.0.0.1` on the phone) and internet addresses are not gated.
- **Backgrounding:** a request in flight when iOS suspends the app is not tested. Its socket may be torn down by the system and surface as a `network:`, `body:` or `timeout:` error. How the module's deadline behaves across a suspension is not tested either.

## Limits

- Bodies are buffered whole (up to 64 MiB); there is no streaming to JS, upload progress or WebSocket.
- **wasm-bindgen glue:** the browser path converts response headers with `JSON.stringify` and `expect_throw` inside reqwest's wasm backend. This is the same class of dynamic built-in lookup as the rest of the wasm-bindgen glue: a monkey-patched built-in can break it, and a panic there aborts the Wasm instance (`panic = "abort"`).
- **Native DNS:** name resolution uses reqwest's default resolver (the system `getaddrinfo` on Tokio's blocking pool). A cancelled or timed-out request returns at once, but its lookup can keep running until the system call returns. It shares the blocking pool with other modules (for example kv's disk jobs) outside this module's admission bound. The tests use IP literals.
- **Request headers:** transport-controlled headers are rejected on both targets: Host, Content-Length, Transfer-Encoding, Connection, Keep-Alive, Upgrade, TE, Trailer, Expect, HTTP2-Settings and Proxy-*. Other headers are sent natively as given. Browsers additionally drop or override their forbidden headers (Cookie, Origin, Referer, …) silently. That difference is not reconciled; no parity is claimed.
- **HEAD:** the response's Content-Length describes the resource, so HEAD is not prechecked against `maxBytes`. This is tested with a 10^12 length and `maxBytes: 0`.
- No cookies, proxies or client certificates. Redirects follow reqwest/fetch defaults (up to 10 natively).
- HTTPS on Android was not exercised: the Android and browser tests use only local servers and generate no external traffic. On iOS, one untrusted local certificate was exercised on the local link, and one public endpoint over the internet (`https://www.apple.com/library/test/success.html`: a DNS lookup and a GET, no data sent; skipped with `--no-public-https`). That public check is the only external traffic of any test here.
- Not tested on any target: certificate expiry or hostname mismatch, user-installed or profile CAs (by construction they are not trusted), HTTP/2 to any server (the local servers are HTTP/1.1; whether the public endpoint used HTTP/2 was not recorded), IPv6, and requests across app suspension.
