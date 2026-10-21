# Generator: TS spec → Rust interface → bindings

See [ownership](ownership.md) for lifecycle rules and [status](status.md) for platform validation and limits.

## What a module author writes

| Author-visible | Where | Committed |
| --- | --- | --- |
| TypeScript spec | `packages/<name>/<name>.spec.ts` | yes |
| Package config: targets, spec, Rust crate, module type, default `maxInFlight` | `packages/<name>/package.json` (`rustNative`) | yes |
| Generated Rust interface: traits, records, enums | `packages/<name>/rust/src/rnr_interface.rs` | yes, checked by `rnr-gen check` |
| Rust implementation of those traits | `packages/<name>/rust/src/lib.rs` | yes |

The author writes no C++, Kotlin, Java, Swift, JSI or wasm-bindgen code. Everything else is generated build output under the ignored `.generated/rnr/` directory, or handwritten framework infrastructure shared by every module:

- `<crate>/glue.rs`: Rust dispatch and conversions, generic over `rnrs_core::bind::Env`.
- `<crate>/index.ts`: the JS wrapper classes.
- `<crate>/ir.json`.
- `bundle-android.rs` and `bundle-web.rs`: the per-target module lists.

In this repository, the lab lists its module packages in the root `package.json` (`rustNativeApp.packages`) for `generate` and `check`. Packaged apps instead discover modules from their dependencies, and build per-app bundles with generated dependency lists; see [packaging](packaging.md).

## Spec rules (M1)

```ts
import type {NativeModule, NativeObject} from '@rnrs/runtime/spec';

export interface Counter extends NativeObject {
  add(delta: number): number;
  addLater(delta: number, delayMs: number, uncancellable: boolean): Promise<number>;
}
export interface CounterModule extends NativeModule {   // exactly one per spec
  create(initial: number): Counter;
}
```

Spec rules:

- `number` is always `f64`, including NaN, infinities and negative zero; there are no integer annotations. `boolean` is `bool`. A `void` result is `()`.
- Optional trailing parameters `x?: T` become `Option<T>`.
- `Promise<T>` is allowed only as a method result, which makes the method async.
- A `NativeObject` interface becomes a Rust trait, implemented by an associated type of the module trait (`type CounterImpl: Counter`). Native objects may be passed and returned by module methods. Object methods may take or return only their own type for now.
- Method order in the spec is the call index. The IR hash (sha256 of the position-free IR) is embedded in the Rust glue and in the JS wrapper. Installing a module whose two sides have different hashes fails with a "generated from different specs" error, so a stale side is never used silently.

Everything else is rejected with `file:line:column` and a message. The diagnostics test covers 56 cases (M1–M3), including:

- `any`, `unknown`, `object`, `bigint` and `symbol`;
- `Date`, `Map`, `Set`, `Record`, tuples and callbacks;
- `T | undefined`, `x?: T | null` and untagged or anonymous unions;
- literal types outside unions;
- generics, overloads, optional methods, rest parameters and properties in native interfaces;
- `Promise` outside results;
- classes and enums;
- reserved wrapper names (`dispose`, `teardown`, ...);
- zero or two `NativeModule`s;
- TypeScript errors.

## Value types (M2)

| TypeScript | Rust | Conversion |
| --- | --- | --- |
| `string` | `String` | Owned UTF-8 copy. Lone UTF-16 surrogates become U+FFFD on both backends (Hermes `utf8()` and wasm-bindgen's TextEncoder). Embedded NUL round-trips. |
| `T[]`, `readonly T[]`, `Array<T>` | `Vec<T>` | Element by element, nested arrays included. A hole reads as `undefined` and is rejected unless the element type accepts it. Typed arrays and array-likes are not arrays. |
| `interface R { ... }` or `type R = { ... }` | `pub struct R` | Field by field, in declaration order, each property read once. Getters and proxy traps run, and their exceptions propagate unchanged. Other properties are ignored. Native wrappers, arrays, functions and null are not records. |
| `field?: T`, `param?: T` | `Option<T>` | Missing or `undefined` is `None`; `null` is rejected. `None` is omitted on output. |
| `T \| null` | `Option<T>` | `null` is `None`; `undefined` is rejected. `None` becomes `null` on output. |

Errors name the failing path, for example `TypeError: l.points[1].x must be a number, got a string`. The following are rejected with diagnostics: `x?: T | null` (three states), `T | undefined`, string-literal fields outside unions, methods and index signatures in records, record inheritance, recursive records, and native objects inside records.

Conversions are generated free functions (`from_js_<record>`, `into_js_<record>`), composed through closures for arrays and options. No JSON or serde layer is involved. A JS getter that disposes the receiver during argument conversion surfaces as `Bag is disposed`: arguments are converted first, and the receiver is then taken as an owned clone.

## Discriminated unions (M3)

```ts
export type Shape =
  | {kind: 'circle'; radius: number}
  | {kind: 'rect'; width: number; height: number}
  | {kind: 'empty'};

/** @discriminator kind */
export type Tagged =
  | {kind: 'round'; category: 'curved'; r: number}
  | {kind: 'square'; category: 'angular'; side: number};
```

These become Rust enums with payloads: `Shape::Circle { radius }`, `Shape::Rect { width, height }` and the unit variant `Shape::Empty`. The variant name comes from the tag (`"two-words"` becomes `TwoWords`). The discriminator follows the rules in the spec contract below:

- A candidate field is present and required in every variant, has one string-literal value in each, and differs between variants.
- Exactly one candidate is used.
- No candidate is an error.
- Several candidates require `/** @discriminator field */`, which must name a candidate.

The enum carries no independently mutable discriminator. Other constant literal fields (`category`) are not stored. On input they are checked (`t.category must be "curved"`); on output they are restored together with the discriminator.

Variants may be inline object types or named interfaces and aliases. Unions may nest in records and arrays, contain optional and nullable fields, be nullable themselves (`Shape | null`), and be async results.

The following are rejected with diagnostics:

- unknown tags (`s.kind: unknown Shape tag "triangle"; expected one of ...`);
- missing or non-string tags;
- unions without a discriminator, with an ambiguous discriminator, or with a bad annotation;
- non-object variants and optional discriminators;
- tags that collide as Rust names or are not valid identifiers;
- anonymous unions and native objects in variants.

## ArrayBuffer (bytes)

`ArrayBuffer` in a spec becomes `Vec<u8>`, in parameters, results, records, arrays and nullable values, and for sync and async methods alike.

- **Input: an owned copy.** The framework `bufferKind` helper brand-checks the value using intrinsic getters captured at init. Typed arrays, `DataView`, `SharedArrayBuffer`, resizable buffers and detached buffers are rejected with path-specific `TypeError`s, as are proxies and objects that merely inherit from `ArrayBuffer.prototype`. The copy is made inside the same backend call, with no JS run between the check and the end of the copy.
  - **Length and copy.** On Android the adapter takes the size and storage from the engine (JSI `ArrayBuffer::size`/`data`). In the browser, the brand-checked byte length comes from the captured `ArrayBuffer.prototype.byteLength` getter. The copy is made by a framework helper using the captured `Uint8Array` constructor, `%TypedArray%.prototype.set` and `WebAssembly.Memory.prototype.buffer` getter. It rechecks the buffer, requires the same length the Rust side allocated, and bounds-checks the destination. A patched `length`, `byteLength`, `detached` or `resizable` getter therefore cannot cause a short or long copy; this is tested in Chromium with all of them poisoned. The wasm-bindgen glue itself still reads typed-array `byteLength` for its own memory view (string passing): one of the dynamic lookups listed under Scope.
  - **Allocation.** The input copy is zero-initialized storage reserved with `try_reserve_exact`. If it cannot be allocated, the call fails with a RangeError (`… is too large: its copy could not be allocated`) instead of aborting the process or the Wasm instance. Allocations made later by the module itself follow normal Rust rules: out of memory aborts.
  - The copy is a snapshot taken when that argument or field is converted. Fields are converted in declaration order, so a later field's getter cannot change bytes already copied. Mutating the buffer after the call cannot affect an async operation.
  - Empty buffers become empty `Vec`s; there is never a `memcpy` or slice from a null pointer.
- **No views.** The TS contract is `ArrayBuffer` only. Callers slice explicitly: `view.buffer.slice(start, end)`. The generator rejects `Uint8Array`, the other typed arrays, `DataView`, `ArrayBufferLike` and `SharedArrayBuffer` in specs.
- **No borrowed slices.** There is no zero-copy input path. The numeric lab's controlled borrow remains an isolated experiment, not an API.
- **Not excluded: writers outside JS.** Native code holding an external buffer's storage could write to it concurrently. JSI cannot detect or exclude that, so such buffers are unsupported.
- **Engine support.** Rejections apply only where an engine can produce the state. Hermes in RN 0.83.1 on the test device has no `SharedArrayBuffer`, no resizable buffers and no `transfer()`, so those states cannot occur there. Chromium (served cross-origin isolated) has all three, and all three are rejected.
- **Output on Android: the storage is adopted.** The Rust `Vec` becomes a `jsi::MutableBuffer` owned by the new ArrayBuffer; Rust keeps no access, and JS may read and write the bytes. The engine destroys it when the buffer is collected or the runtime is destroyed, possibly off the JS thread, and the release is a thread-safe Rust drop, exactly once.
  - **Fallback.** If the engine refused external storage, the bytes would be copied into a buffer made by the captured `ArrayBuffer` constructor (helper `allocBuffer`, not the global). The adapter verifies it is an ArrayBuffer of the right size with storage before writing; on any failure there, including out of memory, it aborts, as this entry has no error channel. The fallback is counted as `bytesCopiedOut` (0 on the device in normal runs). Hermes never refuses, so a test hook (`forceBytesCopyOutForTesting`) forces the path, with the `ArrayBuffer`/`Uint8Array` globals and the getters patched.
- **Output in the browser: a copy.** Results are copied out of Wasm memory into a new ArrayBuffer (since Wasm memory can grow and move), by a helper with the same captured intrinsics. There is no zero-copy promise on either platform.

## Conversion semantics and safety (after the generator review)

These rules are shared by both backends. They are implemented with framework helpers (`conversionHelpers` in `packages/runtime/src/runtime.ts`) whose intrinsics are captured when that module initializes. The Android adapter receives the helpers with every call; JSI alone has no own-property read or define.

- **Scope.** These rules resist inherited data properties and inherited setters (prototype pollution). They are not a hardened sandbox. Code in the same JS realm can still monkey-patch functions the backends look up when called: wasm-bindgen's `Array.of`, `Function.prototype.call` and `Reflect.get` imports on the web, and the writable `__rnrSettle` global on Android.
- **Own properties only.** A record field, union tag or array element is read only if it is an own property (`hasOwnProperty`). Own getters and proxy traps run, and their exceptions propagate unchanged. Inherited values never fill a missing field or an array hole: a polluted `Object.prototype.note` or `Array.prototype[1]` is ignored.
- **Outputs are own data properties.** They are defined with `Object.defineProperty` and a null-prototype descriptor, so inherited setters (`Object.prototype.x`) and descriptor-shaped prototype properties (`Object.prototype.get`) cannot intercept or break output. Results are ordinary objects and arrays. Arguments travel as one framework-built array literal, with no spread or rest on the call path; Hermes's rest path was observed to be affected by an `Array.prototype` setter.
- **Arrays and proxies.** An array is anything for which `Array.isArray` is true, which includes proxies of arrays on both platforms. `length` is read through the helper, so traps run. A length that is not an integer in `0..=2^32-1` is rejected, and a throwing trap propagates its exception. A revoked proxy is reported as `an unsupported value`, because JSI `isArray` and `Array.isArray` throw for it. Proxies are not detected or rejected otherwise; no portable API distinguishes them.
- **Revalidation.** After converting all arguments, which can run JS, the generated glue checks that the adapter is still open. A native receiver is taken as an owned clone, and its generation and liveness are checked live. A getter that tears the module down therefore makes the call fail with `runtime adapter is closed` before any method side effect, on both backends.
- **No unwinding into Rust.** Every C++ vtable entry and C callback the Rust side calls catches everything. Fallible entries report JS exceptions; infallible ones (value creation) abort on failure rather than unwind across the boundary. Foreign pointers become slices only through `slice_or_empty`, because an empty `std::vector` may pass a null `data()` and `from_raw_parts(null, 0)` is undefined behaviour.
- **Name and type rules** (diagnostics with file:line):
  - Field, parameter and method names must be identifiers that are unique after `snake_case` (`aB` and `a_b` collide). `self`, `super` and `crate` are rejected, as is `__proto__`. Keywords become raw identifiers.
  - Type names must be PascalCase and not shadow names the generated code uses (`Result`, `Option`, `Self`, ...).
  - `then` is reserved on modules and native objects, since wrappers would otherwise be thenables.
  - `cancel` is reserved as an async parameter name, and `validate<Method>` collisions are rejected.
  - Generated argument and union-field locals are prefixed, so names like `env`, `receiver`, `object` or `value` are safe.
- **Type identity.** Records and unions are identified by declaration. Two distinct declarations with one name (for example the same name imported from two files) are rejected with both locations. Declaration merging of records, native objects or modules is rejected. Native objects must be declared in the spec file. An optional field or parameter whose type alias is nullable is rejected (three states).

## Generated Rust interface

From `packages/counter/counter.spec.ts` (`packages/counter/rust/src/rnr_interface.rs`, abridged):

```rust
pub trait Counter: NativeObject {
    fn add(&self, delta: f64) -> Result<f64, String>;
    /// Runs on the JS thread before admission: an error rejects the call without starting work.
    fn validate_add_later(&self, _delta: &f64, _delay_ms: &f64, _uncancellable: &bool) -> Result<(), String> { Ok(()) }
    fn add_later(&self, delta: f64, delay_ms: f64, uncancellable: bool, cancel: CancelToken)
        -> impl Future<Output = Result<f64, String>> + MaybeSend;
}
pub trait CounterModule: NativeObject + Default {
    type CounterImpl: Counter;
    fn create(&self, initial: f64) -> Result<Native<Self::CounterImpl>, String>;
}
```

Signature conventions:

- **Async methods.** Authors implement them as ordinary `async fn` taking `&self`. The glue keeps an owned `Native` clone of the receiver in the task, so the future may borrow `self`.
- **Send bounds.** `MaybeSend` and `NativeObject` mean `Send` and `Send + Sync` on native targets, and no bound on Wasm. The Counter `add_later` future is therefore `Send` natively and uses browser timers locally on the web, from the same author code.
- **Validation.** `validate_*` hooks (default: accept) are how an implementation rejects arguments before admission.
- **Module instance.** The module type implements `Default`: one instance per adapter generation, with per-runtime state.

## Errors and execution

Generated methods return `Result<T, String>`. An error throws a JS exception for a synchronous call or rejects the Promise for an async call. Native bundles use `panic = "abort"`: Rust panics are not recoverable JS errors and must not unwind through the native ABI.

Ordinary methods run synchronously on the calling JS thread. Returning a Promise does not make blocking work safe: native CPU-heavy work needs explicit bounded scheduling, and browser futures run on the main thread. There is no app-selected or bring-your-own executor API. Native async futures require Send; browser-local futures do not.

Converted strings, records and arrays have value semantics: mutating a Rust value does not mutate the original JS value. Native handles retain objects instead. Custom binary formats are application-defined bytes; the generator adds no serde, typed-layout reinterpretation or format validation.

## Runtime structure

```text
JS wrapper (generated TS) ─┬─ packages/runtime/src/runtime.ts (promises, cancellation, singletons)
                           ├─ Android: __rnrRuntime.install → cpp/RnrJsi.cpp (generic JSI adapter, shared with iOS)
                           │            → rust/rnrs-android C ABI → generated glue
                           └─ Browser: packages/runtime/src/web-backend.ts → rust/rnrs-web (wasm-bindgen)
                                        → generated glue
generated glue ── rnrs_core::bind::Env ── author traits ── rnrs-core Host / Budget / Native
```

The generated glue converts each argument through `Env` and has no per-platform code. Android implements `Env` with a C function table over the C++ call context: values are indices into a per-call `jsi::Value` arena, and native objects are `NativeBox` pointers owned by `jsi::NativeState`. The browser implements it over `js_sys`. One conversion implementation therefore serves both platforms, with no serialization detour.

Hazards the design guards against:

| Hazard | Guard |
| --- | --- |
| Handle escape | `Val` handles carry the epoch of their call; backends reject handles from another call. Glue never stores them or holds them across an await. |
| Borrowed receivers | Native receivers and arguments are taken as owned `Native` clones after the arguments are converted. A getter that disposes an object therefore cannot invalidate a borrow, and the same object passed twice is two owners. |
| Forged or foreign wrappers | Android wrappers are `NativeState` objects. Browser wrappers are frozen objects resolved through a module-private `WeakMap`. Both are checked for module, generation, disposal and spec type. |
| Async results | Results are converted on the JS thread at settlement, by the same generated code (`pending(...)`). |

Admission failures carry the Rust error text (`{code, message}`).

## Build and reproducibility

Since the review, the Rust glue is written by each bundle crate's `build.rs` into that crate's own `OUT_DIR` (`rnr-gen build-outputs --out $OUT_DIR --target <t> --manifest Cargo.toml`). Cargo owns the output, parallel build scripts never share files, and deleting `.generated/` cannot break an incremental build. The build fails unless the crate depends on exactly the module crates whose `rustNative.targets` include its target. All generator writes are atomic (write then rename). `.generated/rnr/` holds the TS wrappers, used by `tsc` and Metro, plus inspection copies of the glue. `scripts/check-generation.sh` checks three things: deleting `.generated/rnr` and rebuilding without `cargo clean`, an incremental spec change, and three bundle crates building in parallel.

Earlier description (still accurate apart from the glue location):

- `node tools/rnrs-gen/cli.mjs generate` writes the interfaces and the hidden outputs. Unchanged files are not rewritten.
- `node tools/rnrs-gen/cli.mjs check` fails if a committed interface differs from what the spec produces.
- The `build.rs` of `bind-tests` (formerly also `lab-android` and `web-bundle`, now replaced by per-app bundles) calls `rnrs-build`. That runs `rnr-gen build-outputs`, which regenerates the hidden glue from the checked-in inputs, fails the build if a committed interface is stale, and declares cargo dependencies on the specs, packages and generator.
- Verified from a clean export of the tree with no `.generated/`: `rnr-gen check`, `cargo test --workspace --all-features` (which regenerated all hidden glue) and `tsc` all passed.

## Limits

- The error type is `String`, and the error schema is open.
- Platform and toolchain coverage is fixture-specific; see [status](status.md).
- Not yet supported: tuples, `Record<string, T>`, typed-array views (by design: ArrayBuffer only), number-literal or boolean-literal discriminators, recursive types, and generic types. Native objects inside records or unions, and in arrays returned by object methods, are also unsupported. Object methods may use only their own native type.
- The helper intrinsics are captured when `@rnrs/runtime`'s `src/runtime.ts` first loads. Prototype changes made before that point are not defended against.
- The own-property guarantees address inherited data/setter pollution, not arbitrary monkey-patching of built-ins. Review probes confirmed browser wasm-bindgen glue still looks up facilities such as `Array.of`, `Function.prototype.call`, and `Reflect.get` dynamically; replacing them can intercept calls or corrupt async results. Android's diagnostic global `__rnrSettle` is also writable. These are limits, not a security isolation boundary.
- On the web, the settle call builds its argument list with `Array.of`.
- Each property read or define is a JS helper call (on Android, from C++ through JSI); the cost is unmeasured.
- Unknown record properties are ignored (no strict mode). Unions dispatch on the discriminator only; there is no structural matching.
- Each property read crosses the backend boundary once (on Android, one C call into JSI). Conversion cost has not been measured; no performance claims are made.
- JS wrapper identity is not preserved across repeated returns of the same native object.
- The browser uses no shared executor budget, matching the earlier prototype.
- The test hooks of the runtime remain: `create…ForTesting`, `teardown()`, `uncancellable`, the stats and lifecycle diagnostics.
