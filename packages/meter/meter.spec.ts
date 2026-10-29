// Native objects passed to and returned from Rust methods.
import type { NativeModule, NativeObject } from '@rnrs/runtime/spec';

/** A settable reading. */
export interface Gauge extends NativeObject {
  set(value: number): void;
  get(): number;
  isAbove(threshold: number): boolean;
  /** A new gauge holding the larger of the two readings. */
  maxWith(other: Gauge): Gauge;
}

export interface MeterModule extends NativeModule {
  hypot(a: number, b: number): number;
  isNegativeZero(x: number): boolean;
  /** Calls made on this module instance (state lives per runtime). */
  calls(): number;
  reset(): void;
  gauge(initial: number): Gauge;
  combine(a: Gauge, b: Gauge): Gauge;
  settleAfter(value: number, ms: number): Promise<number>;
  gaugeLater(initial: number, ms: number): Promise<Gauge>;
  /** Rejects for negative values. */
  checkLater(value: number): Promise<void>;
}
