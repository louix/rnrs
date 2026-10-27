// Value-conversion fixture module: records, strings, arrays, optional and nullable values,
// discriminated unions, dictionaries (Record<string, T>) and JsonValue.
// Rust implementation: rust/values. Used by the shared value suite on Android and web.
import type { JsonValue, NativeModule, NativeObject } from '@rnrs/runtime/spec';
import type { Size } from './shared';

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
  | { kind: 'circle'; radius: number }
  | { kind: 'rect'; width: number; height: number }
  | { kind: 'empty' };

/** Two candidates (`kind`, `category`), so the annotation chooses; `category` is a
 *  constant literal field restored on output. */
/** @discriminator kind */
export type Tagged =
  | { kind: 'round'; category: 'curved'; r: number }
  | { kind: 'square'; category: 'angular'; side: number };

/** A variant declared as an interface. */
export interface Move {
  type: 'move';
  to: Point;
}

export type Event =
  | Move
  | { type: 'batch'; shapes: Shape[]; label?: string }
  | { type: 'two-words'; note: string | null };

/** A record carrying bytes; `after` is read after `data` (conversion order). */
export interface Blob {
  name: string;
  data: ArrayBuffer;
  after: number;
}

/** An aliased Promise result is an async method too. */
export type Later = Promise<number>;

/** Field names that match locals of the generated glue (`object`, `value`). */
export type Slot = { kind: 'filled'; object: number; value: string } | { kind: 'vacant' };

/** A SQL-style result row: column name -> value. */
export type Row = Record<string, JsonValue>;

/** Dictionaries inside a record: of numbers, of dictionaries of records, and JSON. */
export interface Inventory {
  counts: Record<string, number>;
  places?: Record<string, Record<string, Point>>;
  meta: JsonValue;
}

/** A native object taking records, to check receiver handling around getters. */
export interface Bag extends NativeObject {
  add(p: Point): number;
  count(): number;
}

/** Native-object composition: objects that create, take and hold other native objects, and
 *  handles inside records, unions, arrays and optional or nullable values. */
export interface Shader extends NativeObject {
  name(): string;
}

export interface Paint extends NativeObject {
  setShader(shader: Shader | null): void;
  shader(): Shader | null;
  /** Holds `shader` for `ms`, then returns its name (the task owns it meanwhile). */
  shaderNameLater(shader: Shader, ms: number): Promise<string>;
}

export interface Statement extends NativeObject {
  sql(): string;
  /** A handle to the database that prepared this statement (an object graph cycle). */
  database(): Database;
}

export interface Database extends NativeObject {
  name(): string;
  prepare(sql: string): Statement;
  prepareAll(sql: string[]): Promise<Statement[]>;
  prepared(sql: string, shader?: Shader): Prepared;
  /** sql|shader name or <none>|other statements' sql. */
  describePrepared(p: Prepared): string;
  /** The statement a slot holds, if any. */
  pick(slot: StatementSlot | null): Statement | null;
}

export interface Prepared {
  statement: Statement;
  sql: string;
  shader?: Shader;
  others: Statement[];
}

export type StatementSlot =
  | { kind: 'one'; statement: Statement }
  | { kind: 'many'; statements: Statement[]; first: Statement | null }
  | { kind: 'empty' };

export interface ValuesModule extends NativeModule {
  echoNumber(x: number): number;
  echoBool(b: boolean): boolean;
  /** a / b; fails with "division by zero" when b is 0 (a fallible prepared scalar entry). */
  checkedDivide(a: number, b: number): number;
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
  /** One Row per value list, keyed by `columns` (SQL-style). */
  query(columns: string[], rows: JsonValue[][]): Row[];
  /** The keys of each row as Rust holds them (sorted). */
  rowKeys(rows: Row[]): string[][];
  echoJson(v: JsonValue): JsonValue;
  echoJsonLater(v: JsonValue, ms: number): Promise<JsonValue>;
  /** JsonValue::Number(x) as an async result: NaN and infinities fail its conversion. */
  jsonNumberLater(x: number): Promise<JsonValue>;
  /** `depth` nested arrays around null. */
  nestedJson(depth: number): JsonValue;
  /** absent, null or the value's kind. */
  optionalJson(v?: JsonValue): string;
  echoCounts(c: Record<string, number>): Record<string, number>;
  maybeCounts(c: Record<string, number> | null): Record<string, number> | null;
  echoInventory(i: Inventory): Inventory;
  echoShapesByName(s: Record<string, Shape>): Record<string, Shape>;
  /** Sum of all byte lengths, async: the dictionary is owned by the operation. */
  byteTotalLater(b: Record<string, ArrayBuffer>, ms: number): Promise<number>;
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
  openDatabase(name: string): Database;
  paint(): Paint;
  shader(name: string): Shader;
  /** one, many and empty slots over statements of `db`. */
  statementSlots(db: Database): StatementSlot[];
  echoPrepared(p: Prepared): Prepared;
  maybePrepared(p: Prepared | null): Prepared | null;
  preparedLater(db: Database, sql: string, ms: number): Promise<Prepared>;
  /** Record values holding handles, directly and inside records. */
  echoStatementsByName(m: Record<string, Statement>): Record<string, Statement>;
  echoPreparedByName(m: Record<string, Prepared | null>): Record<string, Prepared | null>;
  /** Statements of `db` keyed by their sql, after `ms`. */
  statementsByNameLater(
    db: Database,
    sql: string[],
    ms: number,
  ): Promise<Record<string, Statement>>;
}
