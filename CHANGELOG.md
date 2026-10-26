# Changelog

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
