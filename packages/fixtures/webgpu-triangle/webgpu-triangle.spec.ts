// Lab fixture for the optional browser WebGPU presentation of @rnrs/surface: Rust draws one
// triangle with wgpu (WebGPU backend) directly into the surface's canvas. No pixel readback or
// CPU upload; no Canvas 2D fallback. Web only.
import type {NativeModule, NativeObject} from '@rnrs/runtime/spec';

export interface TriangleStats {
  /** "attached" (the host bound a canvas), "detached" or "closed". */
  state: string;
  /** "none", "initializing" (adapter/device/surface setup in flight), "ready", or "failed"
   *  (terminal for the attachment: unsupported, device lost or a validation error; a new
   *  attachment starts over once). */
  gpuState: string;
  surfaceWidth: number;
  surfaceHeight: number;
  /** Frames whose GPU work was submitted for the canvas texture. Not proof of display. */
  framesSubmitted: number;
  /** Setups started, and setups that finished after their attachment had ended (dropped). */
  initsStarted: number;
  initsDiscarded: number;
  deviceLosses: number;
  /** Adapter vendor/architecture and whether it is a fallback (software) adapter. */
  adapter: string;
  /** Canvas texture format and alpha mode ("" until ready). */
  presentation: string;
  lastError: string | null;
  ownedByRuntime: boolean;
}

export interface Triangle extends NativeObject {
  /** The opaque key for `<SurfaceView surfaceKey={...}>` (@rnrs/surface). */
  surfaceKey(): number;
  /** Background colour behind the triangle (0..1 each); requests one redraw. False once closed. */
  setBackground(r: number, g: number, b: number): boolean;
  stats(): TriangleStats;
  /** Lab only: destroys the current GPU device, which the browser reports as a device loss. */
  destroyDeviceForTesting(): boolean;
  /** Releases the canvas binding and GPU objects. Idempotent; never waits. */
  close(): void;
}

export interface WebgpuTriangleModule extends NativeModule {
  create(): Triangle;
}
