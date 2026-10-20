// Probe-only extraction: compile the actual existing draw implementation without
// importing its native wgpu/thread dependencies or editing shared source.
use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rustc-check-cfg=cfg(probe_cpu_extracted)");
    println!("cargo:rerun-if-env-changed=RNR_PROBE_CPU_SOURCE");
    if let Some(path) = env::var_os("RNR_PROBE_CPU_SOURCE") {
        let path = PathBuf::from(path);
        println!("cargo:rerun-if-changed={}", path.display());
        let source = fs::read_to_string(path).expect("read extracted CPU module");
        // include! cannot introduce an inner module doc comment.
        let source = source.lines().map(|line| line.strip_prefix("//!").map_or_else(
            || line.to_owned(), |doc| format!("//{doc}"))).collect::<Vec<_>>().join("\n");
        fs::write(PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("draw.rs"), source)
            .expect("write extracted CPU probe module");
        println!("cargo:rustc-cfg=probe_cpu_extracted");
        return;
    }
    let source = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../../packages/vello2d/rust/src/gpu.rs");
    println!("cargo:rerun-if-changed={}", source.display());
    let text = fs::read_to_string(source).expect("read shared raster source");
    let start = text.find("fn color(c: Rgba)").expect("color marker changed");
    let end = text[start..].find("impl Presenter for WgpuPresenter").expect("presenter marker changed") + start;
    let imports = "use crate::frame::{Cmd, Rgba};\nuse vello_cpu::color::{AlphaColor, Srgb};\nuse vello_cpu::kurbo::{Affine, Circle, Line, Rect, RoundedRect, Shape, Stroke};\nuse vello_cpu::RenderContext;\n";
    fs::write(PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("draw.rs"),
        format!("{imports}{}", &text[start..end])).expect("write probe-only draw module");
}
