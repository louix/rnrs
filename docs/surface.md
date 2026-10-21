# Rendering surfaces

Platform surfaces with Rust-owned rendering, lifecycle gates and opt-in native touch input. Android device and browser coverage are fixture-specific; iOS touch coverage is simulator-only. See [Bevy](../packages/bevy3d/README.md) for that renderer's additional limits.

For a complete first renderer, follow [Draw a triangle](triangle.md).

## Ownership split

- **TypeScript** owns layout and controls. Application state and simulation can live in TypeScript or Rust.
- **Rust** owns rendering resources. A renderer can consume state submitted from TypeScript, or run its own simulation.
- **Framework** (`@rnrs/surface`, plus the runtime teardown hook in `rnrs-core`) owns the platform glue: the Fabric component, the Android `SurfaceView`, JNI, and window lifetime. App and renderer authors write TypeScript and Rust only. The consumer app builds from the pristine RN template (0.88.0; device results from 0.83.1) with no native edits.

## Packages and files

| Path | Owner | Contents |
| --- | --- | --- |
| `packages/surface` (`@rnrs/surface`) | framework | `<SurfaceView surfaceKey>` Fabric component (codegen spec, Kotlin `SurfaceView` + view manager, autolinking), and the Rust library crate `rnrs-surface`: surface registry, window ownership, admission protocol, `WindowLease`, Android JNI entry points |
| `rust/rnrs-core/src/lifecycle.rs` (shared core) | framework | runtime-teardown hook: `TeardownScope`, `Retire` |
| `packages/vello2d` (`@rnrs/example-vello2d`) | example renderer module | TS spec, Rust renderer (render thread, GPU state machine, vello_cpu raster, wgpu present), `frame.ts` frame writer |
| `fixtures/gpu-probe`, `fixtures/gpu-probe-pr10291` | lab | headless device probes, `run.sh` |
| `fixtures/surface-consumer` | lab | clean consumer app: in-app lifecycle sequence (`smoke.ts`) and steady-state stats |
| `scripts/consumer/surface-device-test.mjs` | lab | device driver (explicit serial) into `results/surface/runs/<UTC>-<serial>/` |
| `tools/rnrs-gen`, root `Cargo.toml`/`Cargo.lock`, `scripts/pack.mjs`, `scripts/consumer/rn-app.sh` | shared | library packages, namespace and direct-dependency rules, packing, `PACKS` and build provenance |

## Generator rules

### Rust library packages

A renderer crate depends on the framework surface crate, which ships in an npm package rather than on crates.io. Such a package declares `"rustNative": {"targets": [...], "library": {"crate": "rnrs-surface", "path": "rust"}}`. It is discovered and target-checked like a module, registers no module, and is patched into the bundle by crate name (`[patch.crates-io] rnrs-surface = { path }`), so module crates depend on it by version (`rnrs-surface = "0.1"`).

Checks:
- The schema allows only `targets` and `library`, and `library` allows only `{crate, path}`.
- The crate name must equal the Cargo `[package] name`.
- The path must stay inside the package.
- Framework crate names (`rnrs`, `rnrs-core`, `rnrs-android`, `rnrs-web`, `rnrs-log`, `rnrs-bundle`, and the former `rnr-core`, `rnr-android`, `rnr-web`, `rnr-log`, `rnr-bundle`, `rnr-surface`) are reserved for libraries and modules.
- `generate`, `check` and `pack-js` refuse library packages.

### The `rnrs-*` namespace is never resolved from a registry

Crates named `rnrs`, `rnrs-*` (or `rnrs_*`) and the former `rnr-*` (or `rnr_*`) belong to the framework and its npm library packages:
- Before Cargo runs, a module crate that depends on such a crate that no installed package provides is refused. The message names the package to install, for example "add `@rnrs/surface` to the app's dependencies", or the new name of a former `rnr-*` crate.
- After resolution, any such crate whose source is a registry or git is refused, whether or not a package declared it. Without this, a renderer requiring `rnrs-surface` with `@rnrs/surface` missing would fetch a crates.io crate of that name.

### Native packages must be direct app dependencies

React Native autolinking links native code (Android libraries, codegen components, iOS pods) only for the app's **direct** dependencies. Resolving a transitive library for Cargo is therefore not enough: the view manager and component would be missing at run time. For Android and iOS bundles, a selected package with native platform code (`react-native.config.js`, `android/build.gradle` or a podspec) must be listed in the app's `dependencies`. Otherwise the build fails, naming the chain and the package to add. `@rnrs/example-vello2d` depends on `@rnrs/surface`, and the app must still list `@rnrs/surface` itself.

Tests (`tools/rnrs-gen/test/library.test.mjs`, `bundle.test.mjs`):
- real offline Cargo resolution of a module depending on a library by version;
- relocation with an unchanged lock;
- an incompatible installed version;
- `npm pack` tarballs of `@rnrs/surface` and `vello2d`: refused when the library is only transitive, resolved from the installed path when it is direct;
- the missing-library pre-check against a real `Cargo.toml`;
- registry and git refusal of `rnrs`, `rnrs-*` and former `rnr-*` crates (fabricated metadata);
- dependency-table scanning.

Not covered: multiple installed copies of one library, and a library depending on another library.

## SurfaceView, not TextureView

The view is a `SurfaceView`. Its content is a separate compositor layer (BufferQueue to SurfaceFlinger), with no extra GPU copy into the app window and lower latency than `TextureView`. Consequences:
- React Native views drawn later in the tree, including absolutely positioned TSX overlays such as a HUD, appear above the content.
- Transforms, opacity and rounded-corner clipping of the view or its ancestors do not apply to the content.
- Two overlapping surfaces have an undefined order.
- The content looks opaque because the renderer fills every frame with an opaque black base (`gpu.rs` `draw`) before the frame's commands, and the blit replaces the image. It is *not* guaranteed by the alpha mode: on the Pixel 2 XL the surface offers no `Opaque` mode, and the presenter uses `Inherit`. **Regression note:** if the base fill changes (transparent clears, alpha content), compositing behind the surface becomes driver-dependent; it would then need a supported `Opaque` mode, or a premultiplied mode with a defined background.
- The platform destroys the surface when the window is hidden and creates it again on return. The lifecycle below handles that.

`TextureView` would compose like an ordinary view, at the cost of a GPU copy and latency. It could become an opt-in mode behind the same Rust contract.

## Lifecycle contract (rnrs-surface)

| Concept | Rule |
| --- | --- |
| Surface key | Opaque JS number from a process-wide counter, never reused, below 2^53. A key from a disposed surface or an earlier JS runtime matches nothing. No pointer reaches JS. |
| Attachment | Each attach gets a fresh nonzero number. Resize and detach must name it, so a late callback for an earlier attachment is ignored. |
| Window ownership | A platform window (`ANativeWindow`, identified by address while referenced) is owned by at most one attachment process-wide. Its identity is reserved until the last reference to that attachment's cell is dropped, exactly once. A second key attaching the same window is refused as busy until then, even after a timed-out detach. |
| `WindowLease` | The renderer's only access to the window. It retains the window object (raw-window-handle for wgpu) and keeps the surface registered, so the platform's detach can find it. |
| Admission | Every acquire and every present is admitted separately through the lease. Admission atomically checks that the attachment is not revoked and counts the operation as in flight. The operation then runs without any lock held. |
| Detach | Synchronous, as Android's `surfaceDestroyed` requires, on the UI thread. It revokes the attachment permanently (no new operation is admitted), wakes the renderer, and waits up to its budget, **500 ms**, for every lease to be dropped. The budget is distinct from wgpu's fixed 1000 ms acquire timeout. |
| What the wait includes | Finishing an admitted operation (a blocked acquire, a present) and destroying the swapchain, which calls `vkDeviceWaitIdle` (`wgpu-hal-30.0.1 src/vulkan/swapchain/native.rs:379-389`). It is **not** a non-blocking operation. Device creation is not included: the renderer creates the device before taking a lease. |
| After a timeout | The view continues. No new operation is ever admitted on that attachment. At most the operations already admitted when the detach began may finish. A late acquire is not followed by a present: the present needs its own admission, and the acquired image is dropped. The window object stays retained (valid memory) until the renderer releases it; then it and its identity are released. Counted as `detachTimeouts` and `detachTimeoutsInFlight`. |
| Busy | One window per surface key. The first attached view wins, and a second is refused (`BUSY`). The Kotlin view retries with deduplicated backoff (16 ms doubling to 1 s, then every 1 s) while it still has a key, a surface and a size, revalidating each time. Retries are cancelled on detach, key change, drop and `onDetachedFromWindow`, and it logs once per busy episode. A waiting view attaches within its current backoff once the first view detaches, or once the window's old lease is finally released. |
| Close | `close()` revokes the current attachment and refuses new attachments and leases. It never blocks. An attached window stays retained until the platform detaches it, so that detach still waits for leases. |
| Zero extent | The view attaches only with a nonzero size and detaches when its size becomes zero. |
| Threads and locks | JNI entry points run on the UI thread and never touch JS. The render thread never touches JSI. Every rnrs-surface lock (registry, surface state, cell admission, window ownership) is taken alone. Wakers run, and cells, windows and surfaces are dropped, only with no lock held. |

Host tests (`cargo test -p rnrs-surface`) use thread barriers, revocation checks and channels, with no sleeps except a scheduling nudge in one race loop:
- an admitted operation in flight, then a detach timeout, then completion: no further admission, and the window released exactly once;
- the same window under a second key refused until the old lease drops, then the retry and a replacement after a timeout succeed;
- detach waiting for a lease held on another thread;
- close revoking;
- a lease outliving its owner;
- admissions racing detach stop at revocation (50 iterations).

## Runtime teardown hook (rnrs-core)

A renderer's thread and GPU device must stop when its JS runtime generation is torn down (RN reload, invalidation), even if JS, Worklets or native references to it survive.
- `Adapter::new` makes a fresh `TeardownScope` current, saved and restored by an RAII guard, while the module instance is created. The module captures it (`TeardownScope::current()`).
- `Adapter::teardown` runs `host.teardown()` (admission stops), then `retire_all()`. `Adapter`'s `Drop` is an idempotent backstop, and a failing `instantiate` retires anything it registered.
- `register` and `retire_all` are serialized by the scope lock. A registration after close retires at once, after unlocking. `retire` runs, and upgraded references are dropped, only after unlocking.
- `Retire` contract: idempotent and non-blocking; may run on any thread, including a finalizer or UI thread. No JSI, no GPU waits, no joins. A panic aborts.

vello2d registers each renderer's `RendererCore` (render state plus surface) before it reaches JS. Retiring it closes both, so an old mounted view cannot attach to a renderer that no longer exists. A module created outside an adapter has no scope: it is unowned and reports `ownedByRuntime: false`.

Lock order: the scope lock is taken alone; vello2d's inbox and stats locks are each taken alone; rnrs-surface's as above.

Tests:
- rnrs-core: retained references; nested scopes; reentrant drop plus a concurrent finalizer; 100 iterations of concurrent register and teardown, each retired exactly once.
- rnrs-android, through the C ABI that Android (JNI) and iOS share: explicit `rnr_adapter_teardown`, the free-only (destructor) path, and a failing instantiate.
- vello2d: a retained renderer closed by teardown, and a late attach to its key refused.

## The wgpu adapter (rnrs::gpu)

A renderer that draws with wgpu writes only its pipeline and draw; `rnrs::gpu` (rnrs-surface's
`wgpu` feature, `rnrs = { version = "0.1", features = ["wgpu"] }`) owns the surface, render loop,
device, swapchain, window lease, teardown and failure handling on Android (Vulkan), iOS (Metal)
and the browser (WebGPU, no fallback). The API and its lifecycle rules are documented in
`packages/surface/rust/src/gpu/mod.rs`; the maintained example is the triangle fixture
(`packages/fixtures/webgpu-triangle/rust/src/lib.rs`):

```rust
use rnrs::gpu::{self, wgpu, Frame, Gpu, GpuSurface, Next, Options, TargetInfo};

struct Draw;
impl gpu::Renderer for Draw {
    type State = wgpu::Color;                 // latest value from JS (set_state)
    type Resources = wgpu::RenderPipeline;    // per attachment, dropped before the swapchain
    fn create(&mut self, gpu: &Gpu, target: &TargetInfo) -> Result<Self::Resources, String> { /* pipeline for target.format */ }
    fn draw(&mut self, pipeline: &mut Self::Resources, frame: &mut Frame<'_>, bg: &wgpu::Color) -> Result<Next, String> {
        /* one render pass on frame.view, recorded into frame.encoder */
        Ok(Next::Wait)                        // redraw on the next change; Next::Animate to keep drawing
    }
}
// In the module's create(): GpuSurface::spawn(&scope, Options::default(), wgpu::Color::BLACK, || Draw)?
```

- Each attachment gets new resources (`create`, then `resized` on every size change). A failure
  ends rendering for that attachment with no retry; a new attachment tries once.
- Native frames are capped at `Options::max_frame_rate` (default 60); the browser draws once per
  `requestAnimationFrame`. Hooks never run under an adapter, surface or host lock.
- vello2d and bevy3d keep their own render loops (vello's CPU raster and recovery backoff, Bevy's
  offscreen render and blit); they do not use the adapter.
- Checked by rnrs-surface's host tests (a fake GPU backend and a virtual clock), the triangle's
  browser fixture (`fixtures/web-webgpu`, software WebGPU), `scripts/consumer/triangle-device-test.mjs`
  (Android) and `scripts/consumer/ios-triangle-sim-test.mjs` (iOS simulator).

## Renderer (vello2d)

- **Submit.** `submit` checks `closed` and stores the frame under the inbox lock that `close` takes, so a call that finishes after close writes nothing. It returns `false` only when closed. While the GPU is recovering or has failed it returns `true` and the frame waits (latest wins).
  - Calls through a torn-down adapter or Worklets endpoint throw before reaching the method (`ERR_RNR_CLOSED`). Callers in worklets must catch.
- **Close and `Drop`** only set flags and notify. The render thread drops the swapchain, raster resources and device itself, and is never joined from JS, UI or finalizer threads.
- **Process cap.** At most 4 render threads alive per process, each with its own Vulkan device, counting closed renderers still releasing their GPU resources. The slot is reserved before spawning (rolled back if the spawn fails) and released only when the thread exits. At the cap, `create` fails immediately with the open and releasing counts; it never waits. A stalled GPU keeps a renderer retiring and its slot taken. That is deliberate: it really is still holding the device. `stats()` reports `renderersOpen` and `renderThreadsAlive`.
- **GPU states** (`stats().gpuState`):
  - `none`: no device yet.
  - `ready`.
  - `recovering`: a failed bind or present, a lost surface or a lost device. Old resources are dropped on the render thread first, then retried with exponential backoff from 100 ms, capped at 3.2 s.
  - `failed`: after 6 consecutive failures, kept until the next attachment or resize.
  - Only a presented frame ends a recovery, so a bind-then-fail cycle is bounded too.
  - A surface loss (`Lost`) recreates the wgpu surface; `Outdated` reconfigures it.
  - A device loss (device-lost callback, or seen at the next bind or present, including one that happened while unbound) drops every GPU resource and creates a new device.
  - Configure errors are captured with a validation error scope and returned.
  - The fake-presenter tests cover each transition, including persistent `Failed` and `DeviceLost` presents ending in `failed`.
- **Raster size** is `resolutionScale` of the window, reduced uniformly (aspect and drawing scale preserved) so neither side exceeds 4096.
- **Panics abort the process** (the bundle's `panic = "abort"`, unchanged). A panic in renderer or module Rust code is fatal. Input-dependent paths (formats, alpha modes, sizes, frames) return errors instead of indexing or unwrapping.

### Deterministic substitutes for physical-device cases

| Required case | Covered by | Physical-device gap |
| --- | --- | --- |
| Last reference released on a UI/Worklets finalizer | Drop on another thread returns immediately; teardown retires renderers whose references survive; the reentrant-finalizer scope test | Not exercised on an actual Worklets UI-runtime finalizer |
| Stalled GPU during detach | A fake presenter blocked inside an admitted acquire: detach times out within its budget, no present is admitted afterwards, the window is released exactly once after unbind | A real GPU hang was not induced |
| Presenting to an abandoned window after a timeout | The same test: the late acquire's present is refused (`PresentRevoked`) | as above |
| JS reload within one process | Scope teardown with retained references (vello2d) and the C-ABI teardown and destructor paths | Release builds cannot reload JS; a process restart is tested on the device |

## Browser presentation (web)

**Direction.** WebGPU (wgpu's `webgpu` backend, Rust drawing into the canvas) is the primary
browser GPU path. It is optional only in the sense that consumers without a GPU renderer
depend on no GPU code: wgpu is an optional dependency of `rnrs-surface` (feature `wgpu`, the
adapter below), and it enters a bundle only through a renderer package that enables it. The Canvas 2D transport (Rust returns owned RGBA pixels and the host
calls `putImageData`) is a stopgap specific to the CPU renderer (vello2d's vello_cpu raster).
It is not the default game architecture, and it is not a GPU fallback. It is kept working as a
regression target, with no further investment. WebGL2 would come later as an explicit
compatibility option chosen by a renderer, never an automatic fallback for every renderer.

**Renderer-selected presentation.** `Producer::presentation()` is fixed for the producer's
lifetime: `Canvas2d` (the default) or `WebGpu`. The host reads it once per mount
(`rnr_surface_presentation`) and creates no context for WebGPU. A canvas keeps its first
context type, so a mount whose mode differs from the canvas's earlier context is refused with
an error. `<SurfaceView>` gives each surface key a fresh `<canvas>` element. The host records the
`webgpu` mode on the canvas at mount, before setup and even when WebGPU turns out to be
unsupported. Such a canvas is conservatively refused for later Canvas 2D use (needs a new element);
nothing falls back automatically.

WebGPU contract (`web_producer.rs`, `canvas-host.ts`):
- After the attach is admitted, the host sets the canvas backing size to the extent and calls
  `rnr_surface_bind_canvas(key, token, canvas)`. The call is checked against the authoritative
  `Surface` attachment (`stale`/`closed`), as render and resize are; no second registry.
- Render outcomes are explicit:
  - `pending`: setup still in flight.
  - `submitted`: GPU work submitted for the canvas texture. This is not proof of display.
  - `unchanged`: nothing new to draw.
  - `failed`: terminal for the attachment. The host reports it once, releases the attachment
    and does not retry. `refresh()`, becoming visible again or a remount reattaches once. An
    unsupported browser (no `navigator.gpu`, or no adapter) is such a failure. No fallback.
- Producers do asynchronous setup (adapter, device, pipeline) on the JS thread. They advance a
  generation on every bind, detach and close, and recheck it after each await. Stale setups
  destroy what they built, and no RefCell borrow is held across an await.

The triangle fixture is `fixtures/web-webgpu`. Headless Chromium canvas submission can lose the software device; submitted frames are not proof of visible presentation.

## Frame submission

One `submit(ArrayBuffer)` per frame, no per-primitive calls. The frame is a little-endian `f32` command stream written by `frame.ts`. Copies:
1. `FrameWriter` writes into a reused, growable `Float32Array`. `finish()` copies exactly the used bytes into a new ArrayBuffer (JS).
2. The generated glue copies that ArrayBuffer into a Rust `Vec<u8>`.
3. The `Vec` moves into the pending slot (no copy).
4. The render thread decodes the frame and rasterizes into a reused pixmap.
5. `write_texture` copies the pixmap to the GPU.
6. A GPU blit scales it onto the swapchain image.

No borrowed JS memory is retained or read off the JS thread.

## Input and Worklets

Touch input can run directly into Rust with `touchInput="rust"` and `Surface::enable_touch()`. The default is `"none"`. Worklets endpoints must catch `ERR_RNR_CLOSED` during teardown; `$open` is advisory, and implementations must check their own closed state before mutation.

## Touch input (Android, opt-in; 2026-10-20)

**Prototype.** Native touch from the `SurfaceView` straight to Rust (`rnrs-surface` `touch.rs`), without JS. Engine-independent: a renderer drains plain records. Android only. Device evidence and the Bevy consumer: [bevy3d.md](../packages/bevy3d/README.md#native-touch). Not a winit window or event loop, and not a promise of winit compatibility. The records could later be mapped onto winit-style events.

**Opt-in on both sides.**
- The renderer calls `Surface::enable_touch()`.
- The app sets `<SurfaceView touchInput="rust">`. The default is `"none"`: the view consumes no touches, as before.
- iOS and the browser support the prop too: see [Touch input (iOS)](#touch-input-ios-opt-in-2026-10-20) and [Touch input (browser)](#touch-input-browser-opt-in-2026-10-20).

**Path and threads.**
- The Kotlin `onTouchEvent` calls `nativeTouch(key, attachment, phase, pointerId, xPx, yPx, eventTimeMs)` once per pointer, on the UI thread. The arguments are primitives only.
- Rust appends to the surface's bounded queue under the queue's mutex. Then, separately, it takes the surface-state mutex to fetch the waker, and wakes the renderer. Each mutex is taken alone.
- The UI thread can wait for either mutex only during another holder's short critical section: a push, the renderer moving at most 128 records out, a state snapshot or lease, or attach/resize/detach/close bookkeeping. It never waits for rendering or GPU work and never calls JS. It is not lock-free or wait-free.
- The renderer calls `drain_touch(&mut Vec)` on its own thread.

**Gesture ownership (Kotlin view).**
- On `ACTION_DOWN` the view consumes the gesture only if Rust accepts the down. Otherwise `onTouchEvent` returns the default (false), so the touch goes to whatever else wants it.
- Once consumed, the view returns true until `ACTION_UP`/`ACTION_CANCEL`, even if Rust stops accepting (detach, reattach, opt-out). It then forwards only what Rust still accepts, so the gesture is never half owned.
- `ACTION_POINTER_DOWN` adds a pointer to an owned gesture. It is refused, and that pointer ignored, beyond 10 pointers or when ids are exhausted.
- `ACTION_MOVE` sends every pointer. Historical samples are not sent: moves are coalesced.
- `ACTION_UP`/`ACTION_POINTER_UP` carrying `FLAG_CANCELED` (Android 13+, e.g. palm rejection) cancels that pointer instead of ending it. Untested: the Pixel 2 XL runs Android 11.
- `ACTION_CANCEL`, or setting the prop to `"none"` mid-gesture, cancels every pointer.
- The view never calls `requestDisallowInterceptTouchEvent`. A parent that intercepts (a scroll view) makes Android send `ACTION_CANCEL`. That is the expected behaviour; it is **untested**.

**Queue contract** (`touch.rs` docs):

| Concept | Rule |
| --- | --- |
| Epoch | The attachment number. Events are accepted only for the current attachment. Attach starts an epoch with no pointers. Detach (`surfaceDestroyed`, unmount, key change, zero size) and close queue a `Reset` and refuse that attachment from then on. A pointer still down from the old window is unknown in the new epoch, so its moves and up are dropped. No separate window registry. |
| Reset | "Cancel every pointer you have seen down and not yet ended", across epochs. It is queued even if no frame follows. Records before it stay valid. |
| Stable ids | A u64 from a per-surface counter, assigned at each accepted down and never reused; Android's reused pointer ids map to it only while down. At 2^53 new downs are refused (fail closed). |
| Bounds | 10 tracked pointers; 128 queued records, so a drain returns at most 128. |
| Coalescing | A move replaces the queued move of the same pointer only if no transition (down, up, cancel, reset) was queued after it. Within that trailing run of moves each record is its pointer's latest snapshot. The order between different pointers' moves in the run is not meaningful. Transitions are never reordered or merged. |
| Overflow | A push that finds the queue full replaces it with one `Reset { Overflow }`. Every pointer down then is marked lost, and its later events are dropped until its up or cancel. New downs start normally. An end that cannot be queued is therefore always covered by a reset: no touch can stay down. |
| Units | Component-local physical pixels (top-left origin, y down), plus the attachment's width, height and scale as they were at push time (a later resize does not change queued events). `TouchEvent::logical()` divides by the scale. |
| Time | `MotionEvent.getEventTime()`: `SystemClock.uptimeMillis`, monotonic. Not comparable with `Date`, `Instant` or another device's clock. |

**React Native interplay (only what was tested).**
- Overlays: a native-backed RN view (`ReactViewGroup`, e.g. a `Pressable`) drawn above the surface consumes its own touches (RN 0.83 `ReactViewGroup.onTouchEvent` returns true unless `pointerEvents` forbids it), so the surface below should get none. On the Pixel 2 XL, a tap on the TSX `Pressable` above the surface paused the scene through JS and fed nothing to Rust ([bevy3d.md](../packages/bevy3d/README.md#native-touch)).
- JS still gets touch events for the surface view itself through the root view's dispatcher (responders, `onTouchStart`). Whether a JS responder, parent `Pressable`, `ScrollView` or RNGH handler also acting on the same gesture behaves well is **untested**; no interop is claimed.
- The Worklets gesture path (`bevy-worklets`) is unchanged and uses the default `"none"`.

**Noted, not changed:** every push wakes the renderer; there is no batching or rate limit. The multi-touch policy (10 pointers, refusing further downs) has host tests only.

**Not included** (in this Android slice; iOS and browser have their own sections below): keyboard, stylus, hover, wheel, gesture recognition, an input matrix or performance study.

Tests: `cargo test -p rnrs-surface`.
- The queue: opt-in and stale-attachment refusal; stable ids across reused platform ids; logical units and the per-event scale; coalescing only within the trailing run of moves; overflow resets, with lost pointers dropped until their end; an overflowing end covered by the reset; detach on a full queue; close; pointer and id exhaustion.
- A 200 000-step pseudo-random stream (random drains, epochs, cancels, overflows) checked against a consumer model: no contradiction, and nothing left down.
- Through the platform entry points: wake, detach reset, per-attachment separation, resize, close.

## Touch input (browser, opt-in; 2026-10-20)

**Prototype.** Browser PointerEvents go into the same `touch.rs` queue and contract as Android. Bounds, reset, ids, coalescing, overflow and units are unchanged, and no engine is involved. Only the platform side differs.

**Opt-in on both sides:** the renderer calls `Surface::enable_touch()`, and `<SurfaceView touchInput="rust">` (`index.web.tsx`) opts in. Changing the prop does not remount the canvas.
- With `"none"`, the default, the host element gets no pointer listeners, no `touch-action` and no `preventDefault`.
- With `"rust"`, the host element gets `touch-action: none`, so touch pans and pinches go to the listeners instead of scrolling the page. This applies to every touch on the element, including touches Rust refuses: those do not pan the page either. The previous value is restored on opt-out or unmount.
- **Bundle compatibility:** the surface bootstrap now requires the `rnr_surface_touch` export. The bootstrap and the generated Wasm bundle must come from the same `rnrs-surface`; an older bundle is rejected at bootstrap.

**Path and threads.**
- Pointer listeners run on the browser main thread, which is the JS thread. The canvas host (`canvas-host.ts`) calls the wasm export `rnr_surface_touch(key, token, phase, pointerId, xPx, yPx, timeMs)` (`web_exports.rs` → `web_host::touch`). That pushes under the queue mutex.
- No module call, JSI or new thread is involved. Only the framework host sees the events, which no app JS needs to forward.
- The renderer drains with `drain_touch` as on Android. There is no waker on wasm, so the renderer drains on its next frame or call.

**Epoch = attachment token.**
- `web_host` attach, resize and detach call the queue's `begin`/`resize`/`end(Detached)` with the browser attachment token. The authority is the existing `Surface` state; there is no second registry.
- A browser `Surface::close` keeps the attachment until the host detaches, so `web_host::touch` refuses pushes once the surface is closed. The host's detach then queues the reset.

**Gesture ownership (canvas host).**
- **Delivered pointers:** `pointerType` `touch`, and `mouse` while its primary button is down. The mouse is included for desktop testing and desktop users.
- **Not delivered:** pen/stylus, hover, the other mouse buttons, wheel and keyboard. They are not consumed.
- **Down:** a pointerdown is pushed. Only if Rust accepts it does the host take the pointer: `setPointerCapture`, then `preventDefault()` on that down only. A refused down is left alone for whatever else wants it.
  - For a mouse, the `preventDefault()` also suppresses the gesture's compatibility mouse events (`mousedown`, `mousemove`, `mouseup`; `click` is not a compatibility event and still fires).
  - If `setPointerCapture` throws, the accepted pointer is canceled at once, not taken, and the error is reported.
- **Chorded mouse:** releasing the primary button while another button is held arrives as a `pointermove` with `buttons & 1 == 0`. The host ends the pointer with an up there and ignores the later `pointerup`.
- **Moves and end:** moves and `pointerup` are forwarded only for taken pointers. Capture keeps them flowing outside the element.
- **Cancels:** `pointercancel` and `lostpointercapture` (without a preceding up) cancel the pointer. Opting out mid-gesture sends cancel-all.
- **Detach:** every detach drops the host's ownership: hidden page, `pagehide`, zero size, unmount, key change, runtime replacement, or a stale/closed render. Rust queues `Reset { Detached }` for the old token. That pointer's later events are not forwarded, and a new attachment starts with no pointers.

**Units.** `xPx = (clientX − rect.left) × extent.width / rect.width` per axis, from `getBoundingClientRect()` of the host element and the extent Rust holds for the token.
- These are element-local physical pixels. The element's far edge maps to the attached width and height, so CSS transforms that scale the element are accounted for.
- A resize reaches Rust on the next frame. Until then, events map into the old extent, which they also carry.
- **Time** is `PointerEvent.timeStamp`, truncated to milliseconds. It is relative to `performance.timeOrigin`, so it is not Android uptime and not wall-clock time.

## Touch input (iOS, opt-in; 2026-10-20)

**Prototype.** UIKit touches on `RnrSurfaceViewComponentView` go straight to the same Rust queue as Android (`touch.rs`, the contract above), without JS. Opt-in is the same on both sides: `Surface::enable_touch()` and `touchInput="rust"`. `src/index.ts` now passes the prop through on iOS. Simulator only; no physical device run.

**Path.** `touchesBegan`, `touchesMoved`, `touchesEnded` and `touchesCancelled` on the component view call `rnr_surface_touch(key, attachment, phase, slot, xPx, yPx, timeMs)` on the main thread. The content view (`RnrMetalView`) does not override them, so its touches reach the component view through the responder chain. The view adds no worker, gesture recognizer or JS call. Off the main thread the entry point refuses.

**Ownership (per `UITouch`, not per gesture).**
- A began touch is owned only if Rust accepts its down. Every touch that is not owned goes to `super`, the next responder. A mixed `NSSet` is split, so only the owned touches are kept.
- An owned touch stays owned until its own ended or cancelled, even after a revoke, a reattach or an opt-out. Its remaining phases are then *stale*: swallowed, never sent to `super` and never sent to the new attachment.
- Slots 0..9 name the touches of the current attachment only. Rust maps each slot to a new stable id at each accepted down. A revoke (key change, removal from the window, will-resign-active, invalidate, dealloc, a disposed surface) marks every owned touch stale and frees all slots. A slot therefore names a new pointer only after a new accepted down; an old `UITouch` never reuses one.
- Owned touches are retained, at most 20 (current plus stale). Each is released at its end. A touch that UIKit ended without telling the view is purged at the next began; if it was still forwarding, a cancel is sent to Rust first, so its pointer does not stay down there.
- `touchInput` set to `"none"` mid-gesture sends a cancel-all, then marks the owned touches stale. `multipleTouchEnabled` is set on the content view only while opted in.

**Units.** View-local points times the scale of the current attachment, the last scale passed to attach or resize. That is the scale Rust stores with each event, so the positions are physical pixels. Time is `UITouch.timestamp` (system uptime) in milliseconds.

**Interplay (explicit limits).**
- RN views drawn above the surface as siblings are hit-tested first and take their own touches. Tested: a sibling `Pressable` overlay.
- RN *children* of `<SurfaceView>` are different and untested. Fabric views do not consume touches in UIKit, so a touch on a child that does not handle it travels up the responder chain to the surface view. With `touchInput="rust"` it is then captured for Rust like a touch on the surface, and JS still sees it through the root handler. Put controls next to the surface, not inside it.
- React Native's root touch handler is a recognizer that does not cancel touches in views. JS therefore still gets events for the surface view; no interop with JS responders is claimed.
- A parent `UIScrollView` whose pan recognizes cancels the touches here, which cancels them in Rust. Untested.
- No `exclusiveTouch`. RNGH and Worklets interplay is untested.

**Not evidenced.**
- That stale touches are never forwarded to `super`: code review only. Nothing above the view observes the responder chain in this app.
- Physical iPhone: a runner on the device would be a second app install.
- Parent scroll views, gesture handlers, stylus and hover.
- Interleaving of touches with a busy JS thread.

Tests: `cargo test -p rnrs-surface -p touch-probe`. The probe's consumer model and the platform entry points (gesture, revoke and reattach with an old slot, close) are host-tested. The Objective-C++ code has only the simulator run.

**Limits:** simulator validation only; physical iPhone, parent scroll views, gesture handlers, stylus, hover and busy-JS interaction are untested.

Tests: `cargo test -p rnrs-surface -p touch-probe`. Platform reproduction uses `scripts/consumer/surface-device-test.mjs`, `scripts/consumer/ios-touch-sim-test.mjs` and `fixtures/web-touch`.
