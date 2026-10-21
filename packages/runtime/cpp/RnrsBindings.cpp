#include "RnrsBindings.h"
#include "RnrsDelivery.h"
#include "RnrsJsi.h"
#include "RnrsRuntimeIdentityJsi.h"
#include "RnrsWorklets.h"
#include <jsi/instrumentation.h>

#ifdef RNRS_TEST_HOOKS
#include <cstdio>
#include <mutex>
#include <vector>
#endif

using namespace facebook;

namespace rnrs {

#ifdef RNRS_TEST_HOOKS
namespace {
// Calls of the routing probe, process-wide (the first 64 are kept).
struct RouteRecord {
  uint64_t seq = 0;
  const void* callRuntime = nullptr;
  const void* installRuntime = nullptr;
  uint64_t callIdentity = 0, installIdentity = 0;
  bool accepted = false, onInstallJsThread = false, argIsNumber = false;
  size_t argCount = 0;
  platform::ThreadId thread = 0;
  std::string threadName;
};
std::mutex gRoutesMutex;
std::vector<RouteRecord> gRoutes;
uint64_t gRouteSeq = 0;

uint64_t recordRoute(RouteRecord r) {
  std::lock_guard<std::mutex> lock(gRoutesMutex);
  r.seq = ++gRouteSeq;
  if (gRoutes.size() < 64) gRoutes.push_back(std::move(r));
  return gRouteSeq;
}

jsi::Value routeRecords(jsi::Runtime& rt) {
  std::vector<RouteRecord> copy;
  {
    std::lock_guard<std::mutex> lock(gRoutesMutex);
    copy = gRoutes;
  }
  auto address = [&](const void* p) {
    char text[32];
    std::snprintf(text, sizeof text, "%p", p);
    return jsi::String::createFromAscii(rt, text);
  };
  jsi::Array out(rt, copy.size());
  for (size_t i = 0; i < copy.size(); i++) {
    const auto& r = copy[i];
    jsi::Object o(rt);
    o.setProperty(rt, "seq", static_cast<double>(r.seq));
    o.setProperty(rt, "callRuntime", address(r.callRuntime));
    o.setProperty(rt, "installRuntime", address(r.installRuntime));
    o.setProperty(rt, "sameAddress", r.callRuntime == r.installRuntime);
    o.setProperty(rt, "callIdentity", static_cast<double>(r.callIdentity));
    o.setProperty(rt, "installIdentity", static_cast<double>(r.installIdentity));
    o.setProperty(rt, "acceptedByInstallBinding", r.accepted);
    o.setProperty(rt, "thread", static_cast<double>(r.thread));
    o.setProperty(rt, "threadName", jsi::String::createFromUtf8(rt, r.threadName));
    o.setProperty(rt, "onInstallJsThread", r.onInstallJsThread);
    o.setProperty(rt, "argCount", static_cast<double>(r.argCount));
    o.setProperty(rt, "argIsNumber", r.argIsNumber);
    out.setValueAtIndex(rt, i, std::move(o));
  }
  return out;
}
}  // namespace
#endif

void writeLifecycleStats(jsi::Runtime& rt, jsi::Object& out) {
  auto c = lifecycleCounters();
  auto set = [&](const char* k, uint64_t v) { out.setProperty(rt, k, static_cast<double>(v)); };
  set("scopesCreated", c.scopesCreated);
  set("scopesDestroyed", c.scopesDestroyed);
  set("scopesInvalidated", c.scopesInvalidated);
  set("invalidateOnJsThread", c.invalidateOnJsThread);
  set("invalidateJsThreadAlive", c.invalidateJsThreadAlive);
  set("invalidateJsTaskLingering", c.invalidateJsTaskLingering);
  set("adaptersAliveAtInvalidate", c.adaptersAliveAtInvalidate);
  set("adaptersTornDownAtInvalidate", c.adaptersTornDownAtInvalidate);
  set("adaptersDestroyedAfterInvalidate", c.adaptersDestroyedAfterInvalidate);
  set("adaptersDestroyedBeforeInvalidate", c.adaptersDestroyedBeforeInvalidate);
  set("registrationsRefused", c.registrationsRefused);
  set("drainsPosted", c.drainsPosted);
  set("drainsRun", c.drainsRun);
  set("drainsSkipped", c.drainsSkipped);
  set("drainsDropped", drainsDroppedCounter().load());
  set("lastInvalidateAtMs", c.lastInvalidateAtMs);
  set("bindingsInstalled", c.bindingsInstalled);
  out.setProperty(rt, "lastInvalidateThread", jsi::String::createFromUtf8(rt, c.lastInvalidateThread));
  out.setProperty(rt, "jsThreadName", jsi::String::createFromUtf8(rt, c.jsThreadName));
  writeWorkletStats(rt, out);
}

void installRuntimeBindings(
    jsi::Runtime& rt, const std::shared_ptr<react::CallInvoker>& invoker, const std::shared_ptr<RuntimeScope>& scope,
    const PlatformHooks& hooks) {
  scope->recordJsThread();
  // This runtime's identity: host functions below refuse calls from copies in other runtimes.
  RuntimeBinding binding = bindRuntime(rt);
  jsi::Object api(rt);
  api.setProperty(rt, "scopeId", static_cast<double>(scope->id()));
  api.setProperty(rt, "platform", jsi::String::createFromUtf8(rt, hooks.platform));
  // Adapters and these bindings refuse calls from other runtimes (ERR_RNRS_FOREIGN_RUNTIME).
  api.setProperty(rt, "runtimeGuard", true);
  // install(name, hash, maxInFlight): one adapter generation of a bundled generated module.
  api.setProperty(rt, "install", jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "install"), 3,
      [invoker, scope, binding](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
        if (!binding.accepts(&rt)) throwForeignRuntime(rt, "rnrs: __rnrsRuntime.install");
        if (n != 3 || !a[0].isString() || !a[1].isString() || !a[2].isNumber())
          throw jsi::JSError(rt, "TypeError: install(name, hash, maxInFlight)");
        return installModuleAdapter(rt, invoker, scope, a[0].getString(rt).utf8(rt), a[1].getString(rt).utf8(rt), a[2].getNumber());
      }));
#ifdef RNRS_TEST_HOOKS
  // Test hooks, compiled only with RNRS_TEST_HOOKS (device test harnesses; the default
  // package omits them). `testHooks` tells JS which build it runs on.
  api.setProperty(rt, "testHooks", true);
  // Test hook: invalidates this runtime's scope while JS is still running, so the refusal
  // path for adapters created afterwards can be exercised on a device.
  api.setProperty(rt, "invalidateForTesting", jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "invalidateForTesting"), 0,
      [scope](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) -> jsi::Value {
        scope->invalidate(true);
        return jsi::Value::undefined();
      }));
  api.setProperty(rt, "forceBytesCopyOutForTesting", jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "forceBytesCopyOutForTesting"), 1,
      [](jsi::Runtime&, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
        setForceBytesCopyOutForTesting(n > 0 && a[0].isBool() && a[0].getBool());
        return jsi::Value::undefined();
      }));
  // Test hook: a forced full GC (JSI instrumentation), for the collectibility checks.
  api.setProperty(rt, "collectGarbageForTesting", jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "collectGarbageForTesting"), 0,
      [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t) -> jsi::Value {
        rt.instrumentation().collectGarbage("rnrs test");
        return jsi::Value::undefined();
      }));
  // Test hook (worklets routing): records the runtime
  // and thread each call arrives on. It reads only the first argument's kind, touches no
  // adapter, and captures only this runtime's address, identity and JS thread id (no runtime
  // reference, invoker or JSI value), so a copy of it in another runtime is inert.
  api.setProperty(rt, "routeProbeForTesting", jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "routeProbeForTesting"), 1,
      [probeBinding = binding, jsThread = platform::currentThread()](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
        auto identity = findRuntimeIdentity(rt);
        RouteRecord r;
        r.callRuntime = &rt;
        r.installRuntime = probeBinding.address();
        r.callIdentity = identity ? identity->id : 0;
        r.installIdentity = probeBinding.id();
        r.accepted = probeBinding.accepts(&rt);
        r.thread = platform::currentThread();
        r.threadName = platform::currentThreadName();
        r.onInstallJsThread = r.thread == jsThread;
        r.argCount = n;
        r.argIsNumber = n > 0 && a[0].isNumber();
        return static_cast<double>(recordRoute(std::move(r)));
      }));
  api.setProperty(rt, "routeRecordsForTesting", jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "routeRecordsForTesting"), 0,
      [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t) -> jsi::Value { return routeRecords(rt); }));
  if (hooks.reloadForTesting) {
    api.setProperty(rt, "reloadForTesting", jsi::Function::createFromHostFunction(
        rt, jsi::PropNameID::forAscii(rt, "reloadForTesting"), 0,
        [reload = hooks.reloadForTesting](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) -> jsi::Value {
          reload();
          return jsi::Value::undefined();
        }));
  }
#else
  api.setProperty(rt, "testHooks", false);
#endif
  api.setProperty(rt, "lifecycle", jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "lifecycle"), 0,
      [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t) -> jsi::Value {
        jsi::Object out(rt);
        writeLifecycleStats(rt, out);
        return out;
      }));
  rt.global().setProperty(rt, "__rnrsRuntime", std::move(api));
}

}  // namespace rnrs
