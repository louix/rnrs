// A mutable counter with synchronous and cancellable async methods.
import type { NativeModule, NativeObject } from '@rnrs/runtime/spec';

/** State stays in Rust until the counter is disposed. */
export interface Counter extends NativeObject {
  increment(): number;
  add(delta: number): number;
  value(): number;
  /** Waits `delayMs`, then adds. If `uncancellable` is true, cancellation can still apply the addition. */
  addLater(delta: number, delayMs: number, uncancellable: boolean): Promise<number>;
}

export interface CounterModule extends NativeModule {
  create(initial: number): Counter;
}
