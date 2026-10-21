# W1 generated Canvas/Wasm fixture

This is a DOM fixture, with no React/RNWeb dependency added. It imports the same generated
rnrs_bundle module for both RnrsWebAdapter and the optional surface bootstrap. It exercises
the real shared frame decoder and CpuRaster, not the earlier probe or fake bridge.

From this worktree root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
nix develop .#web
source scripts/rust-env.sh
RNRS_OFFLINE=0 node fixtures/web-surface/build.mjs --test
# Subsequent cached builds:
node fixtures/web-surface/build.mjs --test
```

The build uses Rust 1.90.0 and wasm32-unknown-unknown installed through the existing
worktree-local rust-env setup. wasm-bindgen is pinned to 0.2.129; vello_cpu to 0.3.0.
The fixture owns rnrs-web.Cargo.lock and every build uses --locked. RNRS_OFFLINE=0 permits
fetching missing locked dependencies; it does not update versions. build.mjs adds local
ignored node_modules links to the existing surface/vello packages and generates the
TypeScript wrapper, then uses the standard application bundle generator.

The tests use real DOM Canvas/ResizeObserver and a scalar Wasm build with CPU raster.
Lifecycle/context events are synthetic; this does not prove browser-specific physical
context loss. Chromium runs with --disable-gpu via the existing harness. No GPU API,
worker, shared-memory thread, SIMD flag or cross-origin isolation requirement is added
to the implementation (the reused test server happens to send isolation headers).

The frame/command limits bound stored data, not work duration. CPU rendering and the
owned output copy execute synchronously on the main thread. The modest-scene sample in
result.json is an observation, not a latency guarantee. The previous 944 ms stress sample
is likewise not a worst-case ceiling; valid workloads can cost substantially more.

Three reachable pixel buffers in the ordinary host path are the CPU pixmap, one owned
JS Uint8Array copied synchronously from its Rust slice, and reusable ImageData. At the
8,388,608 aggregate raster-pixel cap their payload sum is 96 MiB. This is NOT a process
memory limit: it excludes Vello internals/scene storage, browser backing stores,
allocator capacity and uncollected JS objects. Framework callers must not retain
unbounded past output copies. The copied array is independent of Wasm memory growth
and raster reuse; the tests verify both and opaque alpha/blending.

## Bootstrap

```ts
import {initRnrs} from '@rnrs/runtime/web';
import {createSurfaceBootstrap} from '@rnrs/surface/browser';
await initRnrs(bundle, undefined, {bootstrap: createSurfaceBootstrap});
```

Initialization memoizes bundle and bootstrap identity. A failed initialization can retry; changing either after success is rejected. Backend replacement retires old adapters before publishing a new backend. Cleanup attempts every disposer and reports errors; old wrappers remain closed.
