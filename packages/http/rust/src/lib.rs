//! Implementation of the HTTP spec (../http.spec.ts) over reqwest. Plain Rust: natively
//! reqwest runs on the framework's Tokio runtime (rustls, bundled webpki roots); on Wasm it
//! is reqwest's fetch backend. No JS, JSI or platform code.
//!
//! Every request races three things: the request itself (headers, then the body read chunk
//! by chunk against `maxBytes`), its deadline, and the operation's cancellation. Whichever
//! loses is dropped, which drops reqwest's future: natively the connection of an unfinished
//! response is not returned to the pool; in the browser reqwest's AbortController aborts the
//! fetch. (What the server observes is checked by the integration tests, not assumed.)
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::future::{select, Either};
use rnr_core::CancelToken;

pub mod rnr_interface;
use rnr_interface as spec;
pub use spec::{Header, HttpDiagnostics, HttpRequest, HttpResponse};

pub const DEFAULT_TIMEOUT_MS: f64 = 30_000.0;
pub const MAX_TIMEOUT_MS: f64 = 300_000.0;
pub const DEFAULT_MAX_BYTES: f64 = 8.0 * 1024.0 * 1024.0;
pub const MAX_MAX_BYTES: f64 = 64.0 * 1024.0 * 1024.0;
const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
/// Headers the transport controls (framing, connection management, routing). Setting them
/// could desynchronize framing or the connection pool, so they are rejected on every target.
/// Browsers additionally drop or override their own forbidden headers (Cookie, Origin,
/// Referer, ...) silently; this list does not try to reproduce that.
const TRANSPORT_HEADERS: &[&str] = &[
    "host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer", "expect",
    "proxy-connection", "proxy-authorization", "http2-settings",
];

/// The module: one shared client (connection pool) per JS runtime.
pub struct Http {
    client: Result<reqwest::Client, String>,
}

impl Default for Http {
    fn default() -> Self {
        let builder = reqwest::Client::builder();
        #[cfg(not(target_arch = "wasm32"))]
        let builder = builder.pool_idle_timeout(Duration::from_secs(30));
        Http { client: builder.build().map_err(|e| format!("network: cannot create the HTTP client: {}", chain(&e))) }
    }
}

// ---- diagnostics ---------------------------------------------------------------------

static ACTIVE: AtomicU64 = AtomicU64::new(0);
static STARTED: AtomicU64 = AtomicU64::new(0);
static DROPPED_EARLY: AtomicU64 = AtomicU64::new(0);
static BUFFERED: AtomicU64 = AtomicU64::new(0);

/// Lives as long as one request's future; counts it and the bytes it buffers.
struct Active {
    buffered: u64,
    finished: bool,
}

impl Active {
    fn new() -> Self {
        STARTED.fetch_add(1, Ordering::SeqCst);
        ACTIVE.fetch_add(1, Ordering::SeqCst);
        Active { buffered: 0, finished: false }
    }
    fn buffer(&mut self, n: usize) {
        self.buffered += n as u64;
        BUFFERED.fetch_add(n as u64, Ordering::SeqCst);
    }
}

impl Drop for Active {
    fn drop(&mut self) {
        BUFFERED.fetch_sub(self.buffered, Ordering::SeqCst);
        ACTIVE.fetch_sub(1, Ordering::SeqCst);
        if !self.finished {
            DROPPED_EARLY.fetch_add(1, Ordering::SeqCst);
        }
    }
}

pub fn diagnostics() -> HttpDiagnostics {
    HttpDiagnostics {
        active: ACTIVE.load(Ordering::SeqCst) as f64,
        started: STARTED.load(Ordering::SeqCst) as f64,
        dropped_early: DROPPED_EARLY.load(Ordering::SeqCst) as f64,
        buffered_bytes: BUFFERED.load(Ordering::SeqCst) as f64,
    }
}

// ---- validation ----------------------------------------------------------------------

fn integer_in(value: Option<f64>, default: f64, max: f64, min: f64, what: &str) -> Result<f64, String> {
    let v = value.unwrap_or(default);
    if v.is_finite() && v.fract() == 0.0 && (min..=max).contains(&v) {
        Ok(v)
    } else {
        Err(format!("invalid: {what} must be an integer from {min} to {max}"))
    }
}

/// A checked request, ready to send.
struct Plan {
    method: reqwest::Method,
    url: reqwest::Url,
    headers: reqwest::header::HeaderMap,
    body: Option<Vec<u8>>,
    timeout: Duration,
    max_bytes: u64,
}

/// Validates without copying the body (used on the JS thread before admission); `plan`
/// then takes the request by value.
fn check(request: &HttpRequest) -> Result<Plan, String> {
    let url = reqwest::Url::parse(&request.url).map_err(|e| format!("invalid: url {:?}: {e}", request.url))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("invalid: url scheme must be http or https, got {:?}", url.scheme()));
    }
    let method = request.method.as_deref().unwrap_or("GET");
    if !METHODS.contains(&method) {
        return Err(format!("invalid: method must be one of {}, got {method:?}", METHODS.join(", ")));
    }
    let mut headers = reqwest::header::HeaderMap::new();
    for (i, h) in request.headers.iter().flatten().enumerate() {
        let name = reqwest::header::HeaderName::from_bytes(h.name.as_bytes()).map_err(|_| format!("invalid: headers[{i}].name {:?} is not a header name", h.name))?;
        if TRANSPORT_HEADERS.contains(&name.as_str()) || name.as_str().starts_with("proxy-") {
            return Err(format!("invalid: headers[{i}] {:?} is controlled by the transport and cannot be set", h.name));
        }
        let value = reqwest::header::HeaderValue::from_str(&h.value).map_err(|_| format!("invalid: headers[{i}].value is not a valid header value"))?;
        headers.append(name, value);
    }
    if request.body.is_some() && matches!(method, "GET" | "HEAD") {
        return Err(format!("invalid: a {method} request cannot have a body"));
    }
    let timeout = integer_in(request.timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 1.0, "timeoutMs")?;
    let max_bytes = integer_in(request.max_bytes, DEFAULT_MAX_BYTES, MAX_MAX_BYTES, 0.0, "maxBytes")?;
    Ok(Plan {
        method: method.parse().expect("listed methods parse"),
        url,
        headers,
        body: None,
        timeout: Duration::from_millis(timeout as u64),
        max_bytes: max_bytes as u64,
    })
}

// ---- errors --------------------------------------------------------------------------

fn chain(error: &dyn std::error::Error) -> String {
    let mut out = error.to_string();
    let mut source = error.source();
    while let Some(s) = source {
        let text = s.to_string();
        if !out.contains(&text) {
            out.push_str(": ");
            out.push_str(&text);
        }
        source = s.source();
    }
    out
}

fn classify(error: reqwest::Error) -> String {
    let code = if error.is_timeout() {
        "timeout"
    } else if error.is_builder() {
        "invalid"
    } else if error.is_body() || error.is_decode() {
        "body"
    } else {
        #[cfg(not(target_arch = "wasm32"))]
        if error.is_connect() {
            return format!("connect: {}", chain(&error));
        }
        "network"
    };
    format!("{code}: {}", chain(&error))
}

// ---- the request ---------------------------------------------------------------------

#[cfg(not(target_arch = "wasm32"))]
async fn sleep(d: Duration) {
    tokio::time::sleep(d).await
}

#[cfg(target_arch = "wasm32")]
async fn sleep(d: Duration) {
    gloo_timers::future::sleep(d).await
}

async fn send(client: &reqwest::Client, plan: Plan, active: &mut Active) -> Result<HttpResponse, String> {
    let head = plan.method == reqwest::Method::HEAD;
    let mut builder = client.request(plan.method, plan.url).headers(plan.headers);
    if let Some(body) = plan.body {
        builder = builder.body(body);
    }
    let response = builder.send().await.map_err(classify)?;
    let status = response.status().as_u16() as f64;
    let url = response.url().to_string();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| Header { name: name.as_str().to_string(), value: String::from_utf8_lossy(value.as_bytes()).into_owned() })
        .collect();
    let max = plan.max_bytes;
    let too_large = || format!("too-large: the response body exceeds maxBytes ({max} bytes)");
    // A HEAD response's Content-Length describes the resource, not a body (there is none),
    // so only real bodies are prechecked; every body is still bounded chunk by chunk below.
    if !head && response.content_length().is_some_and(|n| n > max) {
        return Err(too_large());
    }
    let mut body = Vec::new();
    let mut push = |chunk: &[u8], active: &mut Active| -> Result<(), String> {
        if (body.len() + chunk.len()) as u64 > max {
            return Err(too_large());
        }
        body.try_reserve(chunk.len()).map_err(|_| "body: out of memory buffering the response".to_string())?;
        body.extend_from_slice(chunk);
        active.buffer(chunk.len());
        Ok(())
    };
    #[cfg(not(target_arch = "wasm32"))]
    {
        let mut response = response;
        while let Some(chunk) = response.chunk().await.map_err(classify)? {
            push(&chunk, active)?;
        }
    }
    #[cfg(target_arch = "wasm32")]
    {
        use futures_util::StreamExt;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            push(&chunk.map_err(classify)?, active)?;
        }
    }
    Ok(HttpResponse { status, url, headers, body })
}

impl spec::HttpModule for Http {
    fn validate_fetch(&self, request: &HttpRequest) -> Result<(), String> {
        check(request).map(drop)
    }

    async fn fetch(&self, request: HttpRequest, cancel: CancelToken) -> Result<HttpResponse, String> {
        let client = self.client.as_ref().map_err(Clone::clone)?;
        let mut plan = check(&request)?;
        plan.body = request.body; // moved, not copied
        // Counted from here: failures before this point are not "dropped early".
        let mut active = Active::new();
        let timeout = plan.timeout;
        let result = {
            let work = std::pin::pin!(send(client, plan, &mut active));
            let deadline = std::pin::pin!(sleep(timeout));
            let cancelled = std::pin::pin!(cancel.cancelled());
            match select(work, select(deadline, cancelled)).await {
                Either::Left((result, _)) => result,
                Either::Right((Either::Left(_), _)) => Err(format!("timeout: no complete response within {} ms", timeout.as_millis())),
                Either::Right((Either::Right(_), _)) => Err("cancelled".into()),
            }
            // The losing futures (including reqwest's) are dropped here.
        };
        // An error is a result too; only cancellation (and a future dropped mid-way) counts
        // as dropped early.
        active.finished = !matches!(&result, Err(e) if e == "cancelled");
        result
    }

    fn diagnostics(&self) -> Result<HttpDiagnostics, String> {
        Ok(diagnostics())
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
