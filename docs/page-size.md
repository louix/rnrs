# Android 16 KB page alignment

The runtime's Android CMake target links `librnr.so` with `-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384`. These flags apply to the Android shared library, including the Rust bundle; they do not apply to iOS.

## The gate: `scripts/check-page-size.mjs <apk> [abi] [out.json]`

The script extracts the libraries of one ABI from the APK itself and records each library's full `LOAD` / `GNU_RELRO` segment table. It then checks:

1. **LOAD:** `p_align ≥ 16384` and `p_offset ≡ p_vaddr (mod 16384)`.
2. **RELRO hazard.** The loader write-protects RELRO rounded out to whole pages (start rounded down, end rounded up). With 16 KB pages, writable bytes of any `LOAD` segment that are not RELRO but share such a page would become read-only. That overlap is the violation. An unaligned RELRO end on its own is reported but is not a violation.
3. **APK ZIP:** stored libraries' data at 16 KB offsets, and `zipalign -c -P 16 4`.

**Exit status:** 0 when everything passes, 1 on any violation, and 2 when it cannot validate (a tool or the SDK is missing, or the file is not an APK or has no libraries for the ABI). Tools come from `RNR_LLVM_READELF` / `RNR_ZIPALIGN`, then `ANDROID_HOME` / `ANDROID_SDK_ROOT` (newest NDK and build-tools), then `PATH`. Unit tests are in `scripts/check-page-size.test.mjs`.


Runtime validation has used 4 KB-page devices only. Passing the artifact gate does not establish runtime compatibility with a 16 KB-page device or emulator.
