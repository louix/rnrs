# Browser touch input fixture

Browser PointerEvents → `@rnrs/surface` canvas host → `rnrs_surface_touch` → the `touch.rs` queue,
consumed by the GPU-free `@rnrs/labs-touch-probe` (docs/surface.md, "Touch input (browser)").

From the worktree root, after `npm ci --ignore-scripts`, inside `nix develop .#web`:

```sh
source scripts/rust-env.sh   # worktree-local Rust 1.90.0 + wasm32-unknown-unknown
node fixtures/web-touch/build.mjs --test   # RNRS_OFFLINE=0 on a cold cargo cache
```

`driver.mjs` runs in `scripts/web-test.mjs` (`RNRS_WEB_DRIVER`) and turns the page's requests into
CDP `Input.dispatchMouseEvent` / `Input.dispatchTouchEvent`. Those are trusted, browser-generated
PointerEvents in headless Chromium (`--disable-gpu`), not hardware input.

Checks named SYNTHETIC dispatch events from JS (`pointercancel`, `lostpointercapture`,
`pagehide`/`pageshow`, the `preventDefault` probes). No timing is measured.

## Checks

All runs used the worktree-local toolchain (`scripts/rust-env.sh`, Rust 1.90.0).

| Check | Result |
| --- | --- |
| This fixture | 12/12 |
| `fixtures/web-surface` | 22/22 |
| `fixtures/web-surface-host-tests` | 26/26 |
| `cargo test -p rnrs-surface` | 37 pass |
| `cargo test -p touch-probe` | 4 pass |
| `tsc --noEmit` | clean |
| `npm test` | 212/212 |

`npm test` first failed 4 tests: they could not download `cc 1.8.0` and `futures-channel 0.3.34`
under `--offline`, because the cargo home was empty. `cargo fetch --locked` into the isolated
`.generated/cargo` fixed it. No lock or dependency changed.
