# Quickstart

A module is a TypeScript spec plus a Rust crate that implements the trait generated from it. One
package can target Android, iOS and the browser; which of them it supports depends on its Rust
dependencies and the targets it declares.

1. **[Set up](setup.md)** Node, Rust and the platform tools, and see how apps install and build modules.
2. **[Build a headless module](headless.md)**: create a package with `rnrs init`, implement native objects in Rust, test and pack it, then use it from React Native and the browser.
3. **[Draw a triangle](triangle.md)**: render with wgpu from Rust into a React component.

Every module follows the same loop. Scaffold once in a new directory that has only a minimal
`package.json`, as in the [headless guide](headless.md#create-the-module):

```sh
npm exec --package=@rnrs/cli -- rnrs init   # once: writes the package, spec and crate
npm install                                 # installs @rnrs/cli and @rnrs/runtime locally
npx rnrs test                               # generate the Rust interface, run cargo test
npx rnrs check                              # interface current, package usable by apps
npm pack                                    # archive for apps to install
```

Reference: [type map](types.md), [runtime rules](ownership.md#rules),
[platform support](support.md).
