// Fabric component spec (React Native codegen). The native view is a SurfaceView whose window
// is attached to the Rust surface named by `surfaceKey` (an opaque number from a renderer;
// 0 means none). See packages/rnr-surface/src/index.ts.
import type { HostComponent, ViewProps } from 'react-native';
import type { Double, WithDefault } from 'react-native/Libraries/Types/CodegenTypes';
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';

export interface NativeProps extends ViewProps {
  surfaceKey?: WithDefault<Double, 0>;
  /** "rust": Android and iOS deliver this view's touches to the Rust surface (opt-in; see index.ts). */
  touchInput?: WithDefault<'none' | 'rust', 'none'>;
}

export default codegenNativeComponent<NativeProps>('RnrSurfaceView') as HostComponent<NativeProps>;
