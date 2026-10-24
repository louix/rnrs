require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# Benchmark-only pure C++ TurboModule (benchmarks/turbo-compare). install_modules_dependencies adds
# React Native's TurboModule dependencies and the app's ReactCodegen output (RnrsCmpCxxSpecJSI.h).
Pod::Spec.new do |s|
  s.name         = "RnrsCmpCxx"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.license      = package["license"]
  s.homepage     = "https://github.com/louix/rnrs"
  s.authors      = "rnrs"
  s.platforms    = { :ios => "15.1" }
  s.source       = { :git => "https://github.com/louix/rnrs.git" }
  s.source_files = "cpp/**/*.{h,cpp}", "ios/**/*.{h,mm}"
  s.pod_target_xcconfig = { "CLANG_CXX_LANGUAGE_STANDARD" => "c++20" }
  install_modules_dependencies(s)
end
