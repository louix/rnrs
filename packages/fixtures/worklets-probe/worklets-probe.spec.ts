// Lab-only fixture for the Worklets proof of concept (docs/research/worklets-poc-plan.md):
// sync scalar methods a worklet endpoint may expose, a native object for the boxed-handle
// path, and methods of every other shape that the endpoint must refuse. Not a production module.
import type { NativeModule, NativeObject } from '@rnrs/runtime/spec';

/** A shared accumulator (Rust: `Mutex<f64>` plus atomic counters, Send + Sync). */
export interface Accumulator extends NativeObject {
  add(delta: number): number;
  value(): number;
  /** Calls of `add` since creation, from any runtime. */
  calls(): number;
}

export interface Point {
  x: number;
  y: number;
}

export interface WorkletsProbeModule extends NativeModule {
  /** `x * k`: the scalar endpoint method. */
  scale(x: number, k: number): number;
  isPositive(x: number): boolean;
  /** Latest-value slot (last write wins): stores the pair and counts writes. */
  setPointer(x: number, y: number): void;
  pointerX(): number;
  pointerY(): number;
  pointerWrites(): number;
  createAccumulator(initial: number): Accumulator;
  /** Shapes the worklet endpoint refuses (async, string, record, array). */
  scaleLater(x: number, k: number): Promise<number>;
  describe(x: number): string;
  point(x: number, y: number): Point;
  pair(x: number, y: number): number[];
}
