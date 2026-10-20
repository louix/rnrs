// Measurement-only module for the conversion pilot (docs/pilot.md): each method does a small,
// input-dependent computation so results can be verified and work cannot be skipped.
import type { NativeModule, NativeObject } from '@rnrs/runtime/spec';

export interface Point8 {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;
}

export type Shape =
  | { kind: 'circle'; r: number }
  | { kind: 'rect'; w: number; h: number }
  | { kind: 'tri'; b: number; h: number };

export interface Cell extends NativeObject {
  get(): number;
}

export interface BenchModule extends NativeModule {
  scalar(a: number, b: number): number;
  /** UTF-8 length of the owned copy. */
  strLen(s: string): number;
  strEcho(s: string): string;
  /** Sum of the eight fields. */
  record(p: Point8): number;
  /** Sum of the elements. */
  array(xs: number[]): number;
  /** Area. */
  union(s: Shape): number;
  cell(x: number): Cell;
  /** Sum of the bytes of the owned copy. */
  bytesSum(b: ArrayBuffer): number;
  /** `n` bytes, byte i = i % 251. */
  bytesMake(n: number): ArrayBuffer;
  /** Resolves with x + 1 from the module's executor (admission-to-settle latency). */
  later(x: number): Promise<number>;
  /** Attribution only (docs/optimization.md): no arguments, no work. Appended so earlier
   *  method indices are unchanged. */
  nop(): number;
}
