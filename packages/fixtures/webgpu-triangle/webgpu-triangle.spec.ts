// Lab fixture for the rnrs wgpu adapter (rnrs::gpu): one triangle drawn by Rust with wgpu into an
// @rnrs/surface view (Android: Vulkan, iOS: Metal, browser: WebGPU into the canvas). No pixel
// readback or CPU upload; no fallback to another backend.
import type { NativeModule, NativeObject } from '@rnrs/runtime/spec';

export interface TriangleStats {
  /** "attached" (a window or canvas is attached), "detached" or "closed". */
  state: string;
  /** "none", "initializing" (adapter/device/surface setup in flight), "ready", or "failed"
   *  (terminal for the attachment: unsupported, device lost or a validation error; a new
   *  attachment starts over once). */
  gpuState: string;
  surfaceWidth: number;
  surfaceHeight: number;
  /** Frames whose GPU work was submitted and presented. Not proof of display. */
  framesSubmitted: number;
  /** Setups started, and setups that finished after their attachment had ended (dropped). */
  initsStarted: number;
  initsDiscarded: number;
  deviceLosses: number;
  /** Platform detaches that returned before the window was released (bounded wait timed out). */
  detachTimeouts: number;
  /** Adapter vendor/architecture and whether it is a fallback (software) adapter. */
  adapter: string;
  /** Swapchain format, alpha mode and present mode ("" until ready). */
  presentation: string;
  lastError: string | null;
}

export interface Triangle extends NativeObject {
  /** The opaque key for `<SurfaceView surfaceKey={...}>` (@rnrs/surface). */
  surfaceKey(): number;
  /** Background colour behind the triangle (0..1 each); requests one redraw. False once closed. */
  setBackground(r: number, g: number, b: number): boolean;
  stats(): TriangleStats;
  /** Lab only (browser): destroys the current GPU device, which the browser reports as a device
   *  loss. False natively. */
  destroyDeviceForTesting(): boolean;
  /** Lab only: arms one hook to call back into its own surface from inside the hook. "create": the
   *  next `create` calls set_state. "draw": the next `draw` calls set_state, then close. False for
   *  another mode. What the hooks did is in hookProbeLog(). */
  armHookProbeForTesting(mode: string): boolean;
  /** Lab only: the armed hooks' results, "; "-separated (e.g. "draw: set_state=true, closed"). */
  hookProbeLog(): string;
  /** Releases the surface and its GPU objects. Idempotent; never waits. */
  close(): void;
}

export interface WebgpuTriangleModule extends NativeModule {
  create(): Triangle;
}
