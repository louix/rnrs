# Source from the repository root inside `nix develop`: isolated Rust toolchain/caches.
export RUSTUP_HOME="$PWD/.generated/rustup"
export CARGO_HOME="$PWD/.generated/cargo"
export RUSTUP_TOOLCHAIN=1.90.0
