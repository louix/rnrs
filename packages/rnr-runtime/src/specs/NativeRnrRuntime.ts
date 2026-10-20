// Codegen spec of the framework's lifecycle module. React Native's autolinking registers it
// from this spec; requiring it installs the JSI bindings (see android/), and React Native
// invalidates it when the runtime is reloaded or destroyed.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /** Framework version (diagnostics). */
  version(): string;
}

export default TurboModuleRegistry.get<Spec>('RnrRuntime');
