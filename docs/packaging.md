# Packaging

Module authors compile Rust; apps install the resulting npm package and use their normal build.
Android, iOS and browser modules—including renderers—can ship prebuilt binaries.

## Packages

| Package | Purpose |
| --- | --- |
| `@rnrs/runtime` | Runtime, spec types, native integration and framework Rust sources. |
| `@rnrs/cli` | Node-based generator and build tools. Rust is needed only for compilation and tests. |
| `@rnrs/surface` | Optional React component and Rust rendering support. |

Apps install the runtime and their module packages directly. Rendering apps also install
`@rnrs/surface`. Use matching framework package versions.

## Module packages

`rnrs init` sets up the spec, Rust crate, generated wrappers and npm scripts. Keep its generated
package entry points: custom entry modules that re-export the wrapper are not supported.
`npm pack` regenerates the bindings and checks package contents.

Declare supported platforms in `rustNative.targets`. Build every declared target before publishing;
the module's Rust dependencies must support them too.

## Prebuilt binaries

From the module directory:

```sh
npx rnrs build-native --target android
npx rnrs build-native --target ios      # macOS with Xcode
npx rnrs build-native --target web
npx rnrs check-native
npm publish
```

See [authoring tools](setup.md#tools). Android builds all four React Native ABIs by default;
`--abi` selects fewer. iOS packages device and simulator libraries in an XCFramework;
`--sim-arch` selects simulator architectures. Web packages Wasm with its JS glue.

Outputs live in `rnrs/native/` and must be included in the npm package, along with the spec,
Rust sources and generated bindings. Builds on different machines can be combined only when
sources, dependency lock, spec and framework match. Each target build replaces its selected slices.

`npm pack` rejects stale binaries and warns about missing targets. `rnrs check-native` also rejects
missing targets. New modules run it through `prepublishOnly`; when publishing a tarball or using
an older package setup, run it explicitly because that hook may not run.

The publisher controls the binaries' Rust dependencies. Dependency updates require rebuilding
and republishing the module; the consuming app's Cargo lock does not change a prebuilt binary.

## App builds

Android's Gradle integration and iOS's `pod install` validate and link the installed binaries.
Missing targets, incompatible ABIs, unsupported deployment targets and edited Rust sources fail
with an error naming the package. There is no automatic source fallback.

Browser apps run `npx rnrs build --target web`, then initialize the generated registry:

```ts
import { initRnrs } from '@rnrs/runtime/web';
import * as modules from './.rnrs/web/rnrs.js';

await initRnrs(modules);
```

This step uses Node only unless source builds are selected. Rerun it after changing module
packages. Rendering apps also pass the surface bootstrap; see the [triangle tutorial](triangle.md).

### Source overrides

To rebuild an installed module—for example after a `patch-package` edit—set this in the app's
`package.json`:

```json
{
  "rustNativeApp": {
    "sourceBuild": ["@acme/my-module"]
  }
}
```

Use `"sourceBuild": "*"` to rebuild every module. Selected modules compile into one source bundle;
their prebuilt binaries are excluded. Other modules remain prebuilt. Rust and the selected
platform's targets are required. Rerun `pod install` after changing this setting on iOS.

## Discovery and targets

rnrs discovers modules through the app's installed `dependencies` and `optionalDependencies`,
not development or peer dependencies. Every selected module must declare the requested target.
Use separate app dependency graphs for different target sets.

## Rust dependencies

Authors depend on `rnrs`. Enable `surface` or `wgpu` for rendering. Framework Rust crates resolve
from the installed npm packages, not crates.io; `rnrs test` and source builds configure this.
Cargo aliases are supported. Framework dependencies must be unconditional and compatible with
the installed framework version.

## Rust library packages

`@rnrs/surface` supplies the `rnrs-surface` crate through its `rustNative.library` declaration.
Library packages register no module and are not themselves module binaries.

- The declared crate name must match Cargo's package name; its path must stay inside the package.
- Packages with native integration must be direct app dependencies for autolinking.
- Multiple installed copies of a library, and libraries depending on other libraries, are unsupported.

## Lock files

For **source builds**, commit the app's `rnrs-android.Cargo.lock`, `rnrs-ios.Cargo.lock` and/or
`rnrs-web.Cargo.lock`. Ignore `.rnrs/`.

- The first build creates the lock; subsequent builds reject stale dependencies.
- Set `RNRS_LOCKED=1` in CI to reject missing locks too.
- Run `rnrs lock --target T` to reconcile dependencies, or add `--update` to update them.

## Current limits

- Each native prebuilt module includes its own Rust backend and Tokio runtime: two worker threads
  started on first use, with an executor budget of 32 per binary.
- App Rust logging settings apply to source-built modules only.
- Distributed native binaries omit debug information. Keep the publisher's unstripped objects in
  `.rnrs/native-build/seal/` for diagnostics; automatic symbolication packaging is not provided.
