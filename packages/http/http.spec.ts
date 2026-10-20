// HTTP for React Native (Android, iOS) and the browser: the TypeScript contract. The Rust
// implementation in rust/ uses reqwest: natively on the framework's Tokio runtime with
// rustls and the bundled webpki root certificates, in the browser over fetch.
import type { NativeModule } from '@rnrs/runtime/spec';

export interface Header {
  name: string;
  value: string;
}

export interface HttpRequest {
  /** http or https URL. */
  url: string;
  /** GET (default), HEAD, POST, PUT, PATCH, DELETE or OPTIONS. */
  method?: string;
  headers?: Header[];
  body?: ArrayBuffer;
  /** Whole-request deadline (connect, headers and body) in ms: an integer from 1 to
   *  300000; default 30000. */
  timeoutMs?: number;
  /** Largest accepted response body in bytes: an integer from 0 to 67108864; default
   *  8388608. Bodies are read incrementally and the request fails as soon as more arrives. */
  maxBytes?: number;
}

export interface HttpResponse {
  /** Any status, including 4xx and 5xx (they are responses, not errors). */
  status: number;
  /** The final URL after redirects. */
  url: string;
  headers: Header[];
  body: ArrayBuffer;
}

/** Process-wide counters (diagnostics and tests). */
export interface HttpDiagnostics {
  /** Requests being sent or received (counted once the request is checked and the client
   *  exists, until its future ends). */
  active: number;
  /** Requests that reached that point (failures before it are not counted). */
  started: number;
  /** Of those, the ones cancelled or dropped (teardown) before producing a result; errors
   *  such as timeouts are results. */
  droppedEarly: number;
  /** Response bytes currently buffered by active requests. */
  bufferedBytes: number;
}

/** Errors reject with an Error whose message starts with a code:
 *  "timeout:", "too-large:", "connect:", "invalid:", "network:" or "body:".
 *  Cancellation (AbortSignal) rejects with AbortError. */
export interface HttpModule extends NativeModule {
  fetch(request: HttpRequest): Promise<HttpResponse>;
  diagnostics(): HttpDiagnostics;
}
