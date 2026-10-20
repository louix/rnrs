// Lab fixture (docs/surface.md, "Touch input"): a GPU-free consumer of rnr-surface touch input.
// A probe owns one surface with touch enabled and no renderer, so nothing is drawn. There is
// no background consumer: records stay in the surface's bounded queue until `drain()` moves
// them, on the calling (JS) thread, into bounded consumer state checked against the queue
// contract. Evidence from it shows platform delivery into the queue, not render-thread
// consumption or input latency.
import type {NativeModule, NativeObject} from '@rnrs/runtime/spec';

/** A pointer down for the consumer: its latest record. */
export interface ProbePointer {
  /** Stable id (never reused on this surface). */
  id: number;
  attachment: number;
  /** "down" or "move": the latest phase seen. */
  phase: string;
  /** Component-local physical pixels, and the attachment extent captured at push time. */
  xPx: number;
  yPx: number;
  width: number;
  height: number;
  scale: number;
  /** Platform uptime in milliseconds (not wall-clock). */
  timeMs: number;
}

/** One drained record. */
export interface ProbeRecord {
  /** "down", "move", "up", "cancel" or "reset". */
  kind: string;
  /** For "reset": "overflow", "detached" or "closed"; otherwise "". */
  reason: string;
  /** 0 for a reset. */
  id: number;
  attachment: number;
  xPx: number;
  yPx: number;
  width: number;
  height: number;
  scale: number;
  timeMs: number;
}

export interface ProbeStats {
  /** "attached", "detached" or "closed". */
  state: string;
  attachment: number;
  surfaceWidth: number;
  surfaceHeight: number;
  scale: number;
  /** drain() calls, and records drained, since creation. */
  drains: number;
  records: number;
  downs: number;
  moves: number;
  ups: number;
  cancels: number;
  resetsOverflow: number;
  resetsDetached: number;
  resetsClosed: number;
  /** Pointers down for the consumer after this drain (at most 10), oldest first. */
  down: ProbePointer[];
  maxDown: number;
  /** Highest stable id seen. */
  maxId: number;
  /** Records that contradict the queue contract (a reused or non-increasing id, an event for
   *  a pointer not down, an attachment going backwards, more than 10 down). */
  contradictions: number;
  lastContradiction: string | null;
  /** The last records drained (at most 32), oldest first. */
  recent: ProbeRecord[];
  /** Producer-side counters of the surface's queue (rnr-surface TouchCounters). */
  accepted: number;
  coalesced: number;
  refusedStale: number;
  refusedCapacity: number;
  dropped: number;
  overflows: number;
  /** Pointers down on the producer side, at this call. */
  producerDown: number;
}

export interface Probe extends NativeObject {
  /** The opaque key for `<SurfaceView surfaceKey={...} touchInput="rust">`. */
  surfaceKey(): number;
  /** Drains the queue now, on this thread, applies the records to the consumer state and
   *  returns it. The only consumer: nothing drains between calls. */
  drain(): ProbeStats;
  /** Closes the surface (its queue then holds a closed reset for the next drain). Idempotent. */
  close(): void;
}

export interface TouchProbeModule extends NativeModule {
  /** A new probe: a surface with touch input enabled, closed on runtime teardown. */
  create(): Probe;
}
