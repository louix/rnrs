# @rnrs/surface

Rendering surfaces for [rnrs](https://github.com/louix/rnrs) modules: the `<SurfaceView>` React
component (a Fabric view on Android and iOS, a canvas in the browser) and the `rnrs-surface` Rust
crate that renderer modules draw through. Headless modules don't need it.

```sh
npm install @rnrs/surface @rnrs/runtime
```

Use the same version as `@rnrs/runtime`. React Native is an optional peer, so browser-only apps
don't install it.

**Experimental.** Tested with React Native 0.88.0; see
[rendering surfaces](https://github.com/louix/rnrs/blob/main/docs/surface.md) and the
[triangle tutorial](https://github.com/louix/rnrs/blob/main/docs/triangle.md).

MIT licensed.
