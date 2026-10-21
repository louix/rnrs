# `@rnrs/example-kv`: sled on Android and iOS

An author package: a TS spec (`packages/kv/kv.spec.ts`), a Rust crate wrapping sled 0.34, and the generated interface. It has no platform code. Its targets are `android` and `ios`:
- There is no browser backend and no fallback. An app whose dependency graph selects it for the web is refused by `rnrs build --target web`, naming the chain (`scripts/consumer/kv-web-rejected.sh`), and the packaged `rnr/web.ts` throws at import.
- The lab therefore builds its browser harness from its own graph (`web/package.json`, lock `web/rnr-web.Cargo.lock`), which does not include kv.
- On iOS the same crate runs unchanged; the framework supplies `<Application Support>/rnr` (see [iOS](#ios)).

sled 0.34 is old (2021) and still pre-1.0. It was chosen as requested for this example, not as a recommendation.

## Contract

- **Opening:** `kvModule().open(name)` resolves to a `Store`.
  - Names are 1 to 64 characters of `a-z 0-9 - _`, starting with a letter or digit, checked before any work (RangeError). They cannot contain separators or dots, so a name never reaches another path.
  - The database lives in `<app data dir>/kv/<name>`.
- **Store operations:** `get`, `put`, `remove`, `keys(prefix, limit ≤ 10000)`, `flush()` and `close()`, all async, with ArrayBuffer values and string keys.
- **Deleting:** `deleteDatabase(name)` deletes only that database's directory, and fails (`busy:`) while it is open, opening or closing in the process.
- **Diagnostics:** `diagnostics()` returns process-wide `openDatabases`, `handles` and `running`.
- **Durability:** a resolved `put` is in sled's memory and log buffers. Only writes completed before a resolved `flush()` or `close()` are guaranteed to survive a process kill. Before that, data reaches disk only when sled writes out a full log buffer, or at the final release of the database (which flushes). The crate asks sled for a flush every 500 ms (`flush_every_ms`), but sled 0.34.7 starts that background flusher only on Windows, Linux, macOS and the BSDs (`src/db.rs:72-94`). On Android and iOS it does nothing.
- **Cancellation:** an AbortSignal rejects with AbortError, but writes do not observe it. A cancelled `put` may still be applied; nothing is rolled back.
- **`close()`:** every call, concurrent or later, joins the same outcome.
  - Stops new operations on that handle; they reject with `closed:`. An operation is either refused or counted before `close` waits.
  - Waits for the handle's in-flight operations, flushes, then releases the handle.
  - No call resolves before the in-flight operations and the flush are done. A flush failure is the terminal outcome of every call: the handle stays closed, and the database is still released and flushed again on release. Tested with a gated write (crate tests and through the generated glue and adapter) and an injected failure.
  - Other handles to the same database stay usable.
- **Atomicity:** each `put` is one sled insert, so a value is whole or absent. There are no multi-key transactions.

## Framework additions (minimal)

- **`rnrs_core::platform::app_data_dir()`**. The app-private directory supplied by the backend:
  - On Android the framework's Kotlin module selects `Context.getFilesDir()/rnr` and passes the path through JNI (`RnrPlatform.setAppDataDir`, then `rnr_set_app_data_dir`) before modules exist. Directory creation is deferred until use.
  - The first value wins, and a different one is an error.
  - Without a backend-provided directory (for example the browser) it returns an error.
  - The Kotlin module does not create the directory or fail at construction. `app_data_dir()` creates it on use and returns an error naming the path if it cannot, so the runtime starts and a module that needs storage reports why.
  - Whether files under `filesDir` are included in Android Auto Backup is the app's backup policy. The RN template sets `allowBackup="false"`.
- **No new executor.** Disk work runs on Tokio's blocking pool: the framework's native executor is Tokio, so author code can call `tokio::task::spawn_blocking`. An operation awaits its blocking job to the end, so the job stays admitted and counted against the module's slots and the shared executor budget. Teardown cannot leave uncounted disk work.

## Lifecycle design

- **One database per name per process,** shared by every handle and runtime. During a reload or a destroy-and-recreate, the old runtime's handles may still exist when the new runtime opens the database; sharing avoids sled's file-lock conflict.
- **Registry:**
  - Opening and deleting are serialized per name.
  - The blocking job itself records the opened database, so a dropped caller cannot leave a name stuck.
  - An open that races the previous instance's final release waits for it, polling up to 10 s, instead of failing on the lock.
  - sled 0.34.7 takes its exclusive file lock only on Windows, Linux and macOS (`src/config.rs:580-604`), not on Android or iOS. There this registry is the only guard against opening a database twice, and it is process-local. The app-private directory is not shared with other processes, but nothing would stop two processes from opening the same files (for example an iOS app extension pointed at a shared App Group container, which this module does not use).
- **Where the final release runs:** a handle dropped without `close()` (a finalized wrapper, or runtime teardown on React Native's invalidation thread) hands its reference to a dedicated `rnr-kv-closer` thread. The final release of a database, and with it sled's last flush and the release of its lock, therefore happens on that thread or on a blocking-pool thread, never on the JS thread or the invalidation thread. A Rust test asserts the thread.

## iOS

- **Directory:** `<Application Support>/rnr/kv/<name>` in the app's data container. The framework sets the path before any module exists; kv creates it on first use.
- **Storage policies the app owns:**
  - *Backup:* Application Support is included in iCloud and computer backups by default, and kv does not set `NSURLIsExcludedFromBackupKey`.
  - *Data protection:* the default class applies (`NSFileProtectionCompleteUntilFirstUserAuthentication` for third-party apps). A launch before the first unlock after a reboot could not read the files. That case is not tested.
- **Lifecycle:** the database thread and the `rnr-kv-closer` thread behave as on Android. When iOS suspends the app, unflushed data stays in memory, and the app can then be killed without notice. As on Android, only flushed data is promised; call `flush()` before the app may go to the background. Backgrounding itself is not tested.
- **Same code:** no platform code and no iOS-specific branch in the crate. sled 0.34.7 has no iOS-specific code paths beyond the gaps above (flusher, file lock, and its memory-limit probe, which is irrelevant because the cache size is set).


## Limits

- An unflushed write's fate on a kill is not tested; it may or may not be lost. Only flushed data is promised. On Android and iOS there is no periodic flush (see Durability), so unflushed data can stay in memory indefinitely.
- sled 0.34.7's background segment cleaning (`attempt_gc`) runs on the same flusher thread, so it does not run on Android or iOS either. On-disk growth under sustained overwrites was not measured on either platform.
- Process-wide sharing means `close()` on one handle does not close the database while other handles exist. The database is released when the last handle goes.
- `keys` loads up to 10000 keys at once; there is no cursor API. Values are copied in and out as ArrayBuffers.
- sled's page cache is bounded at 16 MiB per open database (`CACHE_BYTES`; sled's default is 1 GiB).
- sled's own background threads and file formats are as in sled 0.34. No migration or corruption-recovery policy is provided.
