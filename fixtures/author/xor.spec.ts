// A module written outside the repository: only this spec, package.json and rust/.
import type {NativeModule} from '@rnrs/runtime/spec';

export interface XorModule extends NativeModule {
  /** Every byte of `data` XOR `key` (0 to 255). */
  xor(data: ArrayBuffer, key: number): ArrayBuffer;
  greet(name: string): string;
}
