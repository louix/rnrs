#pragma once
// Framework-supplied runtime bindings, shared by the Android and iOS lifecycle modules:
// `globalThis.__rnrRuntime` for one runtime scope (see docs/prototype.md).
#include <ReactCommon/CallInvoker.h>
#include <jsi/jsi.h>
#include <functional>
#include <memory>
#include "RnrScope.h"

namespace rnr {

struct PlatformHooks {
  // Platform name reported to JS (diagnostics).
  const char* platform = "";
  // Test hook (installed only with RNR_TEST_HOOKS, and only where the platform supplies it):
  // asks React Native to reload through its own reload path (iOS:
  // RCTTriggerReloadCommandListeners, which reloads every registered host in the process),
  // because release builds have no JS-reachable reload. Called on the JS thread; must only
  // enqueue.
  std::function<void()> reloadForTesting;
};

// Installs globalThis.__rnrRuntime for this runtime (JS thread).
void installRuntimeBindings(
    facebook::jsi::Runtime& rt, const std::shared_ptr<facebook::react::CallInvoker>& invoker,
    const std::shared_ptr<RuntimeScope>& scope, const PlatformHooks& hooks);

// Process-wide lifecycle diagnostics, written into `out` as properties.
void writeLifecycleStats(facebook::jsi::Runtime& rt, facebook::jsi::Object& out);

}  // namespace rnr
