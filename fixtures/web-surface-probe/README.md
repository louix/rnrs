# Browser raster probe

A stateless compile/pixel probe for Vello CPU. It is separate from the generated surface fixture and does not test host registration, lifecycle or React integration.

From the repository root in `nix develop .#web`, with Rust and the Wasm target installed:

```sh
source scripts/rust-env.sh
cargo fetch --locked --manifest-path fixtures/web-surface-probe/Cargo.toml
RNR_PROBE_CPU_SOURCE="$PWD/packages/vello2d/rust/src/cpu.rs" bash fixtures/web-surface-probe/build.sh
RNR_WEB_ROOT=fixtures/web-surface-probe node scripts/web-test.mjs fixtures/web-surface-probe/result.json
```

Use the current CPU source explicitly. The default historical extraction mode expects color/draw functions in gpu.rs and may not match the current layout. Checks cover pixels, blending, scale/resize and input bounds. Timing includes allocation and output copying; storage caps do not bound execution time.
