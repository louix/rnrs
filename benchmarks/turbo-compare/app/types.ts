// Shared types of the comparison harness (benchmarks/turbo-compare).
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
export interface Nested {
  id: number;
  visible: boolean;
  frame: { origin: Vec2; size: Vec2 };
  tint: { r: number; g: number; b: number; a: number };
}

/** The method set both modules implement (rnrs: TurboCompareModule, TM: RnrsCmpCxx spec). */
export interface CmpApi {
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
}

/** The handwritten JSI control (scalars and numeric-array input) plus harness helpers, global.__rnrsCmpJsi. */
export interface JsiControl {
  guarded: Pick<CmpApi, 'nop' | 'add' | 'flip'> & {
    close(): void;
    /** rnrs calling-shape controls: (helpers, index, receiver, ...args) / this = helpers. */
    callp(...args: unknown[]): unknown;
    callpThis(...args: unknown[]): unknown;
  };
  arrSum(xs: number[]): number;
  nop(): void;
  add(a: number, b: number): number;
  flip(b: boolean): boolean;
  env(name: string): string | null;
  thermalState(): number;
  build: { optimize: boolean; ndebug: boolean; compiler: string };
}

export interface Receivers {
  rnrs: CmpApi;
  tm: CmpApi;
  jsi: JsiControl;
  guarded: JsiControl['guarded'];
  wrapped: Pick<CmpApi, 'nop' | 'add' | 'flip'>;
  shaped: Pick<CmpApi, 'nop' | 'add' | 'flip'>;
  shapedThis: Pick<CmpApi, 'nop' | 'add' | 'flip'>;
  shapedUnbound: Pick<CmpApi, 'nop' | 'add' | 'flip'>;
  /** The wrapped control with prototype methods. */
  wrappedProto: Pick<CmpApi, 'nop' | 'add' | 'flip'>;
  /** rnrs's protocol 3 JS shape (class, ModuleHost-like host, m<index>) around guarded leaves. */
  entry: Pick<CmpApi, 'nop' | 'add' | 'flip'>;
  /** Nitro Modules 0.37.1 C++ HybridObject (nitro-module/). */
  nitro: Pick<CmpApi, 'nop' | 'add' | 'flip' | 'arrSum'>;
}

export interface Fixtures {
  strings: string[];
  stringBytes: number[];
  point: Point8;
  pointTotal: number;
  nested: Nested;
  nestedTotal: number;
  arrays: Record<number, number[]>;
  arrayTotals: Record<number, number>;
  /** Four distinct arrays per size (16, 256, 1024), rotated per call by the arrIn workloads. */
  rotArrays: Record<number, number[][]>;
  /** Sum over calls i < n of the total of rotArrays[len][i & 3]. */
  rotatedTotal(len: number, n: number): number;
  points64: Point8[];
  points64Total: number;
}

export interface Case {
  workload: string;
  path: string;
  /** The checksum `run(n)` must return. */
  expect(n: number): number;
  /** n iterations of the workload body; returns the checksum. */
  run(n: number): number;
}
