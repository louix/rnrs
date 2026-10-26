# rnrs: React Native Rust Modules

Rust-powered native modules: write a TypeScript spec and a Rust implementation. Use the same
module on Android, iOS and in the browser.

No Swift, Kotlin, C++ or JSI code to write in your package or app. Supports records, tagged
unions, arrays, buffers, async methods and persistent Rust objects. See the [type map](docs/types.md).

**1. Write a spec:**

```ts
// math.spec.ts
import type { NativeModule } from '@rnrs/runtime/spec';

export interface MathModule extends NativeModule {
  sum(values: number[]): number;
}
```

**2. Implement it in Rust:**

```rust
// rust/src/lib.rs
pub mod rnrs_interface;

#[derive(Default)]
pub struct Module;

impl rnrs_interface::MathModule for Module {
    fn sum(&self, values: Vec<f64>) -> Result<f64, String> {
        Ok(values.into_iter().sum())
    }
}
```

**3. Use it:**

```ts
import { mathModule } from '@demo/math';

mathModule().sum([1, 2, 3]); // 6
```

The CLI generates the bindings; the [quickstart](docs/quickstart.md) covers setup and builds.

# Comparisions

Compared with [uniffi-bindgen-react-native](https://jhugman.github.io/uniffi-bindgen-react-native/)
(0.31.0-6, both classi JSI and newer  JSI2 backends), rnrs (0.3.0) measures **>20× faster scalar addition**
and **~7× faster array sums (1024 numbers)**, in addition to being much easier to setup.

Experimental Fabric surface integration lets Rust draw inside React Native:

- Embed a renderer or game and use React Native for its UI; see the [Bevy example](packages/bevy3d/README.md).
- Send input from Worklets and Reanimated to Rust.

See [platform support](docs/support.md) for rendering and Worklets availability.

- [Quickstart](docs/quickstart.md)
- [Headless module tutorial](docs/headless.md) and [triangle tutorial](docs/triangle.md)
- [Type map](docs/types.md)
- [All docs](docs/README.md)
