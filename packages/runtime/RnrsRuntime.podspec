# @rnrs/runtime iOS library: the RnrsRuntime lifecycle TurboModule (codegen spec in
# src/specs), the shared JSI adapter (cpp/) and the app's Rust modules. Applications add
# nothing: autolinking (use_native_modules!) adds this pod. At `pod install` it runs the Node-only
# `rnrs link` step, which checks the modules' prebuilt XCFrameworks and writes the module
# registry; the app target links each module's static library slice for the SDK being built.
# Only modules listed in the app's rustNativeApp.sourceBuild are compiled (cargo), by a script
# phase that exists only then. Changing modules or that list needs `pod install` again.
require "json"
require "open3"
require "pathname"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# The app's modules for this pod install: {"prebuilt", "source", "slices" => {sdk => [paths]}}.
rnrs_link_modules = lambda do |app_root, deployment_target|
  node = ENV["NODE_BINARY"].to_s.empty? ? "node" : ENV["NODE_BINARY"]
  cmd = [node, File.join(__dir__, "cli/run.mjs"), "link", "--target", "ios", "--app", app_root.to_s,
         "--out", app_root.join(".rnrs/ios").to_s, "--ios-deployment-target", deployment_target.to_s, "--json"]
  out, err, status = Open3.capture3(*cmd)
  raise Pod::Informative, "[rnrs] #{cmd.join(" ")} failed:\n#{err}#{out}" unless status.success?
  JSON.parse(out.lines.last)
end

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

  # PODS_ROOT is <app>/ios/Pods; the installation root is <app>/ios.
  app_root = Pod::Config.instance.installation_root.parent
  pods_root = Pod::Config.instance.installation_root.join("Pods")
  # Prebuilt slices must not need a newer iOS than this pod's (React Native's) minimum.
  linked = rnrs_link_modules.call(app_root, min_ios_version_supported)
  from_pods = ->(file) { "\"$(PODS_ROOT)/#{Pathname.new(file).relative_path_from(pods_root)}\"" }
  source_build = !linked["source"].empty?
  # The source bundle is built per SDK into <app>/.rnrs/ios/lib/$(PLATFORM_NAME)/.
  bundle_lib = source_build ? ' "$(PODS_ROOT)/../../.rnrs/ios/lib/$(PLATFORM_NAME)/librnrs_bundle.a"' : ""
  pod_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
    # .rnrs/ios holds the generated module registry (rnrs_registry.inc, from `rnrs link`).
    "HEADER_SEARCH_PATHS" => '"$(PODS_TARGET_SRCROOT)/cpp" "$(PODS_ROOT)/../../.rnrs/ios"',
  }
  # The source build writes the bundle outside declared outputs (cargo's target directory).
  pod_xcconfig["ENABLE_USER_SCRIPT_SANDBOXING"] = "NO" if source_build
  # Native test hooks (scope invalidation, forced GC, forced copy fallback, reload) are compiled
  # only for device test harnesses: RNRS_TEST_HOOKS=1 in the environment of `pod install`.
  if ENV["RNRS_TEST_HOOKS"] == "1"
    pod_xcconfig["GCC_PREPROCESSOR_DEFINITIONS"] = "$(inherited) RNRS_TEST_HOOKS=1"
  end
  s.pod_target_xcconfig = pod_xcconfig
  # Each prebuilt module's XCFramework slice for the SDK being built, plus the source bundle.
  s.user_target_xcconfig = {
    "OTHER_LDFLAGS[sdk=iphoneos*]" => "$(inherited) #{linked["slices"]["iphoneos"].map(&from_pods).join(" ")}#{bundle_lib}",
    "OTHER_LDFLAGS[sdk=iphonesimulator*]" => "$(inherited) #{linked["slices"]["iphonesimulator"].map(&from_pods).join(" ")}#{bundle_lib}",
  }

  if source_build
    s.script_phase = {
      :name => "[rnrs] Build the app's Rust modules from source",
      :execution_position => :before_compile,
      :script => 'bash "${PODS_TARGET_SRCROOT}/ios/build-rust-bundle.sh"',
      # cargo decides what is up to date.
      :always_out_of_date => "1",
    }
  end

  install_modules_dependencies(s)
end
