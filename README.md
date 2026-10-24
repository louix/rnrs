# rnrs: React Native modules in TypeScript + Rust

Write a TypeScript spec and a Rust implementation. You get a module for Android, iOS and the browser, with no Swift, Kotlin, C++ or JSI code in your package or your app.

```ts
// xor.spec.ts
export interface XorModule extends NativeModule {
  xor(data: ArrayBuffer, key: number): ArrayBuffer;
}
```

```rust
// rust/src/lib.rs, implementing the generated trait
impl rnrs_interface::XorModule for Module {
    fn xor(&self, mut data: Vec<u8>, key: f64) -> Result<Vec<u8>, String> { /* … */ }
}
```

```ts
// app
xorModule().xor(bytes.buffer, 7);
```

Headless modules support Android, iOS and web. Fabric surface integration is experimental; see [platform support](docs/support.md).

- [Quickstart](docs/quickstart.md)
- [Headless module tutorial](docs/headless.md) and [triangle tutorial](docs/triangle.md)
- [All docs](docs/README.md)
