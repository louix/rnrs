# @rnrs/runtime iOS library: the RnrsRuntime lifecycle TurboModule (codegen spec in
# src/specs), the shared JSI adapter (cpp/) and the app's generated Rust bundle. Applications
# add nothing: autolinking (use_native_modules!) adds this pod, and its script phase generates
# and builds the app's Rust bundle from the app's npm dependencies.
require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "RnrsRuntime"
  s.version      = package["version"]
  s.summary      = "Framework runtime for React Native modules written as TypeScript specs plus Rust"
  s.homepage     = "https://github.com/louix/rnrs"
  s.license      = package["license"]
  s.authors      = "louix"
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/louix/rnrs.git", :tag => "v#{s.version}" }

  s.source_files = "ios/*.{h,mm}", "cpp/*.{h,cpp}"
  s.private_header_files = "cpp/*.h"

  # The app's bundle is built per SDK (iphoneos, iphonesimulator) into <app>/.rnrs/ios/lib/;
  # PODS_ROOT is <app>/ios/Pods. The app target links it next to this static library.
  bundle_lib = '"$(PODS_ROOT)/../../.rnrs/ios/lib/$(PLATFORM_NAME)/librnrs_bundle.a"'
  pod_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
    "HEADER_SEARCH_PATHS" => '"$(PODS_TARGET_SRCROOT)/cpp"',
    # The script writes the bundle outside declared outputs (cargo's target directory).
    "ENABLE_USER_SCRIPT_SANDBOXING" => "NO",
  }
  # Native test hooks (scope invalidation, forced GC, forced copy fallback, reload) are compiled
  # only for device test harnesses: RNRS_TEST_HOOKS=1 in the environment of `pod install`.
  if ENV["RNRS_TEST_HOOKS"] == "1"
    pod_xcconfig["GCC_PREPROCESSOR_DEFINITIONS"] = "$(inherited) RNRS_TEST_HOOKS=1"
  end
  s.pod_target_xcconfig = pod_xcconfig
  s.user_target_xcconfig = { "OTHER_LDFLAGS" => "$(inherited) #{bundle_lib}" }

  s.script_phase = {
    :name => "[rnrs] Build the app's Rust bundle",
    :execution_position => :before_compile,
    :script => 'bash "${PODS_TARGET_SRCROOT}/ios/build-rust-bundle.sh"',
    # cargo decides what is up to date.
    :always_out_of_date => "1",
  }

  install_modules_dependencies(s)
end
