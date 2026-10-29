// Submit whole frames from TypeScript; Rust owns rasterization and presentation.
import type { NativeModule, NativeObject } from '@rnrs/runtime/spec';

export interface RendererOptions {
  /** Raster pixels per physical surface pixel, 0.25 to 1. Lower values render a smaller
   *  image and let the GPU scale it up when presenting. */
  resolutionScale: number;
  /** Optional timing history capacity, up to 65536 events; 0 (default) disables recording. */
  timingRecords?: number;
}

export interface RendererStats {
  /** "attached", "detached" (unmounted, background or zero size), or "closed". */
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
  /** Whether runtime teardown automatically closes this renderer. */
  ownedByRuntime: boolean;
}

export interface Renderer extends NativeObject {
  /** The opaque key for `<SurfaceView surfaceKey={...}>` (@rnrs/surface). */
  surfaceKey(): number;
  /** Copies and replaces the pending frame; returns false if closed.
   *  Throws for buffers over 1 MiB or not a multiple of 4 bytes. Malformed commands
   *  are skipped and counted in framesInvalid. */
  submit(frame: ArrayBuffer): boolean;
  stats(): RendererStats;
  /** Returns recorded timing events and clears the history; empty when disabled.
   *  The binary format is documented in rust/src/timing.rs. */
  drainTimings(): ArrayBuffer;
  /** Stops rendering; the render thread releases the window and GPU resources. Idempotent;
   *  never blocks. dispose() also closes. */
  close(): void;
}

export interface Vello2DModule extends NativeModule {
  /** Creates a renderer; fails if two render threads are still running or releasing resources. */
  create(options: RendererOptions): Renderer;
}
