// A persistent key-value store for React Native on Android and iOS: the TypeScript contract. The
// Rust implementation in rust/ uses sled, with databases under the app's private storage
// (the framework's application data directory). There is no browser backend.
import type { NativeModule, NativeObject } from '@rnrs/runtime/spec';

/** An open database handle.
 *
 *  Durability: a write is in memory and sled's log buffers when its promise resolves. Only
 *  writes that completed before a resolved `flush()` (or `close()`) are guaranteed to
 *  survive a process kill; there is no periodic background flush on Android or iOS.
 *
 *  Cancellation (AbortSignal) rejects the promise with AbortError but does not undo a write
 *  that already started; it may still be applied. */
export interface Store extends NativeObject {
  get(key: string): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer): Promise<void>;
  /** Resolves to whether the key existed. */
  remove(key: string): Promise<boolean>;
  /** Keys starting with `prefix`, in order, at most `limit` (1 to 10000). */
  keys(prefix: string, limit: number): Promise<string[]>;
  /** Writes everything completed so far to disk; resolves with the bytes sled flushed. */
  flush(): Promise<number>;
  /** Stops accepting operations on this handle, waits for its in-flight ones, flushes, and
   *  releases it. Later operations on it reject with "closed". Other handles to the same
   *  database (for example from another runtime during a reload) stay usable. */
  close(): Promise<void>;
}

/** Process-wide counters (diagnostics and tests). */
export interface KvDiagnostics {
  /** Databases currently open in the process (shared by all handles and runtimes). */
  openDatabases: number;
  /** Live Store handles. */
  handles: number;
  /** Operations running on blocking threads. */
  running: number;
}

export interface KvModule extends NativeModule {
  /** Opens (or shares the process's already open) database `name`: 1 to 64 characters of
   *  a-z, 0-9, '-' and '_', starting with a letter or digit. Stored under the app's private
   *  data directory; names cannot reach other paths. */
  open(name: string): Promise<Store>;
  /** Deletes database `name` and its files. Fails if it is open in this process. */
  deleteDatabase(name: string): Promise<boolean>;
  diagnostics(): KvDiagnostics;
}
