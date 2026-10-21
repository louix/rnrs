// @rnrs/surface: a React Native view that hosts a Rust renderer's output.
//
// A renderer module (for example @rnrs/example-vello2d) creates the surface in Rust and returns its
// opaque key; pass it as `surfaceKey`. The view attaches its platform window to that surface
// whenever the window exists, so mounting, unmounting, resizing and backgrounding the view
// never invalidate the renderer, and the renderer never outlives a window it draws to.
//
// Composition (Android, SurfaceView): the content is a separate compositor layer behind the
// app window, shown through a transparent hole. React Native views drawn above it (siblings
// later in the tree, absolutely positioned overlays) composite normally. View opacity,
// transforms and rounded-corner clipping of the surface or its ancestors are not applied to
// its content, and two overlapping surfaces have an undefined order. See docs/surface.md.
import React from 'react';
import { Platform, type ViewProps } from 'react-native';
import NativeRnrsSurfaceView from './specs/RnrsSurfaceViewNativeComponent';

export type SurfaceTouchInput = 'none' | 'rust';

export interface SurfaceViewProps extends ViewProps {
  /** From the renderer (e.g. `renderer.surfaceKey()`); 0 or undefined attaches nothing. */
  surfaceKey: number | undefined;
  /**
   * `"rust"`: deliver touches on this view to the renderer's Rust surface, on the UI thread,
   * never through JS (Android and iOS; the renderer must also enable input). Default `"none"`:
   * the view consumes no touches. The view takes a gesture (on iOS: a touch) only when its down
   * is accepted, then keeps it to the end; it never stops parents from intercepting (a parent scroll view
   * that takes the gesture cancels it in Rust). JS still receives touch events on this view as
   * usual. Interplay with RN responders, scroll views and gesture handlers is untested except
   * for overlays above the surface (docs/surface.md, "Touch input").
   *
   * The browser wrapper (index.web.tsx) has its own rules; any other platform delivers nothing
   * for `"rust"` and warns once.
   */
  touchInput?: SurfaceTouchInput;
}

let warnedUnsupported = false;

export function SurfaceView({
  surfaceKey,
  touchInput = 'none',
  ...rest
}: SurfaceViewProps): React.ReactElement {
  const supported = Platform.OS === 'android' || Platform.OS === 'ios';
  if (touchInput === 'rust' && !supported && !warnedUnsupported) {
    warnedUnsupported = true;
    console.warn(
      `@rnrs/surface: touchInput="rust" is not supported on ${Platform.OS}; no touches reach Rust`,
    );
  }
  const nativeTouchInput = supported ? touchInput : 'none';
  return React.createElement(NativeRnrsSurfaceView, {
    ...rest,
    surfaceKey: surfaceKey ?? 0,
    touchInput: nativeTouchInput,
  });
}
