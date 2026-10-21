# @rnrs/cli

The `rnrs` command for [rnrs](https://github.com/louix/rnrs) modules: scaffold a module
(`rnrs init`), generate its Rust interface (`rnrs generate`, `rnrs check`), test it (`rnrs test`)
and build an app's Rust bundle (`rnrs build`, `rnrs lock`).

```sh
npm install --save-dev @rnrs/cli @rnrs/runtime
npx rnrs --help
```

It uses the framework spec and Rust crates of the `@rnrs/runtime` installed next to it; both
packages must have the same version. Apps get it through `@rnrs/runtime`.

**Experimental.** See the
[quickstart](https://github.com/louix/rnrs/blob/main/docs/quickstart.md).

MIT licensed.
