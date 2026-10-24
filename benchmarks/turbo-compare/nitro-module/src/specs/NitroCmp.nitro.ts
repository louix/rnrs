// Benchmark-only Nitro spec: the scalar and numeric-array methods of the comparison, as a pure
// C++ HybridObject (cpp/HybridNitroCmp.hpp). Generated bindings: nitrogen 0.37.1 (nitrogen/).
import type { HybridObject } from 'react-native-nitro-modules';

export interface NitroCmp extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  nop(): void;
  add(a: number, b: number): number;
  flip(b: boolean): boolean;
  /** Left-to-right sum, as the other implementations. */
  arrSum(xs: number[]): number;
}
