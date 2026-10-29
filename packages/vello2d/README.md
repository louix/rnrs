# 2D rendering example

`@rnrs/example-vello2d` draws shapes from TypeScript using Vello's CPU rasterizer.
Rust renders the latest frame into a surface on Android, iOS or the browser.

```tsx
import { useEffect, useState } from 'react';
import { SurfaceView } from '@rnrs/surface';
import { vello2DModule, type Renderer } from '@rnrs/example-vello2d';
import { FrameWriter } from '@rnrs/example-vello2d/frame';

export function Drawing() {
  const [renderer, setRenderer] = useState<Renderer | null>(null);

  useEffect(() => {
    const next = vello2DModule().create({ resolutionScale: 1 });
    const frame = new FrameWriter();
    frame.begin().clear([1, 1, 1, 1]).circle(60, 60, 30, [0, 0.5, 1, 1]);
    next.submit(frame.finish());
    setRenderer(next);
    return () => {
      next.close();
      next.dispose();
    };
  }, []);

  return renderer ? (
    <SurfaceView style={{ flex: 1 }} surfaceKey={renderer.surfaceKey()} />
  ) : null;
}
```

`FrameWriter` supports rectangles, rounded rectangles, circles and lines.
Coordinates use layout units; colours are sRGB RGBA components from 0 to 1.
Reuse the writer and submit a complete frame when your drawing changes. The latest
pending frame replaces the previous one.

`resolutionScale` ranges from 0.25 to 1. Lower values rasterize fewer pixels.
`stats()` reports renderer state and errors. Rendering surfaces are experimental;
see [platform support](../../docs/support.md).

## How it works

- `FrameWriter` encodes drawing commands into an `ArrayBuffer`. The generated binding copies it into a Rust `Vec<u8>`, so one `submit` call carries a complete frame.
- Rust decodes the commands and rasterizes them with `vello_cpu`. Native builds upload the pixels to a wgpu texture; browsers return them to the canvas host.
- `Native<Renderer>` keeps the renderer in Rust, while `surfaceKey()` connects it to `SurfaceView`. The runtime teardown scope closes renderers on reload.

Read the [spec](vello2d.spec.ts), [frame writer](frame.ts) and
[Rust implementation](rust/src/lib.rs), or start with the
[rendering tutorial](../../docs/triangle.md).
