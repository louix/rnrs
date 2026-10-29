# Bevy example

`@rnrs/example-bevy3d` renders a rotating cube with [Bevy](https://bevy.org/).
Rust owns the scene and render loop; React Native supplies the layout and controls.

```tsx
import { useEffect, useState } from 'react';
import { SurfaceView } from '@rnrs/surface';
import { bevy3DModule, type Scene } from '@rnrs/example-bevy3d';

export function Cube() {
  const [scene, setScene] = useState<Scene | null>(null);

  useEffect(() => {
    const next = bevy3DModule().create();
    next.setColor(0.1, 0.6, 0.9);
    next.setSpeed(3);
    setScene(next);
    return () => {
      next.close();
      next.dispose();
    };
  }, []);

  return scene ? (
    <SurfaceView style={{ flex: 1 }} surfaceKey={scene.surfaceKey()} />
  ) : null;
}
```

Use `setPaused`, `setColor` and `setSpeed` to change the scene, and `stats()` to
read its state or `lastError`. Colours are sRGB components from 0 to 1; speed is
radians per second. On Android, add `touchInput="rust"` to enable dragging the cube.

Requires Rust 1.97.1 and Android API 26 or later. iOS and browser rendering are
experimental: the iOS simulator cannot render this scene, and Firefox can crash
when it unmounts. Browsers require WebGPU. The scene uses in-code assets; file
loading and window-dependent Bevy features such as picking are unsupported.

## How it works

- `create()` returns a `Native<Scene>` handle. Its `surfaceKey()` connects the Rust surface to `SurfaceView`; control methods update values read by the render loop.
- The adapter gives Bevy a wgpu device and an offscreen texture for its camera. Each update renders there, then a fullscreen blit presents the texture through an rnrs surface lease.
- Native builds run the loop on a Rust thread; browsers use the host's frame callback. The runtime teardown scope closes scenes on reload, and the render loop releases its resources.

See the [spec](bevy3d.spec.ts), [scene setup](rust/src/scene.rs) and
[surface adapter](rust/src/gpu.rs). Start with [rendering surfaces](../../docs/surface.md)
and the [quickstart](../../docs/quickstart.md) for setup.
