# WebGPU surface fixture: one Rust wgpu triangle (browser)

A DOM fixture for the optional WebGPU presentation of `@rnrs/surface`. One generated Wasm bundle
holds `@rnrs/labs-webgpu-triangle` (wgpu 30.0.1, `webgpu` + `wgsl` + `std` only) and
`@rnrs/example-vello2d` (the existing Canvas 2D path, used here only as a regression check).
Rust draws into the canvas's WebGPU texture. No pixels cross the bridge and there is no CPU
readback or upload in the presentation path.

```sh
nix develop .#web --offline
source scripts/rust-env.sh
RNRS_OFFLINE=0 node fixtures/web-webgpu/build.mjs --test   # first build (locked crates)
node fixtures/web-webgpu/build.mjs --test                  # later builds
```

The test runs unsupported and software-WebGPU paths. SwiftShader is correctness coverage only. Headless Chromium can lose the device after canvas submission, blocking visible-presentation proof. A headed browser must be checked separately using `serve.mjs` and `?expect=view`; counters alone do not prove display. No automatic Canvas 2D fallback is provided.

`--test` also runs `?expect=reentrancy` (rnrs::gpu hook reentrancy and setup interleaving) in a launch of its own. Those checks use rnrs-surface's lab-only `lab-hooks` feature, which this fixture's build enables (`RNRS_BUNDLE_FEATURES=rnrs-surface/lab-hooks`) and no package does; `node fixtures/web-webgpu/build.mjs --default-exports` builds the bundle as an app would and checks that the hook export is absent.
