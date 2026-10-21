# Packaging

## Packages

| Package | Purpose |
| --- | --- |
| `@rnrs/runtime` | JS runtime, spec types, native autolinking and framework Rust crates. |
| `@rnrs/cli` | The `rnrs` command: scaffold, generate, test and build. The runtime brings it into apps automatically. |
| `@rnrs/surface` | Optional React component and Rust support for rendering surfaces. |
| Your module | TypeScript spec, Rust implementation and generated interface and JS wrapper. |

Use matching framework package versions. Module packages peer-depend on the runtime and use the CLI and runtime as development dependencies. Apps install the runtime and their module packages; rendering apps also install `@rnrs/surface` directly.

See the [quickstart](quickstart.md) for authoring and [maintainer guide](lab.md#local-package-testing) for testing package archives locally.

## App builds

Android's Gradle task and iOS's pod script generate and compile one Rust bundle for the app. Autolinking installs the native integration; module authors write no platform glue. Browser apps build with `rnrs build --target web` and call `await initRnr(bundle)` before using modules.

Generated glue lives in the ignored `.rnr/<target>/bundle/`. It references the installed module crates and patches framework crates to the copies shipped with the npm packages. Resolution checks reject a different framework copy, keeping a single runtime and surface registry per bundle.

Repeated or concurrent `initRnr` calls with the same bundle share initialization. A failed load can be retried; a different bundle is rejected after initialization.

## Discovery and targets

The CLI walks the app's `dependencies` and installed `optionalDependencies`, resolving through Node's package layout. It does not follow development or peer dependencies. A package's `rustNative` field identifies a module and declares its supported targets: `android`, `ios`, or `web`.

Every selected module must support the requested target. Missing dependencies, duplicate module names, unsupported targets and stale generated interfaces fail with a dependency-chain diagnostic. Modules are never silently omitted. Use separate app dependency graphs when their target sets differ.

## Rust dependencies

Authors depend on `rnrs`. Its default API includes `rnrs::core`, `Native`, `CancelToken`, `TeardownScope` and `Retire`. Optional `surface` and `wgpu` features add rendering support; headless modules need neither the surface npm package nor GPU dependencies.

`rnrs test` and app builds resolve framework dependencies from the installed npm packages. Generated interfaces use the author's declared dependency name, including Cargo aliases. Direct `rnrs-core` dependencies remain supported. The dependency must be unconditional and compatible with the installed framework version.

Some internal identifiers retain their `rnr` spelling: `initRnr`, `rnr_interface.rs`, `.rnr/`, `rnr_bundle`, `RNR_*` settings and the lock files below. Public npm packages use `@rnrs/*`; Rust packages use `rnrs` or `rnrs-*`.

## Lock files

Commit each app's `rnr-android.Cargo.lock`, `rnr-ios.Cargo.lock` and/or `rnr-web.Cargo.lock`. They survive regeneration of `.rnr/`.

- The first build creates a missing lock. Later builds use it with Cargo's `--locked` and reject stale dependencies.
- CI should use `rnrs build --locked`, `RNR_LOCKED=1`, or Gradle `-Prnr.locked=true` to reject missing locks too.
- `rnrs lock --target T` reconciles dependencies while retaining locked versions. Add `--update` to upgrade within their version requirements.
- `rnrs lock --check --target T` verifies without building.

Locks contain no machine-specific paths, but do not make artifacts bit-reproducible: toolchain and SDK versions also matter. See [required tools](quickstart.md#0-tools).
