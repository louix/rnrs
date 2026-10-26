# Changelog

## Unreleased

- Module packages can ship prebuilt Android binaries, iOS XCFrameworks and browser Wasm modules (`rnrs build-native`).
  Apps link them without Rust. Modules listed in `rustNativeApp.sourceBuild` are compiled from
  source instead, explicitly; there is no automatic fallback.
- The native boundary is a versioned C table per module (`RnrsAbi.h`, ABI 1). The executor
  budget and Tokio runtime are per module binary.
- Apps whose modules have no prebuilt binary must list them in `rustNativeApp.sourceBuild`.
- Web apps initialize with the registry `rnrs build --target web` writes:
  `import * as modules from './.rnrs/web/rnrs.js'; await initRnrs(modules)`.

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
