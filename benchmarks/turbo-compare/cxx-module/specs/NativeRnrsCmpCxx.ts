// Benchmark-only RN codegen spec: the C++ TurboModule side of the rnrs vs C++ TurboModule
// comparison (benchmarks/turbo-compare). Methods mirror ../rnrs-module/turbo-compare.spec.ts.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type Point8 = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;
};

export type Vec2 = {
  x: number;
  y: number;
};

export type Frame = {
  origin: Vec2;
  size: Vec2;
};

export type Rgba = {
  r: number;
  g: number;
  b: number;
  a: number;
};

export type Nested = {
  id: number;
  visible: boolean;
  frame: Frame;
  tint: Rgba;
};

export interface Spec extends TurboModule {
  nop(): void;
  add(a: number, b: number): number;
  flip(b: boolean): boolean;
  strLen(s: string): number;
  strGet(id: number): string;
  pointSum(p: Point8): number;
  pointMake(x: number): Point8;
  nestedSum(n: Nested): number;
  nestedMake(x: number): Nested;
  arrSum(xs: number[]): number;
  arrMake(len: number, x: number): number[];
  pointSumBatch(ps: Point8[]): number;
  /** Harness only, never timed: installs the handwritten JSI control and the harness helpers
   *  as global.__rnrsCmpJsi. */
  installHarness(): boolean;
}

export default TurboModuleRegistry.getEnforcing<Spec>('RnrsCmpCxx');
