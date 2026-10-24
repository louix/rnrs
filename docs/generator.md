# Specs and generated bindings

A module is a TypeScript spec and a Rust implementation. rnrs generates the interface between
them; no platform binding code is needed. Start with the [headless tutorial](headless.md) or
[triangle tutorial](triangle.md).

## Spec types

See the [TypeScript → Rust type map](types.md) for supported types, examples and conversion rules.

## Spec rules

Import the markers from `@rnrs/runtime/spec`. Each spec exports exactly one interface extending
`NativeModule`; persistent objects extend `NativeObject`.

```ts
import type { NativeModule } from '@rnrs/runtime/spec';

export interface MathModule extends NativeModule {
  sum(values: number[]): number;
}
```

- Methods have named, typed parameters and an explicit result type. Optional parameters go last.
- `Promise<T>` is allowed only as a method result.
- Overloads, optional methods, rest parameters and properties on native interfaces are rejected.
- Native-object interfaces must be declared in the spec file. Declaration merging is unsupported.
- Type names must be PascalCase. Fields, parameters and methods must remain unique after
  `snake_case` conversion: `aB` and `a_b` collide. Rust keywords become raw identifiers.
- Reserved names such as `self`, `super`, `crate`, `__proto__`, `then`, generated type names and
  wrapper methods such as `dispose` are rejected. Async parameters cannot be named `cancel`.

Invalid specs produce diagnostics with a file, line and column.

## Generate and implement

```sh
npx rnrs generate
npx rnrs test
```

The first command writes `rust/src/rnrs_interface.rs`. Implement its module trait on a type
that implements `Default`; rnrs creates one module instance per runtime generation.

```rust
pub mod rnrs_interface;

#[derive(Default)]
pub struct Module;

impl rnrs_interface::MathModule for Module {
    fn sum(&self, values: Vec<f64>) -> Result<f64, String> {
        Ok(values.into_iter().sum())
    }
}
```

Synchronous methods run on the calling JS thread. Return `Err(String)` for an input-dependent
failure; panics abort rather than become JS errors. Strings, records, arrays and buffers have
value semantics. Native objects use reference-counted handles.

## Async methods

A spec method `load(id: string): Promise<string>` generates an async method with owned arguments
and a final cancellation token. Implement it as an ordinary Rust `async fn`:

```rust
async fn load(&self, id: String, cancel: rnrs::CancelToken) -> Result<String, String> {
    // Await your Rust operation and cooperate with cancellation.
    todo!()
}
```

- Native futures must be `Send`; browser futures are local. The module and native-object
  implementations must be `Send + Sync` on native targets.
- A generated `validate_<method>` hook accepts arguments by reference before async admission;
  its default implementation accepts them.
- Call from JS with `module.load(id, { signal })` to request cancellation. Cancellation is
  cooperative, and in-flight work retains its arguments and receiver.
- A Promise does not make blocking code safe. Use bounded scheduling for native CPU work;
  browser futures run on the main thread.

See [ownership and lifecycle](ownership.md) for concurrency, cancellation and teardown.

## Generated files and compatibility

| Output | Purpose |
| --- | --- |
| `rust/src/rnrs_interface.rs` | Traits, records and enums implemented by the author. |
| Package `rnrs/` directory | JS wrappers and type declarations. |
| App `.rnrs/` directory | Target-specific bundle crates and module lists. |
| Cargo `OUT_DIR` | Per-build Rust glue. |

The generated wrapper and Rust glue carry a spec hash. Installation refuses mismatched specs.
Call-protocol and native-entry checks reject incompatible bindings with an update or rebuild
message. Upgrade framework packages together, regenerate bindings and rebuild native apps.

The app build generates its own glue; authors do not maintain platform-specific implementations.
See [packaging](packaging.md) for package metadata, supported targets and lock files.
