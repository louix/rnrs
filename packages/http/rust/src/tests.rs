//! Native tests against an in-process HTTP/1.1 server that records what it observes per
//! connection (opened, requests, closed by the client), so abort and pooling behaviour is
//! checked rather than assumed.
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::*;
use spec::HttpModule as _;

/// Counters are process-wide: networked tests run one at a time so their deltas are exact.
fn serial() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Default)]
struct Log {
    opened: usize,
    closed: usize,
    requests: Vec<String>,
}

struct Server {
    base: String,
    log: Arc<Mutex<Log>>,
}

impl Server {
    async fn start() -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let log = Arc::new(Mutex::new(Log::default()));
        let l = log.clone();
        tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                l.lock().unwrap().opened += 1;
                tokio::spawn(connection(socket, l.clone()));
            }
        });
        Server { base, log }
    }
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
    fn log(&self) -> MutexGuard<'_, Log> {
        self.log.lock().unwrap()
    }
    /// Waits until the server has seen `n` connections closed by the client.
    async fn closed(&self, n: usize) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(3) {
            if self.log().closed >= n {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }
}

/// Serves requests on one connection until the client closes it (or a write fails).
async fn connection(mut socket: TcpStream, log: Arc<Mutex<Log>>) {
    let mut buffer = Vec::new();
    'requests: loop {
        let head_end = loop {
            if let Some(i) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
            let mut chunk = [0u8; 4096];
            match socket.read(&mut chunk).await {
                Ok(0) | Err(_) => break 'requests,
                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
            }
        };
        let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
        let length: usize = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap_or(0);
        while buffer.len() < head_end + length {
            let mut chunk = [0u8; 4096];
            match socket.read(&mut chunk).await {
                Ok(0) | Err(_) => break 'requests,
                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
            }
        }
        let body: Vec<u8> = buffer[head_end..head_end + length].to_vec();
        buffer.drain(..head_end + length);
        let line = head.lines().next().unwrap_or_default().to_string();
        log.lock().unwrap().requests.push(line.clone());
        let path = line.split(' ').nth(1).unwrap_or("/").to_string();
        if respond(&mut socket, &path, &head, &body).await.is_err() {
            break;
        }
    }
    log.lock().unwrap().closed += 1;
}

fn pattern(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i % 251) as u8).collect()
}

async fn respond(socket: &mut TcpStream, path: &str, head: &str, body: &[u8]) -> std::io::Result<()> {
    let fixed = |status: &str, headers: &str, body: &[u8]| {
        let mut out = format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\n{headers}\r\n", body.len()).into_bytes();
        out.extend_from_slice(body);
        out
    };
    let (segment, arg) = path.trim_start_matches('/').split_once('/').unwrap_or((path.trim_start_matches('/'), ""));
    match segment {
        "bytes" => socket.write_all(&fixed("200 OK", "x-test: yes\r\n", &pattern(arg.parse().unwrap()))).await,
        "status" => socket.write_all(&fixed(&format!("{arg} Whatever"), "", b"status body")).await,
        "echo" => {
            let method = head.split(' ').next().unwrap_or_default();
            let header = head.lines().find_map(|l| l.strip_prefix("x-echo: ")).unwrap_or("-");
            let mut out = format!("{method} {header} ").into_bytes();
            out.extend_from_slice(body);
            socket.write_all(&fixed("200 OK", "", &out)).await
        }
        // Content-Length of a large resource; a HEAD response has no body.
        "huge" => {
            socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 1000000000000\r\n\r\n").await?;
            if head.starts_with("HEAD ") { Ok(()) } else { socket.shutdown().await.and(Err(std::io::Error::other("no body sent"))) }
        }
        "redirect" => socket.write_all(&fixed("302 Found", "location: /bytes/3\r\n", b"")).await,
        // Waits before the headers, noticing at once if the client closes meanwhile.
        "slow-headers" => {
            let mut probe = [0u8; 1];
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(arg.parse().unwrap())) => socket.write_all(&fixed("200 OK", "", b"late")).await,
                _ = socket.read(&mut probe) => Err(std::io::Error::other("client closed while waiting")),
            }
        }
        // Chunked body without a length: `arg` chunks of 1000 bytes, 20 ms apart ("forever"
        // for an endless stream).
        "drip" => {
            socket.write_all(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n").await?;
            let count: usize = if arg == "forever" { usize::MAX } else { arg.parse().unwrap() };
            for _ in 0..count {
                socket.write_all(format!("{:x}\r\n", 1000).as_bytes()).await?;
                socket.write_all(&pattern(1000)).await?;
                socket.write_all(b"\r\n").await?;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            socket.write_all(b"0\r\n\r\n").await
        }
        // Headers promise more bytes than are sent, then the connection is cut.
        "truncated" => {
            socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\nshort").await?;
            socket.shutdown().await?;
            Err(std::io::Error::other("cut"))
        }
        _ => socket.write_all(&fixed("404 Not Found", "", b"")).await,
    }
}

fn get(url: String) -> HttpRequest {
    HttpRequest { url, method: None, headers: None, body: None, timeout_ms: None, max_bytes: None }
}

#[tokio::test(flavor = "multi_thread")]
async fn responses_statuses_headers_redirects_and_bodies() {
    let _serial = serial();
    let server = Server::start().await;
    let http = Http::default();
    let r = http.fetch(get(server.url("/bytes/70000")), CancelToken::new()).await.unwrap();
    assert_eq!((r.status, r.body.clone()), (200.0, pattern(70000)));
    assert!(r.headers.contains(&Header { name: "x-test".into(), value: "yes".into() }));
    let r = http.fetch(get(server.url("/status/503")), CancelToken::new()).await.unwrap();
    assert_eq!((r.status, r.body.as_slice()), (503.0, &b"status body"[..]));
    let r = http.fetch(get(server.url("/redirect")), CancelToken::new()).await.unwrap();
    assert_eq!((r.url, r.body), (server.url("/bytes/3"), pattern(3)));
    let r = http.fetch(get(server.url("/bytes/0")), CancelToken::new()).await.unwrap();
    assert!(r.body.is_empty());
    let mut post = get(server.url("/echo"));
    post.method = Some("POST".into());
    post.headers = Some(vec![Header { name: "x-echo".into(), value: "hi".into() }]);
    post.body = Some(b"payload".to_vec());
    let r = http.fetch(post, CancelToken::new()).await.unwrap();
    assert_eq!(String::from_utf8(r.body).unwrap(), "POST hi payload");
}

#[tokio::test(flavor = "multi_thread")]
async fn max_bytes_is_enforced_from_the_length_and_while_streaming() {
    let _serial = serial();
    let server = Server::start().await;
    let http = Http::default();
    let limited = |path: &str, max: f64| HttpRequest { max_bytes: Some(max), ..get(server.url(path)) };
    assert_eq!(http.fetch(limited("/bytes/1000", 1000.0), CancelToken::new()).await.unwrap().body.len(), 1000);
    let e = http.fetch(limited("/bytes/1001", 1000.0), CancelToken::new()).await.unwrap_err();
    assert_eq!(e, "too-large: the response body exceeds maxBytes (1000 bytes)");
    // No length: the read stops at the first chunk over the limit, long before the end.
    let start = Instant::now();
    let e = http.fetch(limited("/drip/forever", 2500.0), CancelToken::new()).await.unwrap_err();
    assert!(e.starts_with("too-large:"), "{e}");
    assert!(start.elapsed() < Duration::from_secs(2));
    assert!(server.closed(1).await, "the server saw the oversized stream's connection closed");
    assert_eq!(http.fetch(limited("/bytes/0", 0.0), CancelToken::new()).await.unwrap().body.len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn timeouts_cover_headers_and_body_and_close_the_connection() {
    let _serial = serial();
    let server = Server::start().await;
    let http = Http::default();
    let start = Instant::now();
    let e = http.fetch(HttpRequest { timeout_ms: Some(100.0), ..get(server.url("/slow-headers/3000")) }, CancelToken::new()).await.unwrap_err();
    assert_eq!(e, "timeout: no complete response within 100 ms");
    assert!(start.elapsed() < Duration::from_secs(2));
    let e = http.fetch(HttpRequest { timeout_ms: Some(150.0), ..get(server.url("/drip/forever")) }, CancelToken::new()).await.unwrap_err();
    assert!(e.starts_with("timeout:"), "{e}");
    assert!(server.closed(2).await, "both timed-out connections were closed by the client");
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_drops_the_request_closes_its_connection_and_frees_its_buffer() {
    let _serial = serial();
    let server = Server::start().await;
    let http = Arc::new(Http::default());
    let before = diagnostics();
    let cancel = CancelToken::new();
    let task = {
        let (http, cancel, url) = (http.clone(), cancel.clone(), server.url("/drip/forever"));
        tokio::spawn(async move { http.fetch(get(url), cancel).await })
    };
    // Wait until the body is streaming and buffered.
    let start = Instant::now();
    while diagnostics().buffered_bytes - before.buffered_bytes < 3000.0 {
        assert!(start.elapsed() < Duration::from_secs(3), "body never started");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(diagnostics().active - before.active, 1.0);
    cancel.cancel();
    assert_eq!(task.await.unwrap().unwrap_err(), "cancelled");
    let after = diagnostics();
    assert_eq!((after.active, after.buffered_bytes), (before.active, before.buffered_bytes));
    assert_eq!(after.dropped_early - before.dropped_early, 1.0);
    assert!(server.closed(1).await, "the server saw the cancelled response's connection closed");
}

#[tokio::test(flavor = "multi_thread")]
async fn completed_responses_reuse_a_pooled_connection_and_aborted_ones_do_not() {
    let _serial = serial();
    let server = Server::start().await;
    let http = Http::default();
    for _ in 0..3 {
        http.fetch(get(server.url("/bytes/10")), CancelToken::new()).await.unwrap();
    }
    let (opened, closed) = { let log = server.log(); (log.opened, log.closed) };
    assert_eq!((opened, closed), (1, 0), "three complete responses, one kept-alive connection");
    // A response abandoned mid-body is not returned to the pool: the next request opens a
    // new connection, and the abandoned one is closed.
    let e = http.fetch(HttpRequest { max_bytes: Some(1500.0), ..get(server.url("/drip/50")) }, CancelToken::new()).await.unwrap_err();
    assert!(e.starts_with("too-large:"));
    http.fetch(get(server.url("/bytes/10")), CancelToken::new()).await.unwrap();
    assert!(server.closed(1).await);
    assert_eq!(server.log().opened, 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn transport_errors_are_classified() {
    let _serial = serial();
    let server = Server::start().await;
    let http = Http::default();
    let e = http.fetch(get(server.url("/truncated")), CancelToken::new()).await.unwrap_err();
    assert!(e.starts_with("body:") || e.starts_with("network:"), "{e}");
    // A port with no listener.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    let e = http.fetch(get(format!("http://{closed}/")), CancelToken::new()).await.unwrap_err();
    assert!(e.starts_with("connect:"), "{e}");
}

#[test]
fn requests_are_validated_before_admission() {
    let http = Http::default();
    let check = |r: HttpRequest| spec::HttpModule::validate_fetch(&http, &r).unwrap_err();
    let base = || get("http://127.0.0.1:1/".into());
    assert!(check(get("ftp://x/".into())).starts_with("invalid: url scheme must be http or https"));
    assert!(check(get("not a url".into())).starts_with("invalid: url"));
    assert!(check(HttpRequest { method: Some("TRACE".into()), ..base() }).starts_with("invalid: method must be one of GET"));
    assert!(check(HttpRequest { method: Some("get".into()), ..base() }).starts_with("invalid: method"));
    assert!(check(HttpRequest { headers: Some(vec![Header { name: "bad name".into(), value: "v".into() }]), ..base() }).contains("headers[0].name"));
    assert!(check(HttpRequest { headers: Some(vec![Header { name: "x".into(), value: "a\nb".into() }]), ..base() }).contains("headers[0].value"));
    assert!(check(HttpRequest { body: Some(vec![1]), ..base() }).contains("GET request cannot have a body"));
    for bad in [0.0, 1.5, -1.0, 300_001.0, f64::NAN, f64::INFINITY] {
        assert_eq!(check(HttpRequest { timeout_ms: Some(bad), ..base() }), "invalid: timeoutMs must be an integer from 1 to 300000");
    }
    for bad in [-1.0, 0.5, MAX_MAX_BYTES + 1.0] {
        assert_eq!(check(HttpRequest { max_bytes: Some(bad), ..base() }), "invalid: maxBytes must be an integer from 0 to 67108864");
    }
    assert!(spec::HttpModule::validate_fetch(&http, &HttpRequest { timeout_ms: Some(300_000.0), max_bytes: Some(0.0), ..base() }).is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn head_responses_are_not_prechecked_by_content_length() {
    let _serial = serial();
    let server = Server::start().await;
    let http = Http::default();
    let head = HttpRequest { method: Some("HEAD".into()), max_bytes: Some(0.0), ..get(server.url("/huge")) };
    let r = http.fetch(head, CancelToken::new()).await.unwrap();
    assert_eq!((r.status, r.body.len()), (200.0, 0));
    assert!(r.headers.contains(&Header { name: "content-length".into(), value: "1000000000000".into() }));
    // A GET with the same header is still refused before reading.
    let e = http.fetch(HttpRequest { max_bytes: Some(0.0), ..get(server.url("/huge")) }, CancelToken::new()).await.unwrap_err();
    assert_eq!(e, "too-large: the response body exceeds maxBytes (0 bytes)");
}

#[test]
fn transport_controlled_headers_are_rejected() {
    let http = Http::default();
    for name in ["Host", "content-length", "Transfer-Encoding", "Connection", "keep-alive", "Upgrade", "TE", "Trailer", "Expect", "Proxy-Authorization", "proxy-anything"] {
        let r = HttpRequest { headers: Some(vec![Header { name: name.into(), value: "x".into() }]), ..get("http://127.0.0.1:1/".into()) };
        let e = spec::HttpModule::validate_fetch(&http, &r).unwrap_err();
        assert!(e.contains("is controlled by the transport and cannot be set"), "{name}: {e}");
    }
    let ok = HttpRequest { headers: Some(vec![Header { name: "Authorization".into(), value: "Bearer x".into() }, Header { name: "Cookie".into(), value: "a=b".into() }]), ..get("http://127.0.0.1:1/".into()) };
    assert!(spec::HttpModule::validate_fetch(&http, &ok).is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn failures_before_sending_are_not_counted_as_dropped() {
    let _serial = serial();
    let http = Http::default();
    let before = diagnostics();
    let e = http.fetch(get("ftp://x/".into()), CancelToken::new()).await.unwrap_err();
    assert!(e.starts_with("invalid:"));
    let after = diagnostics();
    assert_eq!((after.started, after.dropped_early, after.active), (before.started, before.dropped_early, before.active));
}
