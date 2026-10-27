# TypeScript → Rust types

Declare types in your `.spec.ts`; rnrs generates the Rust traits, structs and enums.
Every method returns `Result<T, String>`: `Err` throws in JS or rejects an async call.

| TypeScript | Rust | Notes |
| --- | --- | --- |
| `number` | `f64` | Includes NaN, infinities and negative zero. Validate integer/range requirements yourself. |
| `boolean` | `bool` | No truthiness coercion. |
| `void` result | `()` | Return `Ok(())`. |
| `string` | `String` | Owned UTF-8 copy; lone UTF-16 surrogates become U+FFFD. |
| `T[]`, `readonly T[]`, `Array<T>` | `Vec<T>` | Owned copy; nested arrays are supported. |
| Record interface or object type alias | Generated `struct` | Fields become `snake_case`; unknown input fields are ignored. |
| Optional field or trailing parameter `x?: T` | `Option<T>` | Missing/`undefined` → `None`; `null` is rejected. Optional output fields with `None` are omitted. |
| `T \| null` | `Option<T>` | `null` → `None`; `undefined` is rejected. `None` returns as `null`. |
| Named discriminated union | Generated `enum` | String tag selects a variant; see below. |
| `Record<string, T>` | `BTreeMap<String, T>` | A dictionary of a plain object's own keys; see below. |
| `JsonValue` from `@rnrs/runtime/spec` | `rnrs::JsonValue` | A JSON data-model value; see below. |
| `ArrayBuffer` | `Vec<u8>` | Input is copied. Native output transfers ownership to JS; web output is copied. |
| Interface extending `NativeObject` | Generated trait and `Native<T>` handle | A persistent Rust object, not a value copy. |
| `Promise<T>` result | `async fn` returning `Result<T, String>` | Receives a `CancelToken`; see [async methods](generator.md#async-methods). |

## Records

```ts
export interface Point {
  x: number;
  y: number;
  label?: string;
}
```

```rust
pub struct Point {
    pub x: f64,
    pub y: f64,
    pub label: Option<String>,
}
```

Fields are read once in declaration order using ordinary JavaScript property access.
Inherited values and getters count. Getter and proxy exceptions propagate unchanged.
Mutating the Rust value does not mutate the original JS object.

## Tagged unions

```ts
export type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'rect'; width: number; height: number }
  | { kind: 'empty' };
```

```rust
pub enum Shape {
    Circle { radius: f64 },
    Rect { width: f64, height: f64 },
    Empty,
}
```

The tag must be a required string-literal field present in every variant, with a distinct value
for each. rnrs infers it; if several fields qualify, add `/** @discriminator kind */` above
the alias. Unknown tags are rejected. Additional constant literal fields are checked on input
and restored on output, rather than stored in Rust.

Variants can be named records or inline objects. Records, arrays, nullable values and async
results can contain named unions.

## Dictionaries and JSON values

```ts
import type { JsonValue, NativeModule } from '@rnrs/runtime/spec';

export type Row = Record<string, JsonValue>;

export interface Db extends NativeModule {
  query(sql: string, params: JsonValue[]): Row[];
  counts(): Record<string, number>;
}
```

```rust
use std::collections::BTreeMap;
use rnrs::JsonValue;

fn query(&self, sql: String, params: Vec<JsonValue>) -> Result<Vec<BTreeMap<String, JsonValue>>, String>;
fn counts(&self) -> Result<BTreeMap<String, f64>, String>;
```

`Record<string, T>` takes any supported value type `T`, including records, unions, nested
records and `JsonValue`. Keys must be `string`; index signatures are rejected in favour of
`Record<string, T>`.

`JsonValue` is `null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }`.
In Rust it is the enum `JsonValue { Null, Bool(bool), Number(f64), String(String),
Array(Vec<JsonValue>), Object(BTreeMap<String, JsonValue>) }`. It is converted value by
value; no JSON text is produced. The generator recognizes the framework's declaration, so a
type that is merely named `JsonValue` gets no special handling. `JsonValue | null` is
rejected because `JsonValue` already includes `null`. Use `x?: JsonValue` to tell an absent
value (`None`) from `null` (`Some(JsonValue::Null)`).

Both types read objects differently from records:

- The object must be plain: its prototype must be `Object.prototype` or `null`. Arrays,
  functions, native objects, `Date`, `Map`, class instances, buffers and objects from other
  realms are rejected rather than read as `{}`. Proxies of plain objects are accepted.
- Entries are read like `Object.entries`: own, enumerable, string-keyed properties in JS
  property order. Inherited, non-enumerable and symbol keys are ignored. All entries are read
  first, then converted in order; conversion stops at the first error. Getters run once, and a
  key that a getter deletes before its turn is skipped, as in `Object.entries`.
  Exceptions from getters and proxy traps propagate unchanged.
- Keys are copied to UTF-8 like any string. Two keys that become the same Rust string (lone
  surrogates become U+FFFD) are rejected.
- Rust keeps no insertion order. Output objects are new ordinary objects whose keys are
  created in `BTreeMap` order; JS then lists integer-like keys first. Every key, including
  `__proto__` and `constructor`, is defined as an own data property. No setter runs and no
  prototype changes.

`JsonValue` numbers must be finite. NaN and infinities are a TypeError on input and on
output; `-0` is kept. `undefined`, functions, symbols and bigints are rejected at their path,
for example `v.rows[2].price must be a finite number (JsonValue), got NaN`. `toJSON` is never
called. Arrays and objects may nest 128 levels deep in either direction; deeper values,
including cyclic ones, are a RangeError.

## Arrays and bytes

`number[]` becomes `Vec<f64>`, while `ArrayBuffer` becomes `Vec<u8>`.

- Arrays use normal indexed reads, in order, and stop at the first invalid element. Their
  length is read once. Holes read through the prototype chain, normally yielding `undefined`.
- Proxies of arrays are accepted. Typed arrays and array-like objects are not JS arrays.
- Buffer inputs must be ordinary, fixed-size `ArrayBuffer`s. Typed-array views, `DataView`,
  shared, resizable, detached and proxied buffers are rejected.
- To pass a view, copy its range: `view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)`.
  The source buffer must itself be an ordinary `ArrayBuffer`.
- There are no borrowed input slices. Async operations retain their own input copies.

## Native objects

An interface extending `NativeObject` describes a Rust object held by reference. Its generated
trait is implemented by an associated type of the module, such as `type CounterImpl = Counter`.
Methods receive and return `Native<T>` handles; rnrs validates their type, runtime and liveness.

Module methods can use any native-object type declared in the spec. Object methods can use
only their own native-object type. Native objects cannot be embedded in records or unions;
arrays of native objects returned by object methods are unsupported.

Call `dispose()` when finished with an object. See the [counter tutorial](headless.md) for
objects passed to and returned from Rust, and [ownership](ownership.md) for async lifetimes.

## Validation and limits

Values are checked, not coerced. An error identifies its path, for example
`points[1].x must be a number, got a string`. Output fields are own data properties, so
inherited setters do not intercept them.

Since 0.2.0, input reads include inherited properties. In particular, an absent optional field
named `toString` reads the inherited function, not `undefined`, and can fail its type check.
Output semantics are unchanged. These rules are not a sandbox against arbitrary patched JS built-ins.

Unsupported types include:

- `any`, `unknown`, `object`, `bigint`, `symbol`, callbacks, tuples, `Date`, `Map` and `Set`.
- `Record` with keys other than `string`, and index signatures.
- Generics, classes, TypeScript enums, recursive records and record inheritance.
- Untagged or anonymous unions, plain literal unions, and number/boolean discriminators.
- `T | undefined`, optional-plus-nullable values (`x?: T | null`), and `Promise` in arguments or fields.

See [spec rules](generator.md#spec-rules) for method and naming restrictions.
