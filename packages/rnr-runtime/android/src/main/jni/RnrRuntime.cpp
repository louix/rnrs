#include "RnrRuntime.h"
#include "RnrBindings.h"
#include "RnrPlatform.h"
#include <ReactCommon/BindingsInstallerHolder.h>
#include <fbjni/fbjni.h>

using namespace facebook;

extern "C" bool rnr_set_app_data_dir(const uint8_t* ptr, size_t len);  // rust/rnrs-android

namespace rnr {

namespace {
#ifdef RNR_TEST_HOOKS
// Test hook: dev.rustjsilab.rnr.RnrTestHooks.reload() (enqueues ReactHost.reload).
struct JRnrTestHooks : jni::JavaClass<JRnrTestHooks> {
  static constexpr auto kJavaDescriptor = "Ldev/rustjsilab/rnr/RnrTestHooks;";
};

PlatformHooks androidHooks() {
  PlatformHooks hooks{.platform = "android"};
  hooks.reloadForTesting = [] {
    // Called on the JS thread (a JVM thread); only enqueues.
    jni::ThreadScope scope;
    JRnrTestHooks::javaClassStatic()->getStaticMethod<void()>("reload")(JRnrTestHooks::javaClassStatic());
  };
  return hooks;
}
#else
PlatformHooks androidHooks() { return PlatformHooks{.platform = "android"}; }
#endif

// Native part of dev.rustjsilab.rnr.RnrRuntimeScope. The framework owns the scope through
// this hybrid object: fbjni frees it when the Java object is collected, or the Kotlin owner
// resets it right after invalidation. The Kotlin owner serializes every call into it (and
// the reset) under one lock, so no call can race the native part's destruction.
class JRuntimeScope : public jni::HybridClass<JRuntimeScope> {
 public:
  static constexpr auto kJavaDescriptor = "Ldev/rustjsilab/rnr/RnrRuntimeScope;";

  static jni::local_ref<jhybriddata> initHybrid(jni::alias_ref<jhybridobject>) { return makeCxxInstance(); }

  jni::local_ref<react::BindingsInstallerHolder::javaobject> bindingsInstaller() {
    // The installer holds its own reference: it stays valid even if invalidation happens
    // before React Native calls it, and adapters it would create are then refused.
    return react::BindingsInstallerHolder::newObjectCxxArgs(
        [scope = scope_](jsi::Runtime& rt, const std::shared_ptr<react::CallInvoker>& invoker) {
          installRuntimeBindings(rt, invoker, scope, androidHooks());
        });
  }

  void invalidate(jboolean jsThreadAlive) {
    auto r = scope_->invalidate(jsThreadAlive);
    if (!r.first) return;
    platform::log(platform::LogLevel::Info,
                  "runtime scope %llu invalidated on '%s' (JS thread '%s' %s%s): %llu adapter(s) torn down, %llu alive",
                  static_cast<unsigned long long>(scope_->id()), r.thread.c_str(), r.jsThread.c_str(),
                  jsThreadAlive ? "alive" : "terminated", r.jsTaskLingering ? ", task entry lingering" : "",
                  static_cast<unsigned long long>(r.tornDown), static_cast<unsigned long long>(r.alive));
  }

  static void registerNatives() {
    registerHybrid({
        makeNativeMethod("initHybrid", JRuntimeScope::initHybrid),
        makeNativeMethod("bindingsInstallerNative", JRuntimeScope::bindingsInstaller),
        makeNativeMethod("invalidateNative", JRuntimeScope::invalidate),
    });
  }

 private:
  friend HybridBase;
  JRuntimeScope() = default;
  std::shared_ptr<RuntimeScope> scope_ = std::make_shared<RuntimeScope>();
};

// The application's private data directory for module implementations
// (rnrs_core::platform::app_data_dir), set by the Kotlin module before modules exist.
struct JRnrPlatform : jni::JavaClass<JRnrPlatform> {
  static constexpr auto kJavaDescriptor = "Ldev/rustjsilab/rnr/RnrPlatform;";
  static jboolean setAppDataDir(jni::alias_ref<jclass>, jni::alias_ref<jni::JString> path) {
    auto value = path->toStdString();
    return rnr_set_app_data_dir(reinterpret_cast<const uint8_t*>(value.data()), value.size());
  }
};

// Test hook: process-wide scope counters for the on-device ownership stress check.
struct JRnrScopeDiagnostics : jni::JavaClass<JRnrScopeDiagnostics> {
  static constexpr auto kJavaDescriptor = "Ldev/rustjsilab/rnr/RnrScopeDiagnostics;";
  static jni::local_ref<jni::JArrayLong> counters(jni::alias_ref<jclass>) {
    auto c = lifecycleCounters();
    auto out = jni::JArrayLong::newArray(3);
    jlong values[] = {static_cast<jlong>(c.scopesCreated), static_cast<jlong>(c.scopesDestroyed),
                      static_cast<jlong>(c.scopesInvalidated)};
    out->setRegion(0, 3, values);
    return out;
  }
};
}  // namespace

void registerRuntimeNatives() {
  JRuntimeScope::registerNatives();
#ifdef RNR_TEST_HOOKS
  JRnrTestHooks::javaClassStatic();  // resolved here, with the app class loader (JNI_OnLoad)
#endif
  JRnrScopeDiagnostics::javaClassStatic()->registerNatives({
      makeNativeMethod("counters", JRnrScopeDiagnostics::counters),
  });
  JRnrPlatform::javaClassStatic()->registerNatives({
      makeNativeMethod("setAppDataDir", JRnrPlatform::setAppDataDir),
  });
}

}  // namespace rnr
