// Spec markers imported by module specs as '@rnrs/runtime/spec' (see tools/rnrs-gen).
// They carry no members: the generator recognizes them by declaration, not by shape.

/** A persistent native object, implemented by a Rust type the module chooses. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NativeObject {}

/** The module itself: exactly one per spec. Its methods are the module's entry points. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NativeModule {}

/** A JSON data-model value: becomes `rnrs::JsonValue` in Rust, converted directly (no JSON
 *  text). Objects are plain objects with string keys; numbers are finite. The generator
 *  recognizes this declaration itself: a type of the same name declared elsewhere is not it. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A method result `T` whose Rust implementation returns `Result<T, E>`: `Err(e)` throws (sync)
 *  or rejects (async: `Throws<Promise<T>, E>`) a `DomainError` whose `data` is `e`. `E` is a
 *  named record or tagged union of the spec. Only as the whole method result; recognized by
 *  this declaration. (Evaluates to `T`; the conditional only keeps `E` used.) */
export type Throws<T, E extends object> = [E] extends [never] ? T : T;
