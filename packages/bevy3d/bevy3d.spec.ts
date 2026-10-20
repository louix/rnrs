// Bounded Bevy example for @rnrs/surface (Android; iOS and browser experimental): the TypeScript
// contract. Rust owns the scene, the simulation and the render loop (a Bevy app rendering one
// rotating cube into an offscreen texture, blitted and presented on the surface): on its own
// thread natively, and in the browser in the host's requestAnimationFrame callback. TypeScript
// only sets a few latest-value controls; no per-frame work happens in app JavaScript.
// See docs/bevy3d.md for scope and limits.
import type { NativeModule, NativeObject } from '@rnrs/runtime/spec';

export interface SceneStats {
  /** "attached", "detached" (unmounted, background, zero size) or "closed". */
  state: string;
  surfaceWidth: number;
  surfaceHeight: number;
  /** "none" (no device yet), "ready", or "failed": a GPU or surface error ended rendering for
   *  the current attachment (no retry until the next attachment); see lastError. Browser only:
   *  "initializing" (asynchronous WebGPU setup) and "warming" (submitting, but Bevy's cube
   *  pipeline is not created yet). "ready" is not proof of display. */
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
  /** Native touch input (Android, `<SurfaceView touchInput="rust">`), counted by the Bevy
   *  adapter since the current Bevy app was created: touches started, ended, canceled (by the
   *  platform, a reset or a new attachment), resets applied, touches down as fed, and touches
   *  pressed in Bevy's `Touches` after the last update. Browser and iOS: always 0. */
  touchesStarted: number;
  touchesEnded: number;
  touchesCanceled: number;
  touchResets: number;
  touchesActive: number;
  touchesPressed: number;
  /** Last fed touch position, logical pixels (layout units) from the surface's top-left. */
  lastTouchX: number;
  lastTouchY: number;
  /** rnr-surface's queue, since the scene was created: accepted records, moves coalesced,
   *  overflow resets, and pushes refused (stale attachment, not opted in, capacity) or
   *  dropped (pointer canceled by a reset or unknown). */
  touchAccepted: number;
  touchCoalesced: number;
  touchOverflows: number;
  touchRefused: number;
  touchDropped: number;
  /** Device creation, and Bevy app creation with its warm-up updates (pipeline compilation,
   *  done before any window is leased), in milliseconds. */
  deviceInitMs: number;
  firstUpdateMs: number;
  /** Swapchain format, view format, alpha and present mode ("" while not bound). */
  presentation: string;
  lastError: string | null;
  /** Process-wide: scenes not yet closed, and render threads alive (running, or closed but
   *  still releasing GPU resources). create() fails at the thread limit. Browser: no threads;
   *  renderThreadsAlive counts scenes holding WebGPU state, and the limit applies to open scenes. */
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
  /** Absolute Y rotation in radians [-1000000, 1000000]. One latest-value slot;
   * false if closed or the inbox is busy (sample dropped). Never waits for rendering.
   * Opt-in Android worklet endpoint: allow-list Scene.setRotation and capture this handle. */
  setRotation(radians: number): boolean;
  stats(): SceneStats;
  /** Stops rendering; the render thread releases the window, Bevy and the GPU. Idempotent;
   *  never blocks. dispose() also closes. */
  close(): void;
}

export interface Bevy3DModule extends NativeModule {
  /** Fails immediately (never waits) when the process already has the maximum number of
   *  render threads alive, counting closed scenes still releasing GPU resources. */
  create(): Scene;
}
