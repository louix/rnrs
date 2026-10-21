// Fabric component spec (React Native codegen). The native view is a SurfaceView whose window
// is attached to the Rust surface named by `surfaceKey` (an opaque number from a renderer;
// 0 means none). See packages/surface/src/index.ts.
import type { CodegenTypes, HostComponent, ViewProps } from 'react-native';
import { codegenNativeComponent } from 'react-native';

export interface NativeProps extends ViewProps {
  surfaceKey?: CodegenTypes.WithDefault<CodegenTypes.Double, 0>;
  /** "rust": Android and iOS deliver this view's touches to the Rust surface (opt-in; see index.ts). */
  touchInput?: CodegenTypes.WithDefault<'none' | 'rust', 'none'>;
}

export default codegenNativeComponent<NativeProps>('RnrsSurfaceView') as HostComponent<NativeProps>;
