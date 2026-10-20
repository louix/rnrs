// 2D renderer for @rnrs/surface (Android): the TypeScript contract. TypeScript owns all
// application and game state and submits whole frames; Rust (rust/) owns only rendering
// resources (render thread, Vello raster context, wgpu device and surface) and the latest
// submitted frame. See docs/surface.md and frame.ts for the frame format.
import type {NativeModule, NativeObject} from '@rnrs/runtime/spec';

export interface RendererOptions {
  /** Raster pixels per physical surface pixel, 0.25 to 1. Lower values render a smaller
   *  image and let the GPU scale it up when presenting. */
  resolutionScale: number;
  /** Lab diagnostics (docs/research/js-contention-plan.md): capacity of a ring of submit and
   *  present events with monotonic timestamps, read with `drainTimings()`. 0 or absent (the
   *  default) records and allocates nothing. At most 65536. */
  timingRecords?: number;
}

export interface RendererStats {
  /** "attached": a platform window is attached; "detached": none (unmounted, background,
   *  zero size); "closed": after close() or dispose(). A string because the generator does
   *  not yet support string-literal unions. */
  state: string;
  /** Attached window in physical pixels, and the display scale (pixels per layout unit). */
  surfaceWidth: number;
  surfaceHeight: number;
  scale: number;
  rasterWidth: number;
  rasterHeight: number;
  framesSubmitted: number;
  /** Frames presented, including re-presentations after a resize or re-attach. */
  framesPresented: number;
  /** Submitted frames replaced by a newer one before the render thread took them. */
  framesReplaced: number;
  framesInvalid: number;
  attaches: number;
  detaches: number;
  resizes: number;
  detachTimeouts: number;
  /** Detach timeouts while an admitted acquire/present was still in flight. */
  detachTimeoutsInFlight: number;
  /** Attachments refused (surface or window busy, or closed). */
  refusedAttaches: number;
  surfaceErrors: number;
  /** GPU state: "none" (no device yet), "ready", "recovering" (retrying with backoff after a
   *  failure or a lost surface or device), "failed" (gave up until the next attachment or
   *  resize). submit() keeps accepting frames in every state except closed. */
  gpuState: string;
  deviceLosses: number;
  surfaceRecreations: number;
  recoveryAttempts: number;
  /** Swapchain format, view format, alpha and present mode ("" while not bound). */
  presentation: string;
  /** CPU time on the render thread for the most recent presented frame, in milliseconds
   *  (0 before the first): raster, texture upload call, swapchain acquire, and blit
   *  encoding + submit + the present call. */
  lastRasterMs: number;
  lastUploadMs: number;
  lastAcquireMs: number;
  lastPresentMs: number;
  /** CPU queue latency of the most recent presented frame: from Rust `submit` (after the
   *  JS-to-Rust copy) to the return of the present call on the render thread. Excludes GPU
   *  execution, composition and display; frames replaced before drawing are not measured. */
  lastSubmitToPresentReturnMs: number;
  /** Time to create the GPU device on the render thread (0 until it exists). */
  deviceInitMs: number;
  lastError: string | null;
  /** Process-wide: renderers not yet closed, and render threads alive (running, or closed
   *  but still releasing GPU resources). create() fails at the thread limit. */
  renderersOpen: number;
  renderThreadsAlive: number;
  /** Whether this renderer is closed automatically when its JS runtime is torn down
   *  (reload). False only for renderers created outside a runtime adapter. */
  ownedByRuntime: boolean;
}

export interface Renderer extends NativeObject {
  /** The opaque key for `<SurfaceView surfaceKey={...}>` (@rnrs/surface). */
  surfaceKey(): number;
  /** Replaces the pending frame (the latest submission wins; at most one frame waits, and
   *  one is being drawn). The bytes are copied. Returns false, without throwing, only once
   *  the renderer is closed; while the GPU is recovering or failed it returns true and the
   *  frame waits. Calls that reach the method after close are contained this way; calls
   *  through a torn-down runtime adapter or Worklets endpoint still throw before reaching it. Throws only for a frame
   *  larger than 1 MiB or not a multiple of 4 bytes; malformed commands are counted in
   *  `framesInvalid` and skipped on the render thread. */
  submit(frame: ArrayBuffer): boolean;
  stats(): RendererStats;
  /** Lab diagnostics: the events recorded since the last call (empty unless created with
   *  `timingRecords`). Little-endian header [magic, version, count, highWater: u32,
   *  dropped: u64, nowNs: u64 (CLOCK_MONOTONIC), capacity, pad: u32], then `count` records
   *  [tNs: u64, seq, frame, attachment: u32, kind: u16 (1 submit, 2 present returned,
   *  3 present call returned any error: skipped, revoked, surface lost, device lost or failed),
   *  pad: u16]. Only intervals between consecutive `seq` are meaningful. */
  drainTimings(): ArrayBuffer;
  /** Stops rendering; the render thread releases the window and GPU resources. Idempotent;
   *  never blocks. dispose() also closes. */
  close(): void;
}

export interface Vello2DModule extends NativeModule {
  /** Fails immediately (never waits) when the process already has the maximum number of
   *  render threads alive, counting closed renderers still releasing GPU resources. */
  create(options: RendererOptions): Renderer;
}
