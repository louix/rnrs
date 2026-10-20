# rnr: React Native modules in TypeScript + Rust

Write a TypeScript spec and a Rust implementation. You get a module for Android, iOS and the browser, with no Swift, Kotlin, C++ or JSI code in your package or your app.

```ts
// xor.spec.ts
export interface XorModule extends NativeModule {
  xor(data: ArrayBuffer, key: number): ArrayBuffer;
}
```

```rust
// rust/src/lib.rs, implementing the generated trait
impl rnr_interface::XorModule for Module {
    fn xor(&self, mut data: Vec<u8>, key: f64) -> Result<Vec<u8>, String> { /* … */ }
}
```

```ts
// app
xorModule().xor(bytes.buffer, 7);
```

**Experimental, unpublished.** Packages are local tarballs. Only React Native 0.83.1 is tested. Functional tests: Pixel 2 XL (Android 11), Pixel 8a (GrapheneOS, Android 17; regression smokes), iPhone 12 Pro, headless Chromium. Benchmarks: Pixel 2 XL and iPhone 12 Pro only. Not for production.

- [Quickstart](docs/quickstart.md)
- [Status and limits](docs/status.md)
- [All docs](docs/README.md)
- [Maintainers / lab](docs/lab.md)
