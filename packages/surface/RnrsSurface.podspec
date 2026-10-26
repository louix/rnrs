# @rnrs/surface iOS library: the <RnrsSurfaceView> Fabric component view (a CAMetalLayer-backed
# content view attached to a Rust surface). Applications add nothing: autolinking adds this pod,
# codegen registers the component through codegenConfig.ios.componentProvider, and the
# rnrs_surface_* entry points (<RnrsRuntime/RnrsSurfaceEntry.h>) are the RnrsRuntime pod's,
# which forwards each to the module binary that owns the surface. use_frameworks! is not supported.
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
  s.frameworks = "QuartzCore", "UIKit"
  s.pod_target_xcconfig = { "CLANG_CXX_LANGUAGE_STANDARD" => "c++20" }
  s.dependency "RnrsRuntime"

  install_modules_dependencies(s)
end
