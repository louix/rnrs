import { NitroModules } from 'react-native-nitro-modules';
import type { NitroCmp } from './specs/NitroCmp.nitro';

export type { NitroCmp };

/** A new NitroCmp HybridObject (the comparison creates one and captures it). */
export function createNitroCmp(): NitroCmp {
  return NitroModules.createHybridObject<NitroCmp>('NitroCmp');
}
