//! Async sled storage in rnrs_core::platform::app_data_dir().
//! Disk work runs on Tokio's blocking pool; Native<Store> handles share each database.
//! Explicit flush() or close() persists completed writes. Cancellation cannot undo writes.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

use rnrs_core::{CancelToken, Native};

pub mod rnrs_interface;
use rnrs_interface as spec;
pub use spec::KvDiagnostics;

pub const MAX_KEYS: f64 = 10_000.0;
/// Bound sled's page cache to 16 MiB per database.
pub const CACHE_BYTES: u64 = 16 * 1024 * 1024;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Restrict names to keep databases inside the app's storage directory.
pub fn check_name(name: &str) -> Result<(), String> {
    let ok = (1..=64).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        && name.as_bytes()[0].is_ascii_alphanumeric();
    if ok {
        Ok(())
    } else {
        Err(format!("invalid: database name {name:?} must be 1 to 64 characters of a-z, 0-9, '-' and '_', starting with a letter or digit"))
    }
}

fn database_path(name: &str) -> Result<PathBuf, String> {
    check_name(name)?;
    Ok(rnrs_core::platform::app_data_dir()?.join("kv").join(name))
}

/// One open sled database, shared by all handles in the process.
struct Shared {
    name: String,
    db: Option<sled::Db>,
}

impl Shared {
    fn db(&self) -> &sled::Db {
        self.db.as_ref().expect("present until dropped")
    }
}

impl Drop for Shared {
    fn drop(&mut self) {
        // Runs on the closer thread or a blocking-pool thread (see `release`).
        #[cfg(test)]
        tests::record_release_thread(&self.name);
        if let Some(db) = self.db.take() {
            let _ = db.flush();
            drop(db); // releases sled's file lock
        }
        let mut registry = lock(registry());
        if matches!(registry.get(&self.name), Some(Slot::Open(weak)) if weak.strong_count() == 0) {
            registry.remove(&self.name);
        }
    }
}

enum Slot {
    /// Being opened or deleted: wait.
    Busy,
    /// Open; a dead `Weak` means the last release is still in progress: wait.
    Open(Weak<Shared>),
}

fn registry() -> &'static Mutex<HashMap<String, Slot>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Slot>>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

/// Hands a reference to the closer thread, so dropping it (possibly the last one, which
/// flushes) never runs on the caller's thread.
fn release(shared: Arc<Shared>) {
    static CLOSER: OnceLock<Mutex<mpsc::Sender<Arc<Shared>>>> = OnceLock::new();
    let sender = CLOSER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Arc<Shared>>();
        std::thread::Builder::new()
            .name("rnrs-kv-closer".into())
            .spawn(move || rx.into_iter().for_each(drop))
            .expect("spawn the rnrs-kv closer thread");
        Mutex::new(tx)
    });
    if let Err(mpsc::SendError(shared)) = lock(sender).send(shared) {
        // Unreachable (the thread never exits); keep the reference rather than flush here.
        std::mem::forget(shared);
    }
}

static HANDLES: AtomicU64 = AtomicU64::new(0);
static RUNNING: AtomicU64 = AtomicU64::new(0);

/// Runs `f` on Tokio's blocking pool and waits for it, even if the caller is cancelled.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    RUNNING.fetch_add(1, Ordering::SeqCst);
    let job = tokio::task::spawn_blocking(move || {
        let out = f();
        RUNNING.fetch_sub(1, Ordering::SeqCst);
        out
    });
    job.await.map_err(|e| format!("internal: blocking job failed: {e}"))?
}

fn sled_error(e: sled::Error) -> String {
    format!("storage: {e}")
}

/// Opens or shares database `name`. The blocking job itself records the result in the
/// registry, so a dropped caller cannot leave the name marked busy.
async fn open_shared(name: String) -> Result<Arc<Shared>, String> {
    let path = database_path(&name)?;
    for _ in 0..1000 {
        // Decide under the registry lock, act after releasing it (never held across awaits).
        let open_now = {
            let mut slots = lock(registry());
            match slots.get(&name) {
                Some(Slot::Open(weak)) => match weak.upgrade() {
                    Some(shared) => return Ok(shared),
                    None => false,
                },
                Some(Slot::Busy) => false,
                None => {
                    slots.insert(name.clone(), Slot::Busy);
                    true
                }
            }
        };
        if open_now {
            let (name, path) = (name.clone(), path.clone());
            return blocking(move || {
                // sled has no periodic flusher on Android or iOS; callers must flush explicitly.
                let opened = std::fs::create_dir_all(path.parent().expect("kv dir"))
                    .map_err(|e| format!("storage: cannot create {}: {e}", path.display()))
                    .and_then(|_| sled::Config::new().path(&path).cache_capacity(CACHE_BYTES).flush_every_ms(Some(500)).open().map_err(sled_error));
                let mut slots = lock(registry());
                match opened {
                    Ok(db) => {
                        let shared = Arc::new(Shared { name: name.clone(), db: Some(db) });
                        slots.insert(name, Slot::Open(Arc::downgrade(&shared)));
                        Ok(shared)
                    }
                    Err(e) => {
                        slots.remove(&name);
                        Err(e)
                    }
                }
            })
            .await;
        }
        // Opening, deleting, or the previous instance's last release in progress.
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Err(format!("busy: database {name:?} did not become available within 10 s"))
}

#[derive(Default)]
pub struct Kv;

pub fn diagnostics() -> KvDiagnostics {
    let open = lock(registry()).values().filter(|s| matches!(s, Slot::Open(w) if w.strong_count() > 0)).count();
    KvDiagnostics { open_databases: open as f64, handles: HANDLES.load(Ordering::SeqCst) as f64, running: RUNNING.load(Ordering::SeqCst) as f64 }
}

impl spec::KvModule for Kv {
    type StoreImpl = Store;

    fn validate_open(&self, name: &String) -> Result<(), String> {
        check_name(name)
    }

    async fn open(&self, name: String, _cancel: CancelToken) -> Result<Native<Store>, String> {
        let shared = open_shared(name).await?;
        Ok(Native::new(Store::new(shared)))
    }

    fn validate_delete_database(&self, name: &String) -> Result<(), String> {
        check_name(name)
    }

    async fn delete_database(&self, name: String, _cancel: CancelToken) -> Result<bool, String> {
        let path = database_path(&name)?;
        {
            let mut registry = lock(registry());
            if registry.contains_key(&name) {
                return Err(format!("busy: database {name:?} is open (or opening, or closing) in this process"));
            }
            registry.insert(name.clone(), Slot::Busy);
        }
        blocking(move || {
            let result = match std::fs::remove_dir_all(&path) {
                Ok(()) => Ok(true),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(format!("storage: cannot delete {}: {e}", path.display())),
            };
            lock(registry()).remove(&name);
            result
        })
        .await
    }

    fn diagnostics(&self) -> Result<KvDiagnostics, String> {
        Ok(diagnostics())
    }
}

/// One handle (JS `Store`). Operations hold the receiver (and so the handle) until done.
pub struct Store {
    /// Present while the handle accepts operations.
    shared: Mutex<Option<Arc<Shared>>>,
    /// Held by a started but unfinished close (so a retried close can finish the job).
    closing: Mutex<Option<Arc<Shared>>>,
    in_flight: Mutex<usize>,
    idle: tokio::sync::Notify,
    /// All close() callers share one result, including a flush failure.
    closed: tokio::sync::OnceCell<Result<(), String>>,
}

const CLOSED: &str = "closed: this Store handle was closed";

/// Counts one operation on a handle; `close` waits for all of them.
struct Op<'a>(&'a Store);

impl Drop for Op<'_> {
    fn drop(&mut self) {
        let mut n = lock(&self.0.in_flight);
        *n -= 1;
        if *n == 0 {
            self.0.idle.notify_waiters();
        }
    }
}

impl Store {
    fn new(shared: Arc<Shared>) -> Store {
        HANDLES.fetch_add(1, Ordering::SeqCst);
        Store {
            shared: Mutex::new(Some(shared)),
            closing: Mutex::new(None),
            in_flight: Mutex::new(0),
            idle: tokio::sync::Notify::new(),
            closed: tokio::sync::OnceCell::new(),
        }
    }

    /// The database for one operation, or `closed`.
    fn begin(&self) -> Result<(Op<'_>, Arc<Shared>), String> {
        // Counted under the handle lock, which `close` takes to stop operations: an
        // operation is either refused or counted before `close` waits for the count.
        let handle = lock(&self.shared);
        let shared = handle.clone().ok_or(CLOSED)?;
        *lock(&self.in_flight) += 1;
        drop(handle);
        Ok((Op(self), shared))
    }

    async fn run<T: Send + 'static>(&self, f: impl FnOnce(&sled::Db) -> Result<T, String> + Send + 'static) -> Result<T, String> {
        let (_op, shared) = self.begin()?;
        // The job owns a reference: if it is the last one, the release happens on the
        // blocking thread, not here.
        blocking(move || f(shared.db())).await
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        HANDLES.fetch_sub(1, Ordering::SeqCst);
        for slot in [&self.shared, &self.closing] {
            if let Some(shared) = lock(slot).take() {
                release(shared);
            }
        }
    }
}

fn limit_in(limit: f64) -> Result<usize, String> {
    if limit.fract() == 0.0 && (1.0..=MAX_KEYS).contains(&limit) {
        Ok(limit as usize)
    } else {
        Err(format!("invalid: limit must be an integer from 1 to {MAX_KEYS}"))
    }
}

impl spec::Store for Store {
    async fn get(&self, key: String, _cancel: CancelToken) -> Result<Option<Vec<u8>>, String> {
        self.run(move |db| db.get(key.as_bytes()).map(|v| v.map(|v| v.to_vec())).map_err(sled_error)).await
    }

    async fn put(&self, key: String, value: Vec<u8>, _cancel: CancelToken) -> Result<(), String> {
        self.run(move |db| {
            testing::wait_at_gate(&key);
            db.insert(key.as_bytes(), value).map(drop).map_err(sled_error)
        })
        .await
    }

    async fn remove(&self, key: String, _cancel: CancelToken) -> Result<bool, String> {
        self.run(move |db| db.remove(key.as_bytes()).map(|v| v.is_some()).map_err(sled_error)).await
    }

    fn validate_keys(&self, _prefix: &String, limit: &f64) -> Result<(), String> {
        limit_in(*limit).map(drop)
    }

    async fn keys(&self, prefix: String, limit: f64, _cancel: CancelToken) -> Result<Vec<String>, String> {
        let limit = limit_in(limit)?;
        self.run(move |db| {
            db.scan_prefix(prefix.as_bytes())
                .keys()
                .take(limit)
                .map(|k| k.map(|k| String::from_utf8_lossy(&k).into_owned()).map_err(sled_error))
                .collect()
        })
        .await
    }

    async fn flush(&self, _cancel: CancelToken) -> Result<f64, String> {
        self.run(|db| db.flush().map(|n| n as f64).map_err(sled_error)).await
    }

    async fn close(&self, _cancel: CancelToken) -> Result<(), String> {
        // Every caller joins the first close's outcome; none resolves before the handle's
        // in-flight operations finished and the flush completed (or failed).
        self.closed.get_or_init(|| self.finish_close()).await.clone()
    }
}

impl Store {
    /// Stop new operations, wait for pending ones, flush and release the handle.
    /// Keep the closing reference so an interrupted close can resume.
    async fn finish_close(&self) -> Result<(), String> {
        {
            let mut handle = lock(&self.shared);
            if let Some(shared) = handle.take() {
                *lock(&self.closing) = Some(shared);
            }
        }
        loop {
            let idle = self.idle.notified();
            tokio::pin!(idle);
            idle.as_mut().enable(); // registered before the check: no lost wakeup
            if *lock(&self.in_flight) == 0 {
                break;
            }
            idle.await;
        }
        let Some(shared) = lock(&self.closing).clone() else { return Ok(()) };
        let result = blocking(move || {
            if testing::take_close_flush_failure(&shared.name) {
                return Err("storage: injected flush failure (test hook)".to_string());
            }
            shared.db().flush().map(drop).map_err(sled_error)
        })
        .await;
        // Released whatever the flush result: a failed close is terminal, not retried.
        if let Some(shared) = lock(&self.closing).take() {
            release(shared);
        }
        result
    }
}

/// Helpers for testing pending operations and flush failures.
#[doc(hidden)]
pub mod testing {
    use std::sync::{Condvar, Mutex};

    static GATE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());
    static FAIL_CLOSE_FLUSH: Mutex<Vec<String>> = Mutex::new(Vec::new());

    /// While the returned guard lives, `put` of keys starting with `__gate/` waits on its
    /// blocking thread: a deterministic in-flight operation.
    pub fn hold_gate() -> GateGuard {
        *GATE.0.lock().unwrap_or_else(|e| e.into_inner()) = true;
        GateGuard
    }

    pub struct GateGuard;

    impl Drop for GateGuard {
        fn drop(&mut self) {
            *GATE.0.lock().unwrap_or_else(|e| e.into_inner()) = false;
            GATE.1.notify_all();
        }
    }

    pub(crate) fn wait_at_gate(key: &str) {
        if !key.starts_with("__gate/") {
            return;
        }
        let mut held = GATE.0.lock().unwrap_or_else(|e| e.into_inner());
        while *held {
            held = GATE.1.wait(held).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// Makes the next close's flush of database `name` fail.
    pub fn fail_next_close_flush(name: &str) {
        FAIL_CLOSE_FLUSH.lock().unwrap_or_else(|e| e.into_inner()).push(name.to_string());
    }

    pub(crate) fn take_close_flush_failure(name: &str) -> bool {
        let mut names = FAIL_CLOSE_FLUSH.lock().unwrap_or_else(|e| e.into_inner());
        let found = names.iter().position(|n| n == name);
        found.map(|i| names.remove(i)).is_some()
    }
}

#[cfg(test)]
mod tests;
