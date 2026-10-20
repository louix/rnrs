# W2 packaged React Native Web paddle fixture

This runs the existing paddle App through the real browser SurfaceView export and the generated Wasm bundle. No game implementation is duplicated: build.mjs copies App.tsx, game.ts, contention.ts and smoke.ts byte-for-byte, records their SHA-256 values, and bundles only installed packages plus fixture-local copies.

## Reproduce

From the repository root, with the pinned local Rust toolchain/wasm target already installed:

```sh
npm ci --ignore-scripts --no-audit --no-fund
nix develop .#web
source scripts/rust-env.sh
RNR_OFFLINE=0 node fixtures/web-paddle/build.mjs --test
# Cached Rust dependencies:
node fixtures/web-paddle/build.mjs --test
```

The build packs the local framework/module sources, installs their tarballs into this fixture, verifies the installed component/runtime against the current source, and uses the packed runtime generator. npm/package and Cargo locks are committed; generated tarballs, node_modules, copied game sources and build output are ignored. The initial Cargo lock is seeded from the checked W1 web lock (same Rust module/library dependency graph) and validated by a locked build.

Exact fixture pins: React 19.3.0, React DOM 19.3.0, React Native Web 0.21.4 (Expo SDK 58). React Native 0.88.0 is a fixture dev dependency for native public TypeScript types and peer compatibility; browser bundling aliases react-native to RNWeb. No root React/RN pin changes. RNWeb's published peers accept React/DOM 19; React DOM's peer requires React ^19.3.0.

provenance.json records source-copy hashes, tarball/lock hashes and actual installed-package browser/native resolution. The browser bundle metafile must stay wholly inside this packaged consumer and include index.web.tsx, with no native Fabric component. No relative workspace runtime or generated-module import is permitted.

## Framework behavior

@rnrs/surface preserves its React Native entry and adds a browser conditional export. The browser component forwards View props/onLayout, places an initially zero-sized Canvas inside its content layout, and delegates attachment/resize/visibility/cleanup to the cleared W1 host. Bootstrap publishes a host using a React-free subscription; headless/W1 bootstrap code does not import React.

A successful backend identity change invalidates the runtime's framework-owned module accessor cache. Retained old wrappers remain retired; a new call to vello2DModule() returns a module owned by the new backend. During application replacement, unmount React first, then replace the backend and mount a new root. Replacing the backend cannot transparently reconstruct user-owned game/renderer state inside an old mounted App.

Normal application setup can use the optional public seam:

```ts
import {initRnr} from '@rnrs/runtime/web';
import {createSurfaceBootstrap} from '@rnrs/surface/browser';
await initRnr(bundle, undefined, {bootstrap: createSurfaceBootstrap});
// Render the ordinary App with React DOM; its @rnrs/surface import selects the browser entry.
```

The fixture uses the public low-level installWebBackend API to exercise full replacement. The one-active-backend-per-JS-realm and stopped-registration failure semantics remain those documented for W1.

## Limits

Raster and pixel copies run synchronously on the browser main thread. Storage caps do not bound execution time. The fixture uses CDP mouse events and synthetic visibility/page lifecycle events; it does not establish physical touch, background throttling, BFCache or GPU performance. DPR-only notification behavior remains browser-dependent.

Build output includes ignored `provenance.json` and `result.json`. Preserve them together when recording a run.
