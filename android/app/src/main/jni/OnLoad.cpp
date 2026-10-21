// Adapted from React Native's MIT-licensed default-app-setup/OnLoad.cpp.
#include <DefaultComponentsRegistry.h>
#include <DefaultTurboModuleManagerDelegate.h>
#include <FBReactNativeSpec.h>
#include <autolinking.h>
#include <fbjni/fbjni.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include "Bench.h"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, [] {
    using namespace facebook::react;
    DefaultTurboModuleManagerDelegate::cxxModuleProvider =
      [](const std::string& name, const std::shared_ptr<CallInvoker>& invoker) -> std::shared_ptr<TurboModule> {
        if (name == "NativeBench") return std::make_shared<Bench>(invoker);
        return autolinking_cxxModuleProvider(name, invoker);
      };
    DefaultTurboModuleManagerDelegate::javaModuleProvider =
      [](const std::string& name, const JavaTurboModule::InitParams& params) -> std::shared_ptr<TurboModule> {
        if (auto module = FBReactNativeSpec_ModuleProvider(name, params)) return module;
        return autolinking_ModuleProvider(name, params);  // includes the autolinked RnrsRuntime module
      };
    DefaultComponentsRegistry::registerComponentDescriptorsFromEntryPoint =
      [](std::shared_ptr<const ComponentDescriptorProviderRegistry> registry) {
        autolinking_registerProviders(registry);
      };
  });
}
