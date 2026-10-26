# Rendering surfaces

`@rnrs/surface` embeds a Rust renderer in an Android `SurfaceView`, iOS Metal view or browser
canvas. React owns layout and controls; Rust owns rendering. Start with [Draw a triangle](triangle.md).

Renderer modules use `rnrs` with the `wgpu` or `surface` feature. Apps install `@rnrs/surface`
directly. Renderers can ship prebuilt binaries on all three platforms; see [packaging](packaging.md).

## The wgpu adapter (rnrs::gpu)

Implement `gpu::Renderer` with your pipeline and draw commands. `GpuSurface::spawn` handles the
device, swapchain, render loop and teardown. Use `rnrs::gpu::wgpu` so versions match.

- `create` builds resources for an attachment; `resized` handles size changes.
- `draw` returns `Next::Wait` to redraw on change, or `Next::Animate` for continuous rendering.
- `set_state` supplies the latest application state.
- Native animation is capped by `Options::max_frame_rate` (default 60); web uses animation frames.
- A rendering failure ends that attachment. A new attachment tries again.

See the [triangle implementation](triangle.md) and
[Rust API](../packages/surface/rust/src/gpu/mod.rs).

## Lifecycle

| Operation | Behavior |
| --- | --- |
| Mount | Give the view a nonzero size and the renderer's opaque surface key. Keys identify their owner; never construct or decode them yourself. |
| Attach | One view per surface and one renderer per platform window. A busy window is retried after its previous renderer releases it. |
| Resize | Updates the current attachment; stale callbacks are ignored. Zero size detaches it. |
| Detach | Revokes new rendering operations. Android waits up to 500 ms for existing window leases; iOS retires them asynchronously. Existing work may finish, and the window remains retained until released. |
| Close | Revokes the attachment and refuses new ones without blocking. Unmount the closed view in React. |
| Runtime teardown | Retires renderers even if JS or native references survive. Old surface keys cannot attach again. |

A detached view can retain its last displayed frame; detach does not promise to clear it.
Renderer hooks run without framework locks.

## Custom render loops

If you manage rendering yourself instead of using `rnrs::gpu`:

- Capture `TeardownScope::current()` while the module is created and register the renderer with it.
  The scope is not current during later method calls. `GpuSurface::spawn` does this for you.
- Access the window through a `WindowLease`, admitting each acquire and present. Keep leases short.
- Make `Retire`, `close` and `Drop` non-blocking and idempotent. Release GPU resources on the render
  thread; never join it or wait for the GPU on JS, UI or finalizer threads.
- Return errors for unsupported formats or other input-dependent failures. Panics abort the process.

## Platform behavior

**Android:** surface content is a separate compositor layer. React Native overlays can draw above
it, but transforms, opacity and rounded clipping do not affect the surface. Overlapping surfaces
have undefined ordering. Clear to an opaque color each frame.

**Browser:** GPU renderers use WebGPU; there is no automatic WebGL or Canvas 2D fallback.
CPU renderers can use the Canvas 2D pixel transport. WebGPU requires HTTPS or localhost and an
available browser GPU adapter. A surface key change creates a new canvas.

Browser setup is asynchronous. Detach or close discards stale setup. A failed attachment can retry
on remount, `refresh()` or becoming visible again. Use matching runtime and surface packages;
incompatible surface binaries are rejected during initialization.

## Touch input

Opt in on both sides:

```tsx
<SurfaceView surfaceKey={key} touchInput="rust" style={{ flex: 1 }} />
```

Call `Surface::enable_touch()` in Rust and consume `drain_touch(&mut Vec)` on the renderer's thread
(or next browser frame). The default `touchInput="none"` consumes no touches.

- Coordinates are component-local physical pixels, top-left origin. `TouchEvent::logical()` converts
  to logical coordinates. Each event includes the attachment's extent and scale.
- IDs remain stable during a touch. Detach, close or queue overflow produces `Reset`: cancel all
  held pointers. Records queued before the reset remain valid.
- The queue tracks 10 pointers and holds 128 records. Moves coalesce without reordering transitions.
- Timestamps are platform-relative milliseconds, not wall-clock time.
- Keyboard, pen, hover, wheel and gesture recognition are not provided. Browser input includes
  touch and primary-button mouse drags.

Use a single gesture owner. A parent scroll gesture can cancel native touches; do not combine
Rust touch handling and Gesture Handler ownership of the same gesture. On iOS, place controls
beside the surface rather than inside it. An RN button may not respond to a second finger while
another is held down; this interaction remains unresolved.

Browser Rust touch input sets `touch-action: none`, disabling scrolling and zooming on that
canvas. Accepted pointers are captured; opting out or unmounting restores the previous setting.
