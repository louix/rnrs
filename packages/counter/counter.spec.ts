// Counter module spec: the TypeScript contract. Rust implementation: rust/counter.
import type { NativeModule, NativeObject } from '@rnrs/runtime/spec';

/** A persistent counter. Every number is an f64. */
export interface Counter extends NativeObject {
  increment(): number;
  add(delta: number): number;
  value(): number;
  /** Waits `delayMs`, then adds. `uncancellable` models a non-cooperative library call
   *  (lab test hook). */
  addLater(delta: number, delayMs: number, uncancellable: boolean): Promise<number>;
}

export interface CounterModule extends NativeModule {
  create(initial: number): Counter;
}
