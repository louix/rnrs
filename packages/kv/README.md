# Key-value storage example

`@rnrs/example-kv` wraps [sled](https://docs.rs/sled/) in an async store with string
keys and `ArrayBuffer` values. Runs on Android and iOS.

```ts
import { kvModule } from '@rnrs/example-kv';

const store = await kvModule().open('settings');
try {
  await store.put('theme', new Uint8Array([1]).buffer);
  const theme = await store.get('theme'); // ArrayBuffer, or null if missing
  await store.flush();
} finally {
  try {
    await store.close();
  } finally {
    store.dispose();
  }
}
```

- Database names use 1–64 lowercase letters, digits, `-` or `_`, starting with a letter or digit.
- `remove(key)` returns whether the key existed. `keys(prefix, limit)` lists up to 10,000 matching keys.
- `flush()` saves completed writes to disk. `close()` waits for pending operations, flushes and closes that handle. Other handles to the same database remain usable.
- `deleteDatabase(name)` removes a database's files and fails while it is open, opening or closing.

Call `flush()` or `close()` before relying on writes surviving an app shutdown;
sled has no periodic flush on Android or iOS. Cancelling an operation rejects with
`AbortError` but can still leave a write applied.

## How it works

- `open` returns a `Native<Store>` handle. The Rust `Store` implements the generated object trait; JavaScript calls its async methods through that handle.
- `app_data_dir()` locates app-private storage. Sled's blocking disk operations run through `tokio::task::spawn_blocking` and are awaited by the async methods.
- Handles share a database by name. Each handle tracks pending operations so `close()` can wait for them, flush and release its reference without closing other handles.

See the [spec](kv.spec.ts) and [Rust implementation](rust/src/lib.rs).
Start with the [quickstart](../../docs/quickstart.md) for setup.
