// Lab-only fixture for the Rust logging smoke (docs/logging.md): emits tracing events and log
// records, on the calling JS thread and on an executor worker thread, including events the
// smoke's filter must suppress. Not a production module.
import type {NativeModule} from '@rnrs/runtime/spec';

export interface LogProbeModule extends NativeModule {
  /** Emits the probe's events on the calling (JS) thread; returns that thread's name. */
  emit(id: string): string;
  /** Emits the probe's events on an executor worker thread; resolves with its name. */
  emitOnWorker(id: string): Promise<string>;
}
