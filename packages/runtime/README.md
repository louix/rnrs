# @rnrs/runtime

The rnrs framework runtime: React Native modules written as a TypeScript spec plus a Rust crate,
for Android, iOS and the browser. It contains the JS runtime and spec types, the Android and iOS
native library (autolinked), the browser Wasm backend and the framework Rust crates (`rnrs`,
`rnrs-core`) that module crates depend on.

```sh
npm install @rnrs/runtime
```

The `rnrs` command comes with the matching `@rnrs/cli`, which this package depends on. Install
module packages next to the runtime; rendering apps also install `@rnrs/surface`. Keep all
`@rnrs/*` framework packages on the same version.

**Experimental.** Tested with React Native 0.88.0 (New Architecture, Hermes); later 0.88 patch
releases are accepted but not individually tested. See
[platform support](https://github.com/louix/rnrs/blob/main/docs/support.md) and the
[quickstart](https://github.com/louix/rnrs/blob/main/docs/quickstart.md).

MIT licensed.
