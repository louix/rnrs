//! Called from the `build.rs` of crates that compile generated glue (platform bundles and
//! glue tests). Runs `tools/rnr-gen build-outputs`, which writes this bundle's Rust glue into
//! the crate's own `OUT_DIR` (so parallel build scripts never share output, and deleting
//! `.generated/` cannot leave the build without glue), checks that the crate depends on
//! exactly the module crates targeting `target`, and fails if a committed interface is stale.
//! The glue directory is exposed as `RNR_GEN_DIR`.
use std::path::{Path, PathBuf};
use std::process::Command;

/// `target`: "android" or "web" (the bundle whose module list this crate compiles).
pub fn generate(target: &str) {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let root = find_root(&manifest);
    let node = std::env::var("RNR_NODE").unwrap_or_else(|_| "node".into());
    println!("cargo:rerun-if-env-changed=RNR_NODE");
    println!("cargo:rerun-if-changed={}", manifest.join("Cargo.toml").display());
    let output = Command::new(&node)
        .arg(root.join("tools/rnr-gen/cli.mjs"))
        .args(["build-outputs", "--target", target, "--out"])
        .arg(&out)
        .arg("--manifest")
        .arg(manifest.join("Cargo.toml"))
        .current_dir(&root)
        .output()
        .unwrap_or_else(|e| panic!("rnrs-build: cannot run `{node}` ({e}); install Node.js and run `npm ci`, or set RNR_NODE"));
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        panic!("rnrs-build: tools/rnr-gen failed:\n{}{}", stdout, String::from_utf8_lossy(&output.stderr));
    }
    for line in stdout.lines() {
        if let Some(dep) = line.strip_prefix("rnr-gen-dep: ") {
            println!("cargo:rerun-if-changed={dep}");
        }
    }
    println!("cargo:rustc-env=RNR_GEN_DIR={}", out.join("rnr").display());
}

fn find_root(start: &Path) -> PathBuf {
    let mut dir = start.to_path_buf();
    loop {
        if dir.join("tools/rnr-gen/cli.mjs").exists() {
            return dir;
        }
        if !dir.pop() {
            panic!("rnrs-build: tools/rnr-gen not found above {}", start.display());
        }
    }
}
