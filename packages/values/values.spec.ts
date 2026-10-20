// Value-conversion fixture module: records, strings, arrays, optional and nullable values,
// and discriminated unions.
// Rust implementation: rust/values. Used by the shared value suite on Android and web.
import type {NativeModule, NativeObject} from '@rnrs/runtime/spec';
import type {Size} from './shared';

export interface Point {
  x: number;
  y: number;
}

export interface Labeled {
  label: string;
  tags: string[];
  /** Optional: missing or undefined is None; omitted on output when None. */
  note?: string;
  /** Nullable: null is None; undefined is rejected. */
  parent: Point | null;
  points: Point[];
}

/** Discriminator inferred: `kind` is the only candidate. `empty` has no other fields. */
export type Shape =
  | {kind: 'circle'; radius: number}
  | {kind: 'rect'; width: number; height: number}
  | {kind: 'empty'};

/** Two candidates (`kind`, `category`), so the annotation chooses; `category` is a
 *  constant literal field restored on output. */
/** @discriminator kind */
export type Tagged =
  | {kind: 'round'; category: 'curved'; r: number}
  | {kind: 'square'; category: 'angular'; side: number};

/** A variant declared as an interface. */
export interface Move {
  type: 'move';
  to: Point;
}

export type Event =
  | Move
  | {type: 'batch'; shapes: Shape[]; label?: string}
  | {type: 'two-words'; note: string | null};

/** A record carrying bytes; `after` is read after `data` (conversion order). */
export interface Blob {
  name: string;
  data: ArrayBuffer;
  after: number;
}

/** An aliased Promise result is an async method too. */
export type Later = Promise<number>;

/** Field names that match locals of the generated glue (`object`, `value`). */
export type Slot =
  | {kind: 'filled'; object: number; value: string}
  | {kind: 'vacant'};

/** A native object taking records, to check receiver handling around getters. */
export interface Bag extends NativeObject {
  add(p: Point): number;
  count(): number;
}

export interface ValuesModule extends NativeModule {
  echoNumber(x: number): number;
  echoBool(b: boolean): boolean;
  echoString(s: string): string;
  /** UTF-8 byte length as Rust sees it. */
  utf8Length(s: string): number;
  echoNumbers(xs: number[]): number[];
  sum(xs: readonly number[]): number;
  nestedSum(xs: number[][]): number;
  echoStrings(xs: string[]): string[];
  echoPoint(p: Point): Point;
  echoLabeled(l: Labeled): Labeled;
  /** Proves Rust received each field: label|tags|note|parent|points. */
  describe(l: Labeled): string;
  maybe(x: number | null): number | null;
  maybeString(s: string | null): string | null;
  maybePoint(p: Point | null): Point | null;
  optionalArg(a: number, b?: number): string;
  points(n: number): Point[];
  echoLabeledLater(l: Labeled, ms: number): Promise<Labeled>;
  echoShape(s: Shape): Shape;
  area(s: Shape): number;
  echoTagged(t: Tagged): Tagged;
  echoEvent(e: Event): Event;
  /** circle, rect and empty, in that order. */
  allShapes(): Shape[];
  maybeShape(s: Shape | null): Shape | null;
  scaleLater(s: Shape, factor: number): Promise<Shape>;
  /** An imported record. */
  sizeArea(s: Size): number;
  echoSlot(slot: Slot): Slot;
  /** Parameter names that match locals of the generated glue. */
  mix(env: number, receiver: string, result: boolean): string;
  doubleLater(x: number): Later;
  echoBytes(b: ArrayBuffer): ArrayBuffer;
  byteSum(b: ArrayBuffer): number;
  /** n bytes counting 0, 1, 2, ... modulo 256. */
  makeBytes(n: number): ArrayBuffer;
  maybeBytes(b: ArrayBuffer | null): ArrayBuffer | null;
  byteLengths(xs: ArrayBuffer[]): number[];
  echoBlob(b: Blob): Blob;
  bytesLater(b: ArrayBuffer, ms: number): Promise<ArrayBuffer>;
  bag(): Bag;
}
