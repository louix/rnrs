// Benchmark-only module: the rnrs side of the rnrs vs C++ TurboModule comparison
// (benchmarks/turbo-compare). Every method mirrors one of RnrsCmpCxx (../cxx-module) with the
// same algorithm; neither is a product module.
import type { NativeModule } from '@rnrs/runtime/spec';

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

export interface Vec2 {
  x: number;
  y: number;
}

export interface Frame {
  origin: Vec2;
  size: Vec2;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Nested {
  id: number;
  visible: boolean;
  frame: Frame;
  tint: Rgba;
}

export interface TurboCompareModule extends NativeModule {
  nop(): void;
  add(a: number, b: number): number;
  flip(b: boolean): boolean;
  /** UTF-8 byte length of the owned copy. */
  strLen(s: string): number;
  /** An owned copy of fixture string `id` (0..5: ASCII 16 B, 1 KiB, 64 KiB, then Unicode). */
  strGet(id: number): string;
  /** Sum of the eight fields. */
  pointSum(p: Point8): number;
  /** Fields x, x+1, ..., x+7. */
  pointMake(x: number): Point8;
  /** id + (visible ? 1 : 0) + every number of frame and tint. */
  nestedSum(n: Nested): number;
  /** id x, visible, origin (x+1, x+2), size (x+3, x+4), tint (x+5 .. x+8). */
  nestedMake(x: number): Nested;
  /** Sum of the elements. */
  arrSum(xs: number[]): number;
  /** [x, x+1, ..., x+len-1]. */
  arrMake(len: number, x: number): number[];
  /** Sum over all points of their field sums. */
  pointSumBatch(ps: Point8[]): number;
}
