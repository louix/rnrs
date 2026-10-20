// Browser implementation selected by the package's browser export condition.
import React, {useEffect, useRef, useSyncExternalStore} from 'react';
import {View, type ViewProps} from 'react-native';
import {currentHost, serverHost, subscribeHost} from './browser/host-registry';

import type {CanvasMount, SurfaceTouchInput} from './browser/canvas-host';
export type {SurfaceTouchInput};
export interface SurfaceViewProps extends ViewProps {
  surfaceKey: number | undefined;
  /**
   * `"rust"`: pointer events on this view (touch, and the mouse's primary button) go to the
   * renderer's Rust surface on the browser main thread, never through JS module calls (the
   * renderer must also enable input). Only then does the view set `touch-action: none`,
   * capture accepted pointers and prevent the default of accepted downs. Default `"none"`:
   * no listeners, nothing consumed. docs/surface.md, "Touch input (browser)".
   */
  touchInput?: SurfaceTouchInput;
}
export function SurfaceView({surfaceKey, touchInput = 'none', children, ...rest}: SurfaceViewProps): React.ReactElement {
  const host = useSyncExternalStore(subscribeHost, currentHost, serverHost);
  const element = useRef<HTMLElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const mounted = useRef<CanvasMount | null>(null);
  const touch = useRef(touchInput);
  touch.current = touchInput;
  useEffect(() => {
    if (!host || currentHost() !== host || !element.current || !canvas.current || !surfaceKey) return;
    // A layout effect can replace the backend after this render captured its host.
    // mount() rolls back partial setup; keep genuine setup failures observable.
    try {
      const mount = host.mount(canvas.current, element.current, surfaceKey);
      mounted.current = mount;
      try { mount.setTouchInput(touch.current); }
      catch (error) { console.error('SurfaceView touch input failed', error); }
      return () => { mounted.current = null; mount.dispose(); };
    } catch (error) {
      canvas.current.width = 0; canvas.current.height = 0;
      console.error('SurfaceView mount failed', error);
    }
  }, [host, surfaceKey]);
  useEffect(() => {
    try { mounted.current?.setTouchInput(touchInput); }
    catch (error) { console.error('SurfaceView touch input failed', error); }
  }, [touchInput]);
  return React.createElement(View, rest,
    React.createElement(View, {
      ref: (node: unknown) => { element.current = node as HTMLElement | null; },
      style: {flex: 1, minWidth: 0, minHeight: 0, position: 'relative'},
    }, React.createElement('canvas', {
      // A canvas keeps its first context type (2d or webgpu): each surface key gets a new
      // element, so a key change between presentations never reuses one.
      key: surfaceKey ?? 0,
      ref: canvas, width: 0, height: 0,
      style: {position:'absolute', left:0, top:0, width:'100%', height:'100%', display:'block', pointerEvents:'none'},
    })),
    children);
}
