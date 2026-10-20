# @rnrs/surface iOS library: the <RnrSurfaceView> Fabric component view (a CAMetalLayer-backed
# content view attached to a Rust surface). Applications add nothing: autolinking adds this pod,
# codegen registers the component through codegenConfig.ios.componentProvider, and the
# rnr_surface_* entry points (RnrSurfaceRust.h) resolve against the app's Rust bundle
# (librnr_bundle.a, linked by the RnrRuntime pod). use_frameworks! is not supported.
require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "RnrSurface"
  s.version      = package["version"]
  s.summary      = "Framework rendering surface for React Native modules written in Rust (iOS view)"
  s.homepage     = "https://example.invalid/rnr"
  s.license      = package["license"]
  s.authors      = "rnr"
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://example.invalid/rnr.git", :tag => s.version.to_s }

  s.source_files = "ios/*.{h,mm}"
  s.private_header_files = "ios/RnrSurfaceRust.h"
  s.frameworks = "QuartzCore", "UIKit"
  s.pod_target_xcconfig = { "CLANG_CXX_LANGUAGE_STANDARD" => "c++20" }
  s.dependency "RnrRuntime"

  install_modules_dependencies(s)
end
