// Compiles the Apple unified-logging writer (src/apple_log.c) for iOS and macOS targets only.
fn main() {
    println!("cargo:rerun-if-changed=src/apple_log.c");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os == "ios" || os == "macos" {
        cc::Build::new().file("src/apple_log.c").flag("-fblocks").compile("rnr_log_apple");
    }
}
