// Async key-value storage with sled on Android and iOS.
import type { NativeModule, NativeObject } from '@rnrs/runtime/spec';

/** An open database. Await flush() or close() to persist completed writes.
 *  Cancellation rejects with AbortError but may still leave a write applied. */
export interface Store extends NativeObject {
  get(key: string): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer): Promise<void>;
  /** Resolves to whether the key existed. */
  remove(key: string): Promise<boolean>;
  /** Keys starting with `prefix`, in order, at most `limit` (1 to 10000). */
  keys(prefix: string, limit: number): Promise<string[]>;
  /** Writes everything completed so far to disk; resolves with the bytes sled flushed. */
  flush(): Promise<number>;
  /** Waits for pending operations, flushes and closes this handle. Other handles stay usable. */
  close(): Promise<void>;
}

/** Storage counters shared across runtimes. */
export interface KvDiagnostics {
  /** Databases currently open in the process (shared by all handles and runtimes). */
  openDatabases: number;
  /** Live Store handles. */
  handles: number;
  /** Operations running on blocking threads. */
  running: number;
}

export interface KvModule extends NativeModule {
  /** Opens a database in app-private storage. Names: 1–64 of a-z, 0-9, '-' or '_',
   *  starting with a letter or digit. */
  open(name: string): Promise<Store>;
  /** Deletes database `name` and its files. Fails if it is open in this process. */
  deleteDatabase(name: string): Promise<boolean>;
  diagnostics(): KvDiagnostics;
}
