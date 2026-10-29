// Async HTTP requests with reqwest on Android, iOS and the browser.
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
  /** Whole-request timeout in ms: 1–300000; default 30000. */
  timeoutMs?: number;
  /** Response size limit in bytes: 0–67108864; default 8388608 (8 MiB). */
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

/** Request counters shared across runtimes. */
export interface HttpDiagnostics {
  /** Validated requests currently being sent or received. */
  active: number;
  /** Total requests started after validation and client setup. */
  started: number;
  /** Started requests cancelled or dropped before a result; timeouts count as results. */
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
