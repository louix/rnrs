// Declared errors (spec `Throws<T, E>`): where the marker is accepted, what E may be, the IR
// it adds (only when used), and the generated Rust trait and TS wrapper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseSpec } from '../parse.mjs';
import { emitGlue, emitInterface, scalarEligible, valueTypesWithNatives } from '../emit-rust.mjs';
import { emitTs } from '../emit-ts.mjs';
import { FRAMEWORK_SPEC, ROOT } from '../cli.mjs';

const dir = path.join(ROOT, '.generated/rnrs-test-specs/declared-errors');
mkdirSync(dir, { recursive: true });
let n = 0;

const HEADER =
  "import type {NativeModule, NativeObject, Throws} from '@rnrs/runtime/spec';\n" +
  "export type E = { kind: 'a' } | { kind: 'b'; at: number };\n";

function parse(body, header = HEADER) {
  const file = path.join(dir, `case${n++}.spec.ts`);
  writeFileSync(file, `${header}${body}\n`);
  return parseSpec(file, { frameworkSpec: FRAMEWORK_SPEC, root: ROOT });
}

const mod = (members, name = 'M') =>
  `export interface ${name} extends NativeModule {\n${members}\n}`;

// [name, body, line of the diagnostic in the body (1 = first body line), pattern]
const rejected = [
  [
    'Throws as a parameter',
    mod('  f(x: Throws<number, E>): void;'),
    2,
    /only supported as the whole method result/,
  ],
  [
    'Throws inside Promise',
    mod('  f(): Promise<Throws<number, E>>;'),
    2,
    /write Throws<Promise<T>, E>/,
  ],
  [
    'nested Throws',
    mod('  f(): Throws<Throws<number, E>, E>;'),
    2,
    /only supported as the whole method result/,
  ],
  [
    'an array of Throws',
    mod('  f(): Throws<number, E>[];'),
    2,
    /only supported as the whole method result/,
  ],
  [
    'a nullable Throws',
    mod('  f(): Throws<number, E> | null;'),
    2,
    /only supported as the whole method result/,
  ],
  [
    'Throws in a field',
    `interface R {\n  x: Throws<number, E>;\n}\n${mod('  f(r: R): void;')}`,
    2,
    /only supported as the whole method result/,
  ],
  [
    'a string error',
    mod('  f(): Throws<number, string>;'),
    2,
    /omit Throws for the default String error/,
  ],
  [
    'an array error',
    mod('  f(): Throws<number, E[]>;'),
    2,
    /must be a named record or tagged union/,
  ],
  [
    'a nullable error',
    mod('  f(): Throws<number, E | null>;'),
    2,
    /must be a named record or tagged union/,
  ],
  [
    'a JsonValue error',
    `import type {JsonValue} from '@rnrs/runtime/spec';\n${mod('  f(): Throws<number, JsonValue>;')}`,
    3,
    /must be a named record or tagged union/,
  ],
  [
    'an inline object error',
    mod("  f(): Throws<number, { kind: 'x' }>;"),
    2,
    /name this object type/,
  ],
  [
    'a native object error',
    `export interface O extends NativeObject {\n  v(): number;\n}\n${mod('  f(): Throws<number, O>;')}`,
    5,
    /must be a named record or tagged union/,
  ],
  // Declared errors are plain data: the shared transitive rule (emit-rust holdsNative).
  [
    'an error record holding a handle',
    `export interface O extends NativeObject {\n  v(): number;\n}\nexport interface Held {\n  o: O;\n}\n${mod('  f(): Throws<number, Held>;')}`,
    8,
    /f: declared errors are plain data; Held contains a native object/,
  ],
  [
    'an error union whose variant holds a Record of handles',
    `export interface O extends NativeObject {\n  v(): number;\n}\nexport type Bad = { kind: 'many'; by: Record<string, O> } | { kind: 'none' };\n${mod('  f(): Throws<number, Bad>;')}`,
    6,
    /f: declared errors are plain data; Bad contains a native object/,
  ],
  [
    'an error holding a record that holds a handle inside a Record',
    `export interface O extends NativeObject {\n  v(): number;\n}\nexport interface Inner {\n  o: O | null;\n}\nexport type Deep = { kind: 'deep'; by: Record<string, Inner[]> } | { kind: 'none' };\n${mod('  f(): Throws<number, Deep>;')}`,
    9,
    /f: declared errors are plain data; Deep contains a native object/,
  ],
  [
    'a missing error type',
    mod('  f(): Throws<number>;'),
    2,
    /Throws needs a result type and an error type/,
  ],
  [
    'a guard colliding with the module accessor',
    mod('  f(): Throws<number, E>;', 'IsE'),
    2,
    /the guard isE generated for E collides with the accessor of IsE/,
  ],
  // Guards are `is` + a PascalCase type name, so two error types cannot differ only in case,
  // and no guard can equal a class name or create…ForTesting.
  [
    'a non-PascalCase error type (no case-only guard collision)',
    `export type kvError = { kind: 'a' } | { kind: 'b' };\n${mod('  f(): Throws<number, kvError>;')}`,
    3,
    /type name kvError must be PascalCase/,
  ],
  [
    'a look-alike Throws (recognized by declaration, not name)',
    `type Throws<T, X> = [X] extends [never] ? T : T;\n${mod('  f(): Throws<number, E>;')}`,
    3,
    /generic types are not supported \(Throws\)/,
    HEADER.replace(', Throws}', '}'),
  ],
];

for (const [name, body, line, pattern, header] of rejected) {
  test(`rejects ${name}`, () => {
    const { diagnostics } = parse(body, header);
    const hit = diagnostics.find((d) => pattern.test(d.message));
    assert.ok(hit, `no diagnostic matching ${pattern}: ${JSON.stringify(diagnostics)}`);
    assert.equal(hit.line, line + 2, `line of ${JSON.stringify(hit)}`); // +2: the header
  });
}

test('Throws: sync, async (also through an alias), object methods and record errors', () => {
  const { ir, diagnostics } = parse(
    [
      'export interface Overflow {\n  limit: number;\n}',
      'type Later = Promise<string>;',
      'type Get = Throws<string, E>;',
      'export interface S extends NativeObject {\n  read(i: number): Throws<number, E>;\n}',
      mod(
        '  get(k: string): Get;\n  load(k: string): Throws<Later, E>;\n  sum(xs: number[]): (Throws<number, Overflow>);\n  half(x: number): Throws<number, E>;\n  plain(x: number): number;\n  open(): S;',
      ),
    ].join('\n'),
  );
  assert.deepEqual(diagnostics, []);
  const byName = Object.fromEntries(ir.methods.map((m) => [m.name, m]));
  assert.deepEqual(byName.get.throws, { k: 'union', name: 'E' });
  assert.deepEqual(
    [byName.load.async, byName.load.returns, byName.load.throws],
    [true, { k: 'string' }, { k: 'union', name: 'E' }],
  );
  assert.deepEqual(byName.sum.throws, { k: 'record', name: 'Overflow' });
  assert.deepEqual([byName.read.owner, byName.read.throws], ['S', { k: 'union', name: 'E' }]);
  // Omitted, not false: specs without Throws keep their IR (and hash).
  assert.ok(!('throws' in byName.plain) && !('throws' in byName.open));
  // Scalar-shaped methods with declared errors take the generic call; String-error ones keep the leaf.
  assert.deepEqual([scalarEligible(byName.half), scalarEligible(byName.plain)], [false, true]);

  const rust = emitInterface(ir);
  assert.match(rust, /fn get\(&self, k: String\) -> Result<String, E>;/);
  assert.match(
    rust,
    /fn load\(&self, k: String, cancel: CancelToken\) -> impl Future<Output = Result<String, E>> \+ MaybeSend;/,
  );
  assert.match(rust, /fn validate_load\(&self, _k: &String\) -> Result<\(\), String>/);
  assert.match(rust, /fn sum\(&self, xs: Vec<f64>\) -> Result<f64, Overflow>;/);
  assert.match(rust, /fn read\(&self, i: f64\) -> Result<f64, E>;/);
  assert.match(rust, /fn plain\(&self, x: f64\) -> Result<f64, String>;/);
  const glue = emitGlue(ir, { crate: 'm', moduleType: 'Module' });
  assert.match(
    glue,
    /Err\(error\) => return Err\(domain_error\(cx\.env, move \|env\| into_js_e\(error, env\)\)\),/,
  );
  assert.match(
    glue,
    /Err\(error\) => pending_declared\(move \|env: &mut dyn Env\| into_js_e\(error, env\)\),/,
  );
  assert.equal((glue.match(/ScalarDef \{/g) ?? []).length, 1, 'only plain has a leaf');

  const ts = emitTs(ir, { runtimeImport: '@rnrs/runtime', maxInFlight: 4 });
  assert.match(
    ts,
    /type DomainError as \$DomainError, isDomainError as \$isDomainError\} from '@rnrs\/runtime'/,
  );
  assert.match(
    ts,
    /protocol: 4, direct: \[\[4, 1\]\], errors: \[\[0, "M\.get", "E", "kind"\], \[1, "M\.load", "E", "kind"\], \[2, "M\.sum", "Overflow", null\], \[3, "M\.half", "E", "kind"\], \[6, "S\.read", "E", "kind"\]\]/,
  );
  assert.match(
    ts,
    /export function isE\(error: unknown\): error is \$DomainError<E> \{\n  return \$isDomainError\(error, M\.descriptor, "E"\);\n\}/,
  );
  assert.match(
    ts,
    /export function isOverflow\(error: unknown\): error is \$DomainError<Overflow>/,
  );
  assert.match(
    ts,
    /test with \{@link isE\}\. \*\/\n  half\(x: number\): number \{\n    return this\.host\.call1\(3, undefined, x\) as number;/,
  );
  assert.match(ts, /plain\(x: number\): number \{\n    return this\.host\.m4\(x\) as number;/);
});

test('error types named like generated classes and hooks do not collide with their guards', () => {
  const { diagnostics } = parse(
    `export interface Snap extends NativeObject {\n  v(): number;\n}\nexport type CreateMForTesting = { kind: 'x' } | { kind: 'y' };\nexport type M2 = { kind: 'x' } | { kind: 'y' };\n${mod('  f(): Throws<number, CreateMForTesting>;\n  g(): Throws<number, M2>;\n  h(): Throws<number, E>;\n  s(): Snap;')}`,
  );
  assert.deepEqual(diagnostics, []);
});

test('specs without Throws keep their IR hash and generated wrapper', () => {
  // The committed interfaces carry the hash they were generated with (before Throws existed
  // for every spec but the values fixture, which declares errors).
  const packages = path.join(ROOT, 'packages');
  const specs = [];
  for (const group of ['', 'fixtures'])
    for (const entry of readdirSync(path.join(packages, group), { withFileTypes: true }))
      if (entry.isDirectory() && !['values', 'fixtures'].includes(entry.name)) {
        const base = path.join(packages, group, entry.name);
        const spec = readdirSync(base).find((f) => f.endsWith('.spec.ts'));
        if (spec)
          specs.push([path.join(base, spec), path.join(base, 'rust/src/rnrs_interface.rs')]);
      }
  assert.ok(specs.length >= 5, specs.join(', '));
  for (const [spec, iface] of specs) {
    const { ir, diagnostics } = parseSpec(spec, { frameworkSpec: FRAMEWORK_SPEC, root: ROOT });
    assert.deepEqual(diagnostics, [], spec);
    let committed;
    try {
      committed = readFileSync(iface, 'utf8');
    } catch {
      continue;
    }
    assert.ok(committed.includes(`// IR hash: ${ir.hash}\n`), `${spec}: IR hash changed`);
    assert.ok(ir.methods.every((m) => !('throws' in m)));
    assert.doesNotMatch(
      emitTs(ir, { runtimeImport: '@rnrs/runtime', maxInFlight: 4 }),
      /protocol: 4|DomainError/,
    );
  }
});

test('the shared native rule tolerates a type the parser dropped after a diagnostic', () => {
  // A record field naming a type that failed to parse (absent from the IR) holds no natives;
  // the earlier diagnostic already fails generation.
  const holds = valueTypesWithNatives({
    records: [{ name: 'A', fields: [{ name: 'b', type: { k: 'record', name: 'Dropped' } }] }],
    unions: [],
  });
  assert.deepEqual([...holds], []);
});
