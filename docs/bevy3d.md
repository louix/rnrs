# Bevy example

Experimental Rust-owned Bevy scene with TypeScript controls. Android requires API 26 and Rust 1.97.1 for this example. The iOS experimental build does not render on the simulator. Browser WebGPU has known Firefox unmount crashes and headless software-device loss; there is no production-readiness or performance claim.

## Browser WebGPU

The browser host drives Bevy on requestAnimationFrame with no render worker or Canvas 2D fallback. Visible output and lifecycle safety must be checked separately from successful GPU submission. Reproduce using [the browser fixture](../fixtures/web-bevy/README.md).

## Native touch

Opt in with `<SurfaceView surfaceKey={…} touchInput="rust" />` and `surface.enable_touch()`. Android records feed Bevy's `TouchInput` and `Touches`; coordinates are physical pixels divided by scale. No Bevy window or winit event loop is provided, so window-dependent picking and focus are unsupported. This adapter does not deliver iOS or browser touches.

## What the author writes

`packages/bevy3d` (`@rnrs/example-bevy3d`) is an ordinary module package: a TypeScript spec (`bevy3d.spec.ts`) and a Rust crate (`rust/`). No Kotlin, Java, C++, JSI or handwritten glue; the generated interface and JS wrapper come from `rnr-gen`. The consumer (`fixtures/bevy-consumer`) is the pristine RN template (0.88.0; device results from 0.83.1) plus `App.tsx`/`smoke.ts`.

```ts
const scene = bevy3DModule().create();          // Rust starts the render thread
<SurfaceView surfaceKey={scene.surfaceKey()} />  // @rnrs/surface, unchanged
scene.setPaused(true); scene.setColor(0.1, 0.6, 0.9); scene.setSpeed(3);  // latest-value controls
scene.stats(); scene.close();
```

## Ownership

| Who | Owns |
| --- | --- |
| Rust render thread (`render.rs`) | the wgpu device, the Bevy `App` (ECS world, simulation, render world), the offscreen texture, the swapchain and the `WindowLease`. It calls `app.update()` and presents. |
| TypeScript | only the controls (paused, colour, speed) and the layout; it reads `stats()`. No per-frame JS work. |
| Framework (`@rnrs/surface`, `rnrs-core`) | the platform view and window lifetime, admission, and the teardown hook, all unchanged. |

Bevy never sees the window: no winit, no `WindowPlugin` primary window, no Bevy event loop, no second registry. The integration ("external render adapter") is:

1. The render thread creates the wgpu 30.0.1 device itself (before taking a lease) and hands clones to Bevy with `RenderCreation::Manual` (Bevy 0.20 uses wgpu ^30, so this is the same wgpu as the framework's other renderers).
2. Bevy's camera renders into an offscreen texture we own, registered as a `ManualTextureView` (`RenderTarget::TextureView`).
3. After each `app.update()`, the adapter (`gpu.rs`) acquires a swapchain image, blits the offscreen texture onto it and presents. Acquire, present and configure are each admitted through the lease, as in vello2d. The blit is **one extra full-screen GPU pass per frame**; this is not zero-copy.

Bevy's first updates compile and specialize its pipelines (seconds on a phone), so the render thread creates the Bevy app and runs three warm-up updates into the offscreen texture **before** it takes a lease; a platform detach therefore never waits for pipeline compilation.

Retirement follows vello2d: the scene is registered with the runtime `TeardownScope`; `close()`, `Drop` and teardown only set flags; the render thread drops, in order, the swapchain and lease, the Bevy app, then the device (after a GPU wait); a process-wide cap (2 render threads, counting retiring ones) is reserved before spawning and released when the thread exits.

Failure policy (deliberately simpler than vello2d's recovery): a failed device creation, bind or resize, a lost surface or a lost device ends rendering for the current attachment (`gpuState: "failed"`, `lastError`). Only a new attachment gets one fresh attempt; a lost device is recreated (with a new Bevy app) at that point. Skipped presents (timeout, occluded, outdated, revoked) wait 50 ms before the next frame. Nothing retries in a loop.

## Adapter limits

- **The lease is held across every Bevy update.** The warm-up covers pipeline compilation at startup only. A pipeline compiled later (for example a new material or mesh layout) runs inside `app.update()` while the `Target` holds the lease, and could exceed the platform's 500 ms detach budget. Such a detach would time out (counted in `detachTimeouts`), and the contract still holds.
- **A revocation during resize can benignly mark the attachment failed.** A configure that finds the attachment already revoked returns an error. `gpuState` becomes "failed" and `lastError` stays set until the next attachment, which starts fresh. There is no general recovery; this is the prototype's failure policy, not robust recovery.
- **`stats().state` is "attached" whenever the surface has an attachment, including one with zero size**, while the render thread does not bind or render it. (The Android view normally detaches at zero size.)
- `setColor` takes gamma-encoded sRGB components (`Color::srgb`), not linear values.

## Limits and workarounds (third-party, example-only)

- **Toolchain.** Bevy 0.20.0 requires Rust 1.97.1 (`rust-version`, checked on crates.io). The whole app bundle is one Cargo build, so an app with this module builds with 1.97.1: `RUSTUP_TOOLCHAIN=1.97.1` (with `RUSTUP_HOME`/`CARGO_HOME` pointing at an isolated install, as `rn-app.sh` already allows). The framework's default and tested toolchain (1.90.0) is unchanged; only this consumer was built with 1.97.1. The crate is excluded from the root Cargo workspace for that reason.
- **android-activity.** On Android `bevy_render` → `bevy_asset` → `bevy_android` → `android-activity`, which refuses to compile without an activity backend. The crate enables `native-activity` only to compile, and defines the `android_main` symbol that its `ANativeActivity_onCreate` export references. Nothing invokes it: Android calls that export only for a `NativeActivity` declared in the manifest, and the RN app has none. The stub logs and aborts if it is ever reached. The bundle therefore carries an unused `ANativeActivity_onCreate` export.
- **Android minSdk 26.** `android-properties` (via `android-activity`) needs API 26; apps set `minSdkVersion` 26 . API 24–25 are unsupported for this example.
- **No file assets.** Bevy's Android file reader expects the activity Bevy would own and panics otherwise (and panics abort the app). The default asset source is replaced by one whose every read fails with "file assets are not supported by @rnrs/example-bevy3d". The scene uses in-code meshes, materials and Bevy's embedded shaders only.
- **Bevy panics abort the process** (the bundle's `panic = "abort"`).
- Single-threaded Bevy (no `multi_threaded`, no pipelined rendering); no tonemapping LUTs (`Tonemapping::None`), no MSAA.
