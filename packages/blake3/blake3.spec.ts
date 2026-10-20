// BLAKE3 for React Native (Android) and the browser: the TypeScript contract. The Rust
// implementation in rust/ wraps the `blake3` crate. Inputs are ArrayBuffers (copied);
// digests are new ArrayBuffers.
import type {NativeModule, NativeObject} from '@rnrs/runtime/spec';

/** Incremental hashing state.
 *
 *  While an `updateLater` on a hasher runs, every other operation on that hasher (`update`,
 *  `updateLater`, `finalize`, `finalizeXof`, `reset`) fails with "hasher is busy". The busy
 *  state begins when the operation starts on the executor, so a sync call made right after
 *  `updateLater` either fails busy or is ordered before the update. An update is committed
 *  whole or not at all; the digest never reflects part of one. */
export interface Hasher extends NativeObject {
  update(data: ArrayBuffer): void;
  /** Hashes `data` on the module's executor; the hasher stays alive until it finishes.
   *  The update is hashed into a copy and committed in one step when all of `data` is
   *  hashed. Resolution means it was committed. Cancellation is observed between 64 KiB
   *  chunks and before the commit; an abort that arrives after the commit still rejects
   *  the promise with AbortError, but the update stays committed, so a rejection does not
   *  mean rollback. Check `finalize()` (after the operation has exited) if it matters. */
  updateLater(data: ArrayBuffer): Promise<void>;
  /** The 32-byte digest of everything hashed so far (the state is kept). */
  finalize(): ArrayBuffer;
  /** `length` bytes of extended output (0 to 1048576). */
  finalizeXof(length: number): ArrayBuffer;
  reset(): void;
}

export interface Blake3Module extends NativeModule {
  hash(data: ArrayBuffer): ArrayBuffer;
  hashHex(data: ArrayBuffer): string;
  /** `key` must be exactly 32 bytes. */
  keyedHash(key: ArrayBuffer, data: ArrayBuffer): ArrayBuffer;
  deriveKey(context: string, material: ArrayBuffer): ArrayBuffer;
  hasher(): Hasher;
  keyedHasher(key: ArrayBuffer): Hasher;
  derivingHasher(context: string): Hasher;
  /** Hashes on the module's executor, observing cancellation between 64 KiB chunks. */
  hashLater(data: ArrayBuffer): Promise<ArrayBuffer>;
}
