# Browser WebGPU probes

`probe.mjs` checks adapter availability. `canvas-loss.js` and `canvas-readback.js` isolate canvas submission and readback without Rust. Run inside `nix develop .#web`:

```sh
node fixtures/web-webgpu-probe/probe-expr.mjs '["--enable-unsafe-webgpu"]' "$(cat fixtures/web-webgpu-probe/canvas-loss.js)"
node fixtures/web-webgpu-probe/probe-expr.mjs '["--enable-unsafe-webgpu"]' "$(cat fixtures/web-webgpu-probe/canvas-readback.js)"
```

The unsafe-WebGPU launch flag is for the test process only. Software-adapter results do not establish hardware performance or visible presentation. Keep the browser version, launch flags and adapter details with any recorded output.
