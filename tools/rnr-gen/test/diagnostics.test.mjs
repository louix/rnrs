// Negative diagnostics: every unsupported schema is rejected with file:line and an
// actionable message, never silently broadened.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {parseSpec} from '../parse.mjs';
import {FRAMEWORK_SPEC, ROOT} from '../cli.mjs';

const dir = path.join(ROOT, '.generated/rnr-test-specs');
mkdirSync(dir, {recursive: true});
let n = 0;

/** Parses `body` (after the marker import) and returns its diagnostics. `files` are extra
 *  modules written next to the spec (`./<name>`). */
function diagnose(body, files = {}) {
  const id = n++;
  const caseDir = path.join(dir, `case${id}`);
  mkdirSync(caseDir, {recursive: true});
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(caseDir, `${name}.ts`), content);
  const file = path.join(caseDir, `case${id}.spec.ts`);
  writeFileSync(file, `import type {NativeModule, NativeObject} from '@rnrs/runtime/spec';\n${body}\n`);
  return parseSpec(file, {frameworkSpec: FRAMEWORK_SPEC, root: ROOT}).diagnostics;
}

const mod = members => `export interface M extends NativeModule {\n${members}\n}`;

const cases = [
  ['any', mod('  f(x: any): void;'), 2, /any has no concrete conversion/],
  ['unknown', mod('  f(): unknown;'), 2, /unknown has no concrete conversion/],
  ['object', mod('  f(x: object): void;'), 2, /object has no concrete conversion/],
  ['bigint', mod('  f(x: bigint): void;'), 2, /bigint is not supported/],
  ['symbol', mod('  f(x: symbol): void;'), 2, /symbols are not supported/],
  ['Date', mod('  f(x: Date): void;'), 2, /Date is not supported; pass a timestamp/],
  ['Map', mod('  f(x: Map<string, number>): void;'), 2, /Map is not supported/],
  ['Set', mod('  f(x: Set<number>): void;'), 2, /Set is not supported/],
  ['Record', mod('  f(x: Record<string, number>): void;'), 2, /Record<string, T> is not supported yet/],
  ['Uint8Array', mod('  f(x: Uint8Array): void;'), 2, /Uint8Array is not accepted; the contract is ArrayBuffer \(slice explicitly/],
  ['Float64Array result', mod('  f(): Float64Array;'), 2, /Float64Array is not accepted/],
  ['DataView', mod('  f(x: DataView): void;'), 2, /pass an ArrayBuffer, not a view/],
  ['SharedArrayBuffer', mod('  f(x: SharedArrayBuffer): void;'), 2, /SharedArrayBuffer is not supported/],
  ['ArrayBufferLike', mod('  f(x: ArrayBufferLike): void;'), 2, /ArrayBufferLike is not accepted/],
  ['tuple', mod('  f(x: [number, number]): void;'), 2, /tuples are not supported yet/],
  ['callback', mod('  f(cb: (x: number) => void): void;'), 2, /callbacks are not supported/],
  ['void param', mod('  f(x: void): void;'), 2, /void is only allowed as a method result/],
  ['undefined union', mod('  f(x: number | undefined): void;'), 2, /instead of \| undefined/],
  ['optional nullable param', mod('  f(x?: number | null): void;'), 2, /optional nullable parameters/],
  ['required after optional', mod('  f(a?: number, b: number): void;'), 2, /required parameters cannot follow optional ones/],
  ['rest param', mod('  f(...xs: number[]): void;'), 2, /no rest, defaults or destructuring/],
  ['generic method', mod('  f<T>(x: T): T;'), 2, /generic methods are not supported/],
  ['overload', mod('  f(x: number): void;\n  f(x: string): void;'), 3, /overloads are not supported/],
  ['optional method', mod('  f?(): void;'), 2, /optional methods are not supported/],
  ['property member', mod('  readonly x: number;'), 2, /only methods are allowed in native interfaces/],
  ['missing result type', mod('  f();'), 2, /declare the result type/],
  ['Promise param', mod('  f(p: Promise<number>): void;'), 2, /Promise is only supported as a method result/],
  ['nested Promise', mod('  f(): Promise<Promise<number>>;'), 2, /Promise is only supported as a method result/],
  ['number literal', mod("  f(x: 1): void;"), 2, /literal types are only supported as union discriminators/],
  ['anonymous record', mod('  f(x: {a: number}): void;'), 2, /name this object type with an interface or type alias/],
  ['mixed union', mod('  f(x: number | string): void;'), 2, /untagged mixed unions are not supported/],
  ['anonymous object union', mod("  f(x: {k: 'a'} | {k: 'b'}): void;"), 2, /name this union with a type alias/],
  ['reserved module method', mod('  teardown(): void;'), 2, /reserved by the framework wrapper/],
  ['no module', 'export interface O extends NativeObject {\n  f(): void;\n}', 0, /must declare one interface extending NativeModule/],
  ['two modules', `${mod('  f(): void;')}\nexport interface N extends NativeModule {\n  g(): void;\n}`, 4, /exactly one NativeModule/],
  ['other heritage', 'interface Base { x: number }\nexport interface M extends Base {\n  f(): void;\n}', 2, /may only extend NativeObject or NativeModule/],
  ['class declaration', `export class C {}\n${mod('  f(): void;')}`, 1, /only interfaces, type aliases and type imports/],
  ['enum', `enum E { A }\n${mod('  f(x: E): void;')}`, 1, /only interfaces, type aliases/],
  ['reserved object method', `export interface O extends NativeObject {\n  dispose(): void;\n}\n${mod('  o(): O;')}`, 2, /dispose is reserved/],
  ['object method other native', `export interface A extends NativeObject {\n  b(): B;\n}\nexport interface B extends NativeObject {\n  x(): number;\n}\n${mod('  a(): A;')}`, 2, /object methods may only return their own native type/],
  ['module passed', mod('  f(m: M): void;'), 2, /NativeModule cannot be passed or returned/],
  ['generic alias', `type Box<T> = {v: T};\n${mod('  f(x: Box<number>): void;')}`, 3, /generic types are not supported/],
  ['optional nullable field', `interface R {\n  a?: number | null;\n}\n${mod('  f(r: R): void;')}`, 2, /optional nullable fields \(x\?: T \| null\) have three states/],
  ['literal field in record', `interface R {\n  k: 'a';\n}\n${mod('  f(r: R): void;')}`, 2, /string-literal fields are only supported in discriminated union variants/],
  ['method in record', `interface R {\n  m(): void;\n}\n${mod('  f(r: R): void;')}`, 2, /records contain only named properties/],
  ['index signature', `interface R {\n  [k: string]: number;\n}\n${mod('  f(r: R): void;')}`, 2, /records contain only named properties/],
  ['record heritage', `interface A { a: number }\ninterface R extends A {\n  b: number;\n}\n${mod('  f(r: R): void;')}`, 2, /may only extend NativeObject or NativeModule/],
  ['recursive record', `interface Node {\n  next: Node | null;\n}\n${mod('  f(n: Node): void;')}`, 2, /recursive value types are not supported yet/],
  ['native in record', `export interface O extends NativeObject {\n  v(): number;\n}\ninterface R {\n  o: O;\n}\n${mod('  f(r: R): void;')}`, 5, /native objects inside value types are not supported yet/],
  ['undefined field', `interface R {\n  a: number | undefined;\n}\n${mod('  f(r: R): void;')}`, 2, /instead of \| undefined/],
  ['union without discriminator', `type U =\n  | {a: 'x'; v: number}\n  | {b: 'y'};\n${mod('  f(u: U): void;')}`, 1, /U: no discriminator/],
  ['union with repeated tag', `type U =\n  | {k: 'a'}\n  | {k: 'a'; x: number};\n${mod('  f(u: U): void;')}`, 1, /U: no discriminator/],
  ['optional discriminator', `type U =\n  | {k?: 'a'}\n  | {k: 'b'};\n${mod('  f(u: U): void;')}`, 2, /literal fields must be required/],
  ['ambiguous discriminator', `type U =\n  | {k: 'a'; c: 'x'}\n  | {k: 'b'; c: 'y'};\n${mod('  f(u: U): void;')}`, 1, /U: ambiguous discriminator \(k, c\); annotate/],
  ['bad annotation', `/** @discriminator nope */\ntype U =\n  | {k: 'a'; c: 'x'}\n  | {k: 'b'; c: 'y'};\n${mod('  f(u: U): void;')}`, 1, /@discriminator nope is not a valid discriminator; candidates: k, c/],
  ['non-object variant', `type U =\n  | {k: 'a'}\n  | number;\n${mod('  f(u: U): void;')}`, 3, /every union variant must be an object type/],
  ['colliding variant names', `type U =\n  | {k: 'a-b'}\n  | {k: 'aB'};\n${mod('  f(u: U): void;')}`, 3, /map to the same Rust variant AB/],
  ['tag without identifier', `type U =\n  | {k: '1'}\n  | {k: '2'};\n${mod('  f(u: U): void;')}`, 2, /cannot be turned into a Rust variant name/],
  ['native in variant', `export interface O extends NativeObject {\n  v(): number;\n}\ntype U =\n  | {k: 'a'; o: O}\n  | {k: 'b'};\n${mod('  f(u: U): void;')}`, 5, /native objects inside value types are not supported yet/],
  ['TS error', mod('  f(x: Nope): void;'), 2, /TypeScript: Cannot find name 'Nope'/],
];

for (const [name, body, line, pattern] of cases) {
  test(`rejects ${name}`, () => {
    const diagnostics = diagnose(body);
    assert.ok(diagnostics.length > 0, 'expected a diagnostic');
    const hit = diagnostics.find(d => pattern.test(d.message));
    assert.ok(hit, `no diagnostic matching ${pattern}: ${JSON.stringify(diagnostics)}`);
    assert.equal(hit.line, line + 1, `line of ${JSON.stringify(hit)}`); // +1: the import line
    assert.match(hit.file, /\.generated\/rnr-test-specs\/case\d+\/(case\d+\.spec|[a-z]+)\.ts$/);
  });
}

// Review regressions: identity, merging, names, three-state aliases, reserved and external.
const reviewCases = [
  ['same-named records from two files',
    `import type {Far as A} from './a';\nimport type {Far as B} from './b';\n${mod('  f(a: A, b: B): void;')}`,
    {a: 'export interface Far {\n  x: number;\n}\n', b: 'export interface Far {\n  y: string;\n}\n'},
    4, /type name Far refers to two different declarations \(.*a\.ts:1 and .*b\.ts:1\); rename one/],
  ['same-named unions from two files',
    `import type {U as A} from './a';\nimport type {U as B} from './b';\n${mod('  f(a: A, b: B): void;')}`,
    {a: "export type U =\n  | {k: 'x'}\n  | {k: 'y'};\n", b: "export type U =\n  | {t: 'p'; v: number}\n  | {t: 'q'};\n"},
    4, /type name U refers to two different declarations/],
  ['merged record interface', `interface R {\n  a: number;\n}\ninterface R {\n  b: number;\n}\n${mod('  f(r: R): void;')}`, {}, 1, /R has 2 merged declarations .*declaration merging is not supported/],
  ['merged native object', `export interface O extends NativeObject {\n  a(): number;\n}\nexport interface O extends NativeObject {\n  b(): number;\n}\n${mod('  o(): O;')}`, {}, 1, /O has 2 merged declarations/],
  ['merged module', `${mod('  a(): void;')}\nexport interface M extends NativeModule {\n  b(): void;\n}`, {}, 1, /M has 2 merged declarations/],
  ['non-identifier field', `interface R {\n  'my-field': number;\n}\n${mod('  f(r: R): void;')}`, {}, 2, /"my-field" must be an identifier of letters, digits and _/],
  ['__proto__ field', `interface R {\n  __proto__: number;\n}\n${mod('  f(r: R): void;')}`, {}, 2, /__proto__ cannot be a field or parameter name/],
  ['self field', `interface R {\n  self: number;\n}\n${mod('  f(r: R): void;')}`, {}, 2, /self cannot be a Rust identifier/],
  ['super method', mod('  super(): void;'), {}, 2, /super cannot be a Rust identifier/],
  ['crate param', mod('  f(crate: number): void;'), {}, 2, /crate cannot be a Rust identifier/],
  ['Self type name', `type Self = {a: number};\n${mod('  f(s: Self): void;')}`, {}, 3, /type name Self is reserved/],
  ['Result type name', `interface Result {\n  a: number;\n}\n${mod('  f(r: Result): void;')}`, {}, 5, /type name Result is reserved/],
  ['lowercase type name', `interface point {\n  a: number;\n}\n${mod('  f(p: point): void;')}`, {}, 5, /type name point must be PascalCase/],
  ['snake collision in fields', `interface R {\n  aB: number;\n  a_b: number;\n}\n${mod('  f(r: R): void;')}`, {}, 3, /a_b and aB both become Rust a_b/],
  ['snake collision in methods', mod('  getX(): number;\n  get_x(): number;'), {}, 3, /get_x and getX both become Rust get_x/],
  ['snake collision in params', mod('  f(aB: number, a_b: number): void;'), {}, 2, /a_b and aB both become Rust a_b/],
  ['validate hook collision', mod('  later(): Promise<void>;\n  validateLater(): void;'), {}, 3, /collides with the generated validate hook of async method later/],
  ['validate hook collision (hook first)', mod('  validateLater(): void;\n  later(): Promise<void>;'), {}, 2, /validateLater collides with the generated validate hook of async method later/],
  ['validate hook collision via Promise alias', `type Later = Promise<number>;\n${mod('  foo(): Later;\n  validateFoo(): void;')}`, {}, 4, /validateFoo collides with the generated validate hook of async method foo/],
  ['cancel param via Promise alias', `type Later = Promise<number>;\n${mod('  foo(cancel: number): Later;')}`, {}, 3, /cancel is reserved for the async method's CancelToken/],
  ['cancel param in async', mod('  f(cancel: number): Promise<void>;'), {}, 2, /cancel is reserved for the async method's CancelToken/],
  ['then on a native object', `export interface O extends NativeObject {\n  then(): void;\n}\n${mod('  o(): O;')}`, {}, 2, /then is reserved/],
  ['then on the module', mod('  then(): void;'), {}, 2, /then is reserved/],
  ['optional field of nullable alias', `type N = number | null;\ninterface R {\n  a?: N;\n}\n${mod('  f(r: R): void;')}`, {}, 3, /optional field of a nullable type has three states/],
  ['optional param of nullable alias', `type N = number | null;\n${mod('  f(a?: N): void;')}`, {}, 3, /optional parameter of a nullable type has three states/],
  ['external native object', `import type {O} from './o';\n${mod('  o(): O;')}`,
    {o: "import type {NativeObject} from '@rnrs/runtime/spec';\nexport interface O extends NativeObject {\n  v(): number;\n}\n"},
    3, /native object interface O must be declared in the spec file/],
  ['associated type name collision', `export interface Counter extends NativeObject {\n  v(): number;\n}\ninterface CounterImpl {\n  a: number;\n}\n${mod('  c(): Counter;\n  f(x: CounterImpl): void;')}`, {}, 4, /CounterImpl collides with the associated type generated for native object Counter/],
];

for (const [name, body, files, line, pattern] of reviewCases) {
  test(`rejects ${name}`, () => {
    const diagnostics = diagnose(body, files);
    const hit = diagnostics.find(d => pattern.test(d.message));
    assert.ok(hit, `no diagnostic matching ${pattern}: ${JSON.stringify(diagnostics)}`);
    assert.equal(hit.line, line + 1, `line of ${JSON.stringify(hit)}`);
  });
}

test('an aliased Promise is an async method', () => {
  const file = path.join(dir, 'alias-async.spec.ts');
  writeFileSync(file, `import type {NativeModule} from '@rnrs/runtime/spec';\ntype Later = Promise<number>;\nexport interface M extends NativeModule {\n  foo(x: number): Later;\n  cancelled(cancel: number): number;\n}\n`);
  const {ir, diagnostics} = parseSpec(file, {frameworkSpec: FRAMEWORK_SPEC, root: ROOT});
  assert.deepEqual(diagnostics, []);
  assert.equal(ir.methods.find(m => m.name === 'foo').async, true);
  assert.deepEqual(ir.methods.find(m => m.name === 'foo').returns, {k: 'number'});
  assert.equal(ir.methods.find(m => m.name === 'cancelled').async, false, 'cancel is only reserved for async methods');
});

test('an imported record (one declaration) is accepted', () => {
  const diagnostics = diagnose(`import type {Size} from './shared';\n${mod('  f(s: Size): number;')}`,
    {shared: 'export interface Size {\n  w: number;\n}\n'});
  assert.deepEqual(diagnostics, []);
});

test('a spec installed under node_modules (every consumer) keeps its native objects', () => {
  const pkg = path.join(dir, 'node_modules/@x/m');
  mkdirSync(pkg, {recursive: true});
  const file = path.join(pkg, 'm.spec.ts');
  writeFileSync(file, `import type {NativeModule, NativeObject} from '@rnrs/runtime/spec';\nexport interface O extends NativeObject {\n  v(): number;\n}\nexport interface M extends NativeModule {\n  o(): O;\n  later(): Promise<O>;\n}\n`);
  const {ir, diagnostics} = parseSpec(file, {frameworkSpec: FRAMEWORK_SPEC, root: ROOT});
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.objects.map(o => o.name), ['O']);
  assert.deepEqual(ir.methods.find(m => m.name === 'later').returns, {k: 'native', name: 'O'});
});

test('ArrayBuffer maps to bytes everywhere a value type can appear', () => {
  const file = path.join(dir, 'bytes.spec.ts');
  writeFileSync(file, `import type {NativeModule} from '@rnrs/runtime/spec';\ninterface R {\n  data: ArrayBuffer;\n  opt?: ArrayBuffer;\n}\nexport interface M extends NativeModule {\n  f(a: ArrayBuffer, b: ArrayBuffer[], c: ArrayBuffer | null, r: R): Promise<ArrayBuffer>;\n}\n`);
  const {ir, diagnostics} = parseSpec(file, {frameworkSpec: FRAMEWORK_SPEC, root: ROOT});
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.methods[0].params.map(p => p.type), [{k: 'bytes'}, {k: 'array', of: {k: 'bytes'}}, {k: 'nullable', of: {k: 'bytes'}}, {k: 'record', name: 'R'}]);
  assert.deepEqual(ir.methods[0].returns, {k: 'bytes'});
});

test('a valid spec has no diagnostics', () => {
  assert.deepEqual(diagnose(`export interface O extends NativeObject {\n  v(): number;\n}\n${mod('  o(x?: number): O;\n  p(): Promise<void>;')}`), []);
});
