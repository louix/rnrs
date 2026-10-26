{
  description = "React Native / Rust Android, iOS and web lab";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }: let
    linux = [ "x86_64-linux" ];
    darwin = [ "aarch64-darwin" "x86_64-darwin" ];
  in { devShells = nixpkgs.lib.genAttrs linux (system: let
    pkgs = import nixpkgs {
      inherit system;
      config = { allowUnfree = true; android_sdk.accept_license = true; };
      overlays = [ (final: prev: {
        jdk17 = prev.temurin-bin-17;
        jdk_headless = prev.temurin-bin-17;
      }) ];
    };
    android = pkgs.androidenv.composeAndroidPackages {
      toolsVersion = null;
      platformVersions = [ "37.0" ];
      buildToolsVersions = [ "37.0.0" ];
      includeNDK = true;
      ndkVersions = [ "27.1.12297006" ];
      cmakeVersions = [ "3.22.1" ];
      includeEmulator = false;
      includeSystemImages = false;
    };
  in { default = pkgs.mkShell {
    packages = with pkgs; [ nodejs_24 rustup clang cmake pkg-config jdk17 android-tools curl unzip python3 android.androidsdk ];
    ANDROID_HOME = "${android.androidsdk}/libexec/android-sdk";
    ANDROID_SDK_ROOT = "${android.androidsdk}/libexec/android-sdk";
    # Override host/CI NDK variables as well as the SDK: build-native prefers these.
    ANDROID_NDK_HOME = "${android.androidsdk}/libexec/android-sdk/ndk/27.1.12297006";
    ANDROID_NDK_ROOT = "${android.androidsdk}/libexec/android-sdk/ndk/27.1.12297006";
    JAVA_HOME = "${pkgs.jdk17}";
    GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${android.androidsdk}/libexec/android-sdk/build-tools/37.0.0/aapt2";
  };
  # Host-only checks (CI): Rust workspace tests and the framework C++ tests, no Android SDK.
  host = pkgs.mkShell {
    packages = with pkgs; [ nodejs_24 rustup clang cmake pkg-config python3 ];
  };
  # Browser Wasm prototype: wasm-bindgen CLI must match the crate pin (=0.2.129).
  web = pkgs.mkShell {
    packages = with pkgs; [ nodejs_24 rustup wasm-bindgen-cli esbuild chromium ];
  }; }) // nixpkgs.lib.genAttrs darwin (system: let
    pkgs = import nixpkgs { inherit system; };
  in {
    # iOS (`nix develop .#ios` on a Mac): Node, rustup and CocoaPods come from nixpkgs. Xcode
    # (clang, the iOS SDKs, xcodebuild, devicectl) is not packaged and comes from the system's
    # selected Xcode; no nixpkgs compiler or SDK is put in the environment.
    ios = pkgs.mkShellNoCC {
      packages = with pkgs; [ nodejs_24 rustup cocoapods ];
      shellHook = ''
        unset DEVELOPER_DIR SDKROOT NIX_CFLAGS_COMPILE NIX_LDFLAGS
      '';
    };
  }); };
}
