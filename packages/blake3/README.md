# BLAKE3 example

`@rnrs/example-blake3` wraps the [blake3](https://docs.rs/blake3/) crate for
Android, iOS and the browser. It supports one-shot and incremental hashing.

```ts
import { blake3Module } from '@rnrs/example-blake3';

const blake3 = blake3Module();
const data = new Uint8Array([1, 2, 3]).buffer;
const hex = blake3.hashHex(data);

const hasher = blake3.hasher();
try {
  hasher.update(data);
  hasher.update(new Uint8Array([4, 5]).buffer);
  const digest = hasher.finalize(); // 32-byte ArrayBuffer
} finally {
  hasher.dispose();
}
```

`hash` returns a 32-byte buffer; `keyedHash` takes a 32-byte key.
`deriveKey` derives a key from a context string and key material.
Incremental hashers also support keyed hashing, key derivation, `reset()` and
`finalizeXof(length)` for up to 1 MiB of output.

Use `hashLater(data, { signal })` or `hasher.updateLater(data, { signal })` for
cancellable hashing in 64 KiB chunks. Await an update before using that hasher
again: other operations fail while it is busy. Each update commits as a whole;
an abort after the commit can still reject with `AbortError` without undoing it.

## How it works

- The spec's `ArrayBuffer` values map to owned `Vec<u8>` inputs and outputs. The Rust methods pass those bytes to the `blake3` crate.
- `Hasher extends NativeObject` exposes persistent hashing state through a `Native<Hasher>` handle. Calling `dispose()` releases the JavaScript handle.
- Async methods check a `CancelToken` between chunks and yield to other tasks. `updateLater` hashes into a copy, then commits once complete; a busy flag prevents overlapping operations.

See the [spec](blake3.spec.ts) and [Rust implementation](rust/src/lib.rs).
Start with the [quickstart](../../docs/quickstart.md) for setup.
