// Types of the browser page (informational): the shared Case/Fixtures and the four web receivers.
import type { Case, CmpApi, Fixtures } from '../app/types';

export type { Case, Fixtures };
export type Ops = Pick<CmpApi, 'nop' | 'add' | 'flip' | 'arrSum'>;

export interface Receivers {
  /** The rnrs benchmark module on the rnrs Wasm backend. */
  rnrs: Ops;
  /** Plain JS with the same strict type checks. */
  js: Ops;
  /** The minimal direct wasm-bindgen crate (web/direct), no strict validation. */
  wasm: Ops;
  /** The direct crate behind thin JS checks matching the other paths' strict contract. */
  wasmChecked: Ops;
}
