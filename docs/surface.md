# Rendering surfaces

`@rnrs/surface` gives a Rust renderer a platform surface: an Android `SurfaceView`, an iOS Metal
view or a browser canvas, with lifecycle gates and opt-in native touch input. For a complete
first renderer, follow [Draw a triangle](triangle.md).

- **TypeScript** owns layout and controls. Application state can live in TypeScript or Rust.
- **Rust** owns rendering resources. A renderer can consume state submitted from TypeScript or run its own simulation.
- **The framework** owns the platform view, window lifetime and runtime teardown. Apps need no native edits.

Renderer modules depend on `rnrs` with the `wgpu` or `surface` feature, and apps list `@rnrs/surface`
as a direct dependency ([packaging](packaging.md#rust-library-packages)).

## The wgpu adapter (rnrs::gpu)

With `rnrs = { version = "0.2", features = ["wgpu"] }`, a renderer writes only its pipeline and
draw commands. `rnrs::gpu` owns the surface, render loop, device, swapchain, window lease, teardown
and failure handling on Android (Vulkan), iOS (Metal) and the browser (WebGPU). The API is
documented in `packages/surface/rust/src/gpu/mod.rs`.

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

- Each attachment gets new resources (`create`, then `resized` on every size change). A failure ends rendering for that attachment with no retry; a new attachment tries once.
- Native frames are capped at `Options::max_frame_rate` (default 60); the browser draws once per `requestAnimationFrame`. Hooks never run under a framework lock.
- Use `rnrs::gpu::wgpu`, so the renderer uses the adapter's wgpu version.
- `vello2d` and `bevy3d` keep their own render loops and do not use the adapter.

## Platform views

**Android** uses a `SurfaceView`: its content is a separate compositor layer, with no extra GPU copy
and lower latency than a `TextureView`. Consequences:

- React Native views drawn later in the tree, such as an absolutely positioned HUD, appear above the content.
- Transforms, opacity and rounded-corner clipping of the view or its ancestors do not apply to the content.
- Two overlapping surfaces have an undefined order.
- Draw opaque content (clear every frame to an opaque color). An opaque alpha mode is not guaranteed, so transparent content composites in a driver-dependent way.
- The platform destroys the surface when the window is hidden and recreates it on return; the lifecycle contract below handles that.

**Browser.** `<SurfaceView>` gives each surface key a fresh `<canvas>`. See [browser presentation](#browser-presentation).

## Lifecycle contract

| Concept | Rule |
| --- | --- |
| Surface key | Opaque JS number, never reused, below 2^53. It names the module binary that owns the surface (owner × 2^32 + local key; the framework assigns owners), so each binary keeps its own surfaces and the view's calls reach only that binary. A key from a disposed surface or an earlier JS runtime matches nothing. No pointer reaches JS. |
| Attachment | Each attach gets a fresh number. Resize and detach must name it, so a late callback for an earlier attachment is ignored. |
| Zero extent | The view attaches only with a nonzero size and detaches when its size becomes zero. Give the view a size. |
| One window per key | The first attached view wins; a second view with the same key is refused (`BUSY`) and retries with backoff until the first detaches. A platform window is owned by at most one attachment process-wide, across all module binaries: the framework claims it before handing it to the owning binary, which returns the claim only when its renderer releases the window. Until then any other attach of that window is `BUSY`. |
| `WindowLease` | The renderer's only access to the window. Every acquire and present is admitted separately through it, and nothing is admitted after the attachment is revoked. |
| Detach | Synchronous, as Android's `surfaceDestroyed` requires. It revokes the attachment, wakes the renderer and waits up to **500 ms** for leases to be dropped. The wait includes an admitted acquire or present and swapchain destruction (a GPU wait), not device creation. |
| After a detach timeout | The view continues. Operations already admitted may finish, but no new one is admitted; the window stays retained until the renderer releases it. Counted as `detachTimeouts`. |
| Close | `close()` revokes the current attachment and refuses new ones. It never blocks. |
| Threads | Platform callbacks run on the UI thread and never touch JS. Render threads never touch JSI. Framework locks are never held while calling renderer code. |

## Runtime teardown hook

A renderer's thread and GPU device must stop when its JS runtime is torn down (reload,
invalidation), even if JS, Worklets or native references to it survive.

- While the framework creates a module instance (`Module::default()`), the runtime's `TeardownScope` is current. Capture it with `TeardownScope::current()` and keep it; it is not current during later method calls. A module created outside the runtime (a Rust test) has no scope and must be given one.
- Register renderers with the scope (`GpuSurface::spawn` does this). Teardown retires them, so an old mounted view cannot attach to a renderer that no longer exists.
- A `Retire` implementation must be idempotent and non-blocking, and may run on any thread, including a finalizer or UI thread: no JSI, GPU waits or thread joins.

## Renderer obligations

These apply to renderers that manage their own loop instead of using `rnrs::gpu`:

- Hold the `WindowLease` only while acquiring and presenting, and admit each operation through it. A detach waits for leases, so long work under a lease delays the platform.
- `close()` and `Drop` only set flags and notify. Drop the swapchain, raster resources and device on the render thread; never join it from JS, UI or finalizer threads.
- Panics abort the process. Return errors for input-dependent cases (formats, alpha modes, sizes, frames) instead of unwrapping.

### vello2d

`@rnrs/example-vello2d` rasterizes on the CPU (vello_cpu) on a render thread and presents with wgpu.

- **Frames.** One `submit(ArrayBuffer)` per frame, a little-endian `f32` command stream written by `frame.ts`. The latest frame wins. `submit` returns `false` only after close.
- **Process cap.** At most 4 render threads per process, counting closed renderers still releasing their GPU. At the cap, `create` fails immediately.
- **GPU states** (`stats().gpuState`): `none`, `ready`, `recovering` (retried with backoff from 100 ms to 3.2 s) and `failed` after 6 consecutive failures, kept until the next attachment or resize. Lost surfaces and devices are recreated.
- **Raster size** is `resolutionScale` of the window, reduced uniformly so neither side exceeds 4096.

## Browser presentation

WebGPU is the browser GPU path. There is no automatic fallback: no WebGL, and no Canvas 2D for
GPU renderers. The Canvas 2D transport (Rust returns RGBA pixels for `putImageData`) exists only for
CPU renderers such as vello2d.

- A renderer's presentation mode (`Canvas2d` or `WebGpu`) is fixed for its lifetime. A canvas keeps its first context type, so a mount in a different mode needs a new element; `<SurfaceView>` gives each surface key one.
- WebGPU needs a secure context (HTTPS or localhost), a browser with WebGPU enabled and an available adapter. Without them the attachment fails.
- Render outcomes: `pending` (setup in flight), `submitted` (GPU work submitted, not proof of display), `unchanged` and `failed`. A failure is terminal for that attachment and reported once; a remount, `refresh()` or becoming visible again tries once more.
- Setup (adapter, device, pipeline) is asynchronous on the JS thread. A setup made stale by detach or close destroys what it built.
- Headless browsers with software WebGPU can lose the device. Check visible output in a real browser.

## Touch input

Touches can go straight from the platform view to Rust, without JS. Opt in on both sides:

- the renderer calls `Surface::enable_touch()`;
- the app sets `<SurfaceView touchInput="rust">`. The default `"none"` consumes no touches.

The renderer drains plain records with `drain_touch(&mut Vec)` on its own thread. This is not a
winit window or event loop.

| Concept | Rule |
| --- | --- |
| Epoch | Events belong to the current attachment. Detach (hide, unmount, key change, zero size) and close queue a `Reset`; a pointer still down from the old attachment is unknown in the new one. A closed renderer may stop before it drains the `Closed` reset. |
| Reset | "Cancel every pointer you have seen down and not yet ended." Records before it stay valid. |
| Stable ids | A `u64` assigned at each accepted down and never reused. |
| Bounds | 10 tracked pointers; 128 queued records per drain. |
| Coalescing | A move replaces the queued move of the same pointer only if no transition (down, up, cancel, reset) was queued after it. Transitions are never reordered or merged. |
| Overflow | A full queue is replaced by one `Reset { Overflow }`; affected pointers' later events are dropped until their end. No touch can stay down. |
| Units | Component-local physical pixels (top-left origin, y down), with the attachment's width, height and scale at push time. `TouchEvent::logical()` divides by the scale. |
| Time | Android `SystemClock.uptimeMillis`, iOS `UITouch.timestamp`, browser `PointerEvent.timeStamp`, in milliseconds. Not comparable across platforms or with wall-clock time. |

Every push wakes the renderer (on the web, it drains on its next frame); there is no batching.
Keyboard, stylus, hover, wheel and gesture recognition are not provided.

### Touch input (Android)

- The view takes a gesture only if Rust accepts its down; otherwise the touch goes to other handlers. Once taken, it keeps the gesture until up or cancel.
- Moves are coalesced; historical samples are not sent. Pointers beyond 10 are ignored.
- `ACTION_CANCEL`, or setting the prop to `"none"` mid-gesture, cancels every pointer. A parent that intercepts (a scroll view) causes a cancel.
- React Native views drawn above the surface take their own touches. JS still receives touch events for the surface view itself; interplay with JS responders, `ScrollView` or Gesture Handler on the same gesture is untested.

### Touch input (iOS)

- Ownership is per `UITouch`: a touch is owned only if Rust accepts its down; others go to the next responder.
- RN children of `<SurfaceView>` that do not handle a touch pass it up to the surface, which captures it for Rust. Put controls next to the surface, not inside it.
- A parent `UIScrollView` that starts panning cancels the touches. Use a single gesture owner: native surface touch and Gesture Handler coordination on the same gesture has not been validated.
- A known iOS interaction issue: a React Native button may not respond to a second finger while another finger is held down. Its cause is unresolved.
- Observed on iOS: after a detach or `close()` the view keeps showing its last presented frame; it is not cleared. After `close()` the view stays mounted on the closed key until React unmounts it.

### Touch input (browser)

- Delivered: `pointerType` `touch`, and `mouse` while its primary button is down. Pen, hover, other buttons, wheel and keyboard are not delivered or consumed.
- With `"rust"`, the element gets `touch-action: none`, so touches on it never scroll or zoom the page, including touches Rust refuses. The previous value is restored on opt-out or unmount.
- An accepted down takes pointer capture and calls `preventDefault()` on that down only, which suppresses the compatibility mouse events (`click` still fires).
- The surface bootstrap and the Wasm bundle must come from the same `@rnrs/surface` version; an older bundle is rejected at bootstrap.
