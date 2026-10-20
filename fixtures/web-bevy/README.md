# Bevy on the browser WebGPU surface (bounded prototype)

`@rnrs/example-bevy3d` (Bevy 0.20.0, wgpu 30.0.1 `webgpu` only) on `@rnrs/surface`'s WebGPU
presentation, rendered with React Native Web 0.21.4 / React DOM 19.3.0. Rust owns the scene and its simulation; the
browser host's requestAnimationFrame drives one Bevy update and one canvas submit per frame.
No thread, no pixels across the bridge, no CPU copy, no Canvas 2D or WebGL fallback. Design and
limits: [docs/bevy3d.md](../../docs/bevy3d.md#browser-webgpu).

```sh
nix develop .#web --offline
npm ci && (cd fixtures/web-bevy && npm ci)
export RUSTUP_HOME=$PWD/.generated/rust-1.97.1/rustup CARGO_HOME=$PWD/.generated/rust-1.97.1/cargo RUSTUP_TOOLCHAIN=1.97.1
rustup toolchain install 1.97.1 --profile minimal --target wasm32-unknown-unknown   # once
RNR_OFFLINE=0 node fixtures/web-bevy/build.mjs --test   # first build (fetches crates)
node fixtures/web-bevy/serve.mjs 8780                    # headed: http://localhost:8780/?expect=view
```

`dist/build-info.json` records the commit, whether tracked files were dirty, rustc, and the
sha256 of the `.wasm` and `main.js` being served. The view shows it and copies it.

**Pages:**
- `?expect=view` (default) is quiet (`View.tsx`). It shows one persistent cube with the consumer
  app's Pause/Color/Speed controls. Resize, unmount/remount and the in-app sequence (the
  unchanged `smoke.ts`) run only from explicit buttons. Every action and phase change (state,
  gpuState, presentation, size) is written to localStorage immediately, so the log of a crashed
  session can be copied after reopening.
- `?expect=app` is the unchanged `fixtures/bevy-consumer/App.tsx` (copied with a hash check).
  It runs its in-app sequence automatically. Opt-in only.
- `log.html` (static: no Wasm, no WebGPU) shows the persisted logs. `?expect=log` also avoids
  WebGPU but loads the Wasm bundle, and it crashed once after a Firefox crash.
- `?expect=unsupported` and `?expect=webgpu` are the headless checks.

## Limits

Firefox has rendered the quiet view but crashed on unmount; the plain-JS `teardown.html` reproducer also crashed. Root cause is not established. Headless SwiftShader can lose the device before readiness, so passing setup checks does not prove visible presentation. Late request-device cleanup, hardware loss recovery and frame pacing remain unvalidated.

Use `?expect=view` for manual controls. Copy diagnostics from the page; after a crash, `log.html` exposes persisted localStorage logs without loading WebGPU. Match the displayed build hashes to the tested output.
