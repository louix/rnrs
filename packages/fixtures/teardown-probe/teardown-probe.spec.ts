// Lab fixture for the runtime-teardown hook (docs/surface.md, "Runtime teardown hook"):
// each tracked resource is registered with the adapter generation's TeardownScope and is
// retired when that generation is torn down, even while JS still holds it.
import type {NativeModule, NativeObject} from '@rnrs/runtime/spec';

export interface Tracked extends NativeObject {
  /** Whether teardown has retired this resource. */
  retired(): boolean;
}

export interface TeardownProbeModule extends NativeModule {
  /** A new resource registered with this generation's teardown scope. */
  track(): Tracked;
  /** Resources retired so far in this process (all generations). */
  retiredTotal(): number;
  /** Whether this module instance captured a teardown scope when it was created. */
  owned(): boolean;
}
