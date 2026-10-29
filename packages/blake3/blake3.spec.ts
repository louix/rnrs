// One-shot and incremental BLAKE3 hashing with ArrayBuffer inputs and outputs.
import type { NativeModule, NativeObject } from '@rnrs/runtime/spec';

/** Incremental state. Await updateLater() before using this hasher again;
 *  other operations fail with "hasher is busy" while it runs. */
export interface Hasher extends NativeObject {
  update(data: ArrayBuffer): void;
  /** Hashes in 64 KiB chunks and commits the whole update at once.
   *  Cancellation after the commit can reject without undoing the update. */
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
