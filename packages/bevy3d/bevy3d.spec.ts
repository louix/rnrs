// A Rust-owned Bevy scene controlled from TypeScript. See README.md for platform limits.
import type { NativeModule, NativeObject } from '@rnrs/runtime/spec';

export interface SceneStats {
  /** "attached", "detached" (unmounted, background, zero size) or "closed". */
  state: string;
  surfaceWidth: number;
  surfaceHeight: number;
  /** "none", "ready" or "failed" (see lastError). Browsers also use "initializing"
   *  and "warming" while loading shaders. A new attachment retries after failure. */
  gpuState: string;
  /** Bevy updates (simulation + render into the offscreen texture). */
  framesRendered: number;
  /** Offscreen frames blitted and presented on the surface (browser: submitted to the canvas
   *  texture). */
  framesPresented: number;
  /** Presents skipped (acquire timeout, outdated swapchain, revoked attachment). */
  presentsSkipped: number;
  attaches: number;
  detaches: number;
  detachTimeouts: number;
  /** Cube rotation about Y in radians (wrapped to [0, 2π)), as last simulated. */
  angle: number;
  paused: boolean;
  /** Accepted rotation samples and latest sample applied by a successful Bevy update. */
  inputReceived: number;
  inputApplied: number;
  /** Android touch counts since the Bevy app was created. Enable with touchInput="rust". */
  touchesStarted: number;
  touchesEnded: number;
  touchesCanceled: number;
  touchResets: number;
  touchesActive: number;
  touchesPressed: number;
  /** Last fed touch position, logical pixels (layout units) from the surface's top-left. */
  lastTouchX: number;
  lastTouchY: number;
  /** Surface touch queue counts since the scene was created. */
  touchAccepted: number;
  touchCoalesced: number;
  touchOverflows: number;
  touchRefused: number;
  touchDropped: number;
  /** Device setup and Bevy warm-up time, in milliseconds. */
  deviceInitMs: number;
  firstUpdateMs: number;
  /** Swapchain format, view format, alpha and present mode ("" while not bound). */
  presentation: string;
  lastError: string | null;
  /** Open scenes and live render threads across runtimes.
   *  In browsers, renderThreadsAlive counts scenes holding WebGPU state. */
  scenesOpen: number;
  renderThreadsAlive: number;
  ownedByRuntime: boolean;
}

export interface Scene extends NativeObject {
  /** The opaque key for `<SurfaceView surfaceKey={...}>` (@rnrs/surface). */
  surfaceKey(): number;
  /** Latest-value controls, applied by the render thread before its next update. Each
   *  returns false, without throwing, once the scene is closed. */
  setPaused(paused: boolean): boolean;
  /** Gamma-encoded sRGB components (as CSS colours, not linear), each 0 to 1. */
  setColor(r: number, g: number, b: number): boolean;
  /** Rotation speed in radians per second, -20 to 20. */
  setSpeed(radiansPerSecond: number): boolean;
  /** Absolute Y rotation in radians, -1000000 to 1000000. Returns false if closed or busy.
   *  For Android Worklets, allow-list Scene.setRotation and capture this handle. */
  setRotation(radians: number): boolean;
  stats(): SceneStats;
  /** Stops rendering; the render thread releases the window, Bevy and the GPU. Idempotent;
   *  never blocks. dispose() also closes. */
  close(): void;
}

export interface Bevy3DModule extends NativeModule {
  /** Creates a scene; fails if two render threads are still running or releasing resources. */
  create(): Scene;
}
