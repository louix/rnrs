# BLAKE3 example

`@rnrs/example-blake3` wraps the `blake3` crate (1.8.7):

- module functions `hash`, `hashHex`, `keyedHash`, `deriveKey` and `hashLater` (async, cancellable between 64 KiB chunks);
- `Hasher` objects (`update`, `updateLater`, `finalize`, `finalizeXof`, `reset`) created by `hasher`, `keyedHasher` and `derivingHasher`.

**Hasher concurrency.** While an `updateLater` runs, every other operation on that hasher fails with "hasher is busy" (sync `update`/`finalize`/`finalizeXof`/`reset` and a second `updateLater`).
- The busy state begins when the operation starts on the executor. A sync call made right after `updateLater` therefore either fails busy or is ordered before the update.
- The update is hashed into a copy of the state and committed in one step when all input is hashed, so the digest never reflects part of an update.
- Errors, cancellation observed before the commit, or a dropped future leave the state unchanged and release the gate.
- An abort that arrives after the commit still rejects with AbortError, but the update stays committed. A rejection does not mean rollback: the core accepts a cancellation until the outcome is delivered.
