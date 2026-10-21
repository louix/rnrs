# Draw a triangle

This module draws an orange triangle on black using the same Rust code on Android,
iOS and browser WebGPU. rnrs owns the surface and render loop; you supply the shader,
pipeline and draw commands. Start with the [quickstart's tools](quickstart.md#0-tools).

## Create the module

In a new directory:

```sh
echo '{"name":"@demo/triangle","private":true}' > package.json
npm exec --package=@rnrs/cli -- rnrs init
npm install
npm install --save-dev @rnrs/surface
```

For a local framework checkout, substitute the matching package archives as described
in [local package testing](lab.md#local-package-testing), including the surface package.
Keep its version aligned with the runtime. In `rust/Cargo.toml`, enable the GPU feature
on the existing dependency:

```toml
rnrs = { version = "0.1", features = ["wgpu"] }
```

Use rnrs's re-export of wgpu, so the renderer uses the adapter's version.
Replace `triangle.spec.ts` with:

```ts
import type { NativeModule, NativeObject } from '@rnrs/runtime/spec';

export interface Triangle extends NativeObject {
  surfaceKey(): number;
  close(): void;
}

export interface TriangleModule extends NativeModule {
  create(): Triangle;
}
```

## Implement the renderer

Replace `rust/src/lib.rs` with:

```rust
use rnrs::gpu::{self, wgpu, Frame, Gpu, GpuSurface, Next, Options, TargetInfo};
use rnrs::{Native, TeardownScope};

pub mod rnr_interface;
use rnr_interface as spec;

const SHADER: &str = r#"
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    var p = array<vec2<f32>, 3>(vec2(0.0, 0.6), vec2(-0.6, -0.6), vec2(0.6, -0.6));
    return vec4<f32>(p[i], 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.5, 0.0, 1.0); }
"#;

struct Draw;

impl gpu::Renderer for Draw {
    type State = wgpu::Color;
    type Resources = wgpu::RenderPipeline;

    fn create(&mut self, gpu: &Gpu, target: &TargetInfo) -> Result<wgpu::RenderPipeline, String> {
        let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("triangle"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
        Ok(gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("triangle"),
            layout: None,
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), compilation_options: Default::default(), targets: &[Some(target.format.into())] }),
            multiview_mask: None,
            cache: None,
        }))
    }

    fn draw(&mut self, pipeline: &mut wgpu::RenderPipeline, frame: &mut Frame<'_>, background: &wgpu::Color) -> Result<Next, String> {
        let mut pass = frame.encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("triangle"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: frame.view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(*background), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        pass.draw(0..3, 0..1);
        drop(pass);
        Ok(Next::Wait)
    }
}

pub struct Module {
    scope: Option<TeardownScope>,
}

impl Default for Module {
    fn default() -> Self {
        Self { scope: TeardownScope::current() }
    }
}

impl spec::TriangleModule for Module {
    type TriangleImpl = Triangle;

    fn create(&self) -> Result<Native<Triangle>, String> {
        let scope = self.scope.as_ref().ok_or("module has no runtime scope")?;
        let surface = GpuSurface::spawn(
            scope, Options::default(), wgpu::Color::BLACK, || Draw,
        )?;
        Ok(Native::new(Triangle(surface)))
    }
}

pub struct Triangle(GpuSurface<Draw>);

impl spec::Triangle for Triangle {
    fn surface_key(&self) -> Result<f64, String> {
        Ok(self.0.key() as f64)
    }

    fn close(&self) -> Result<(), String> {
        self.0.close();
        Ok(())
    }
}
```

The framework calls `Module::default()` while its runtime's `TeardownScope` is current.
Capture it there and retain it in the module. Later method calls use that saved scope;
do not create an unrelated scope or expect `current()` to be set during every call.
Registration inside `GpuSurface::spawn` makes runtime teardown close the renderer even
if other references survive. Tests constructing a module outside the runtime must
supply a scope explicitly.

`Resources` belongs to one attachment. Build the pipeline for `target.format`, which
can differ across backends. Record commands into `frame.encoder` using `frame.view`;
rnrs submits and presents them. Do not retain frame objects. `Next::Wait` draws again
on attachment, resize or state change; use `Next::Animate` for continuous drawing.
This shader needs no size-dependent resources, so the default `resized` hook suffices.

```sh
npx rnrs test
npx rnrs check
npm pack
```

## Mount it in React

The app installs `@rnrs/runtime`, `@rnrs/surface` and your module as direct dependencies.
Use this component on native or web:

```tsx
import React, { useEffect, useState } from 'react';
import { SurfaceView } from '@rnrs/surface';
import { triangleModule } from '@demo/triangle';

export function TriangleView() {
  const [surfaceKey, setSurfaceKey] = useState<number | null>(null);
  useEffect(() => {
    const value = triangleModule().create();
    setSurfaceKey(value.surfaceKey());
    return () => {
      value.close();
      value.dispose();
    };
  }, []);

  return surfaceKey !== null && (
    <SurfaceView
      surfaceKey={surfaceKey}
      style={{ width: 400, height: 300 }}
    />
  );
}
```

Create native objects in an effect, not during React rendering. The cleanup closes the
renderer and releases its JS-owned handle. Unmounting a view alone detaches it but does
not dispose the native object. Give the view a nonzero size.

Android and iOS builds use the [normal native setup](quickstart.md#4-use-it-in-an-app).

## Browser initialization

Use a React web app with `react-dom` and `react-native-web`. Configure the bundler to
resolve `react-native` to `react-native-web`; for Vite:

```ts
import { defineConfig } from 'vite';
export default defineConfig({
  resolve: { alias: { 'react-native': 'react-native-web' } },
});
```

In your `main.tsx`, initialize the surface backend before mounting React:

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { initRnr } from '@rnrs/runtime/web';
import { createSurfaceBootstrap } from '@rnrs/surface/browser';
import * as bundle from './.rnr/web/pkg/rnr_bundle.js';
import { TriangleView } from './TriangleView';

initRnr(bundle, undefined, { bootstrap: createSurfaceBootstrap }).then(() => {
  createRoot(document.getElementById('root')!).render(<TriangleView />);
}).catch(console.error);
```

Your HTML needs `<div id="root"></div>` and a module script loading `main.tsx`.
Build the Rust bundle before the web app:

```sh
npx rnrs build --target web --app .
npx vite build
npx vite preview
```

WebGPU requires a secure context (HTTPS or localhost), a browser with WebGPU enabled,
and an available adapter. There is no automatic Canvas 2D fallback. A successful build
or GPU submission does not prove visible output: open the page and check the triangle,
then unmount and remount it. See [surface lifecycle and failure rules](surface.md#the-wgpu-adapter-rnrsgpu).
