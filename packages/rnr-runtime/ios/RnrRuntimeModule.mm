// Framework-supplied iOS lifecycle glue: the `RnrRuntime` TurboModule. One instance exists
// per React instance (RCTInstance), so per JS runtime, and it owns one RuntimeScope (shared
// C++ in ../cpp, the same as on Android).
//
// - installJSIBindingsWithRuntime:callInvoker: is called by RCTTurboModuleManager on the JS
//   thread the first time JS requires `RnrRuntime`; it binds `globalThis.__rnrRuntime` to
//   this instance's scope.
// - invalidate tears down every adapter of the scope without touching JSI. On React Native
//   0.83.1 (bridgeless) RCTInstance -invalidate runs it from a block on the JS thread:
//   RCTTurboModuleManager -invalidate dispatches it to this module's method queue and blocks
//   the JS thread until it returns (10 s timeout), before the ReactInstance (runtime
//   scheduler, then runtime) is destroyed on the JS thread. See docs/ios.md.
//
// Correctness does not depend on that ordering: the scope is shared, registration and
// invalidation linearize on its lock, and an installer that runs after invalidation finds
// no scope (or a scope that refuses registrations).
#import "RnrRuntimeModule.h"

#import <React/RCTInvalidating.h>
#import <React/RCTReloadCommand.h>
#import <ReactCommon/RCTTurboModuleWithJSIBindings.h>
#import <RnrRuntimeSpec/RnrRuntimeSpec.h>

#include <memory>
#include <mutex>
#include <cstring>

#include "RnrBindings.h"
#include "RnrPlatform.h"

using namespace facebook;

extern "C" bool rnr_set_app_data_dir(const uint8_t* ptr, size_t len);  // rust/rnr-android

@interface RnrRuntimeModule () <NativeRnrRuntimeSpec, RCTTurboModuleWithJSIBindings, RCTInvalidating>
@end

@implementation RnrRuntimeModule {
  std::mutex _mutex;
  // Reset (under _mutex) by the first -invalidate; the installer keeps its own reference.
  std::shared_ptr<rnr::RuntimeScope> _scope;
}

RCT_EXPORT_MODULE(RnrRuntime)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  if (self = [super init]) {
    _scope = std::make_shared<rnr::RuntimeScope>();
    [RnrRuntimeModule setAppDataDir];
  }
  return self;
}

// Modules that persist data get <Application Support>/rnr (app-private, backed up) through
// rnr_core::platform::app_data_dir(), before any module exists. Path only: nothing is created
// here, so if the directory cannot be created, the module that needs it gets that error when
// it asks, and the runtime itself still starts. Repeated calls with the same path are accepted.
+ (void)setAppDataDir
{
  NSString *base =
      NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
  if (!base) {
    rnr::platform::log(rnr::platform::LogLevel::Error, "application support directory unavailable; app data directory not set");
    return;
  }
  NSString *dir = [base stringByAppendingPathComponent:@"rnr"];
  const char *path = dir.fileSystemRepresentation;
  if (!rnr_set_app_data_dir(reinterpret_cast<const uint8_t *>(path), strlen(path))) {
    rnr::platform::log(
        rnr::platform::LogLevel::Error, "application data directory not set (already set to another path?): %s", path);
  }
}

- (NSString *)version
{
  return @"0.1.0";
}

- (void)installJSIBindingsWithRuntime:(jsi::Runtime &)runtime
                          callInvoker:(const std::shared_ptr<react::CallInvoker> &)callInvoker
{
  std::shared_ptr<rnr::RuntimeScope> scope;
  {
    std::lock_guard<std::mutex> lock(_mutex);
    scope = _scope;
  }
  if (!scope) {
    // Invalidated first: install nothing; JS then reports that the framework is unavailable.
    rnr::platform::log(rnr::platform::LogLevel::Error, "RnrRuntime was invalidated before its bindings were installed");
    return;
  }
  rnr::PlatformHooks hooks;
  hooks.platform = "ios";
#ifdef RNR_TEST_HOOKS
  hooks.reloadForTesting = [] {
    // React Native's own reload path. RCTTriggerReloadCommandListeners is process-wide: it
    // reloads every registered listener (every RCTHost in the process), not only the host of
    // this runtime. The test app has one host. Listeners expect the main thread; this only
    // enqueues.
    dispatch_async(dispatch_get_main_queue(), ^{
      RCTTriggerReloadCommandListeners(@"rnr reloadForTesting");
    });
  };
#endif
  rnr::installRuntimeBindings(runtime, callInvoker, scope, hooks);
}

- (void)invalidate
{
  std::shared_ptr<rnr::RuntimeScope> scope;
  {
    std::lock_guard<std::mutex> lock(_mutex);
    scope = std::move(_scope);
  }
  if (!scope) return;
  // jsThreadAlive: on iOS the JS thread is alive (blocked waiting for this hook, see above).
  auto r = scope->invalidate(true);
  if (!r.first) return;
  rnr::platform::log(rnr::platform::LogLevel::Info,
                     "runtime scope %llu invalidated on '%s' (JS thread '%s'): %llu adapter(s) torn down, %llu alive",
                     static_cast<unsigned long long>(scope->id()), r.thread.c_str(), r.jsThread.c_str(),
                     static_cast<unsigned long long>(r.tornDown), static_cast<unsigned long long>(r.alive));
}

- (std::shared_ptr<react::TurboModule>)getTurboModule:(const react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<react::NativeRnrRuntimeSpecJSI>(params);
}

@end
