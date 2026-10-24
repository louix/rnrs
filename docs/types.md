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

- `any`, `unknown`, `object`, `bigint`, `symbol`, callbacks, tuples, `Date`, `Map`, `Set` and `Record`.
- Generics, classes, TypeScript enums, recursive records and record inheritance.
- Untagged or anonymous unions, plain literal unions, and number/boolean discriminators.
- `T | undefined`, optional-plus-nullable values (`x?: T | null`), and `Promise` in arguments or fields.

See [spec rules](generator.md#spec-rules) for method and naming restrictions.
