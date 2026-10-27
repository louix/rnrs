# Changelog

## 0.4.0

- Native objects compose across types: methods can take and return other object types, and
  records, unions, arrays and `Record<string, T>` values can hold native handles.
- `Record<string, T>` (Rust `BTreeMap<String, T>`) and `JsonValue` from `@rnrs/runtime/spec`
  (Rust `rnrs::JsonValue`) convert plain objects and JSON data. Custom `rnrs_core::bind::Env` implementations must add
  `own_entries`.
- Opt-in declared errors: a `Throws<T, E>` result makes the Rust method return `Result<T, E>`;
  `Err` throws or rejects a `DomainError` whose `data` is `E` (generated `is<E>` guard).
  Methods without `Throws` keep `Result<T, String>`.
- Faster `number[]` results and string arguments on Android and iOS; results are unchanged.

Upgrade `@rnrs/cli`, `@rnrs/runtime` and `@rnrs/surface` (if used) together.
The native module ABI is now 5: module authors depend on the `0.4` framework crates, rebuild
prebuilt Android and iOS binaries with `rnrs build-native` and republish (older binaries are
refused with a rebuild message; web binaries are unaffected). Wrappers that declare errors need
`@rnrs/runtime` 0.4.0 (call protocol 4). Apps: rebuild native apps and web bundles.

## 0.3.0

- Module packages can ship prebuilt binaries (`rnrs build-native`): Android libraries, iOS
  XCFrameworks and browser Wasm modules, including rendering-surface modules. Apps link them
  without a Rust toolchain.
- Building from source is explicit: list modules in `rustNativeApp.sourceBuild` (or `"*"`).
  There is no automatic fallback; a module without a matching prebuilt binary is refused.
- `rnrs pack-js` refuses stale prebuilt binaries; `rnrs check-native` (scaffolded as
  `prepublishOnly`) refuses missing ones.
- Web apps initialize with the registry `rnrs build --target web` writes:
  `import * as modules from './.rnrs/web/rnrs.js'; await initRnrs(modules)`.
- Bevy rendering works on the iOS simulator.

Upgrade `@rnrs/cli`, `@rnrs/runtime` and `@rnrs/surface` (if used) together.
Module authors: depend on the `0.3` framework crates, rebuild binaries with `rnrs build-native`
and republish; 0.2.0 packages contain no prebuilt binaries. Apps: rebuild native apps and web
bundles. The TypeScript-spec and Rust-implementation authoring API is unchanged.

## 0.2.0

- Faster scalar calls and numeric-array input conversion on native and web.
- Input fields and array elements now use ordinary JavaScript reads, including
  inherited values and getters. Output property semantics are unchanged.
- Earlier, actionable errors for incompatible generated wrappers and native builds.
- Validated surface rendering, touch input and Worklets on a physical iPhone;
  surface touch combined with Gesture Handler remains untested.

Upgrade `@rnrs/cli`, `@rnrs/runtime` and `@rnrs/surface` (if used) together.
Regenerate bindings and rebuild native apps; this is not a JS-only update.
Rust module dependencies should use the `0.2` framework crate versions.
The TypeScript-spec and Rust-implementation authoring API is unchanged.
