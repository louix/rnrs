# @rnrs/surface iOS library: the <RnrsSurfaceView> Fabric component view (a CAMetalLayer-backed
# content view attached to a Rust surface). Applications add nothing: autolinking adds this pod,
# codegen registers the component through codegenConfig.ios.componentProvider, and the
# rnrs_surface_* entry points (RnrsSurfaceRust.h) resolve against the app's Rust bundle
# (librnrs_bundle.a, linked by the RnrsRuntime pod). use_frameworks! is not supported.
require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "RnrsSurface"
  s.version      = package["version"]
  s.summary      = "Framework rendering surface for React Native modules written in Rust (iOS view)"
  s.homepage     = "https://github.com/louix/rnrs"
  s.license      = package["license"]
  s.authors      = "louix"
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/louix/rnrs.git", :tag => "v#{s.version}" }

  s.source_files = "ios/*.{h,mm}"
  s.private_header_files = "ios/RnrsSurfaceRust.h"
  s.frameworks = "QuartzCore", "UIKit"
  s.pod_target_xcconfig = { "CLANG_CXX_LANGUAGE_STANDARD" => "c++20" }
  s.dependency "RnrsRuntime"

  install_modules_dependencies(s)
end
