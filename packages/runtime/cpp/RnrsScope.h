#pragma once
// Framework-supplied runtime scope (stands in for generated code).
// A RuntimeScope is one JS runtime (one React instance). Adapters installed into that
// runtime register here; invalidate() tears all of them down from whatever thread the
// platform's lifecycle hook runs on. Pure C++: no JSI, JNI, Android or Apple APIs (OS
// services go through RnrsPlatform.h), so it is shared by both platforms and also built and
// stress-tested on the host (native/tests/rnrs_scope_test.cpp).
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>
#include "RnrsPlatform.h"

namespace rnrs {

struct InvalidateReport {
  bool first = false;          // false: the scope was already invalidated; nothing done
  uint64_t alive = 0;          // registered adapters still alive
  uint64_t tornDown = 0;       // of those, torn down by this call
  bool jsTaskLingering = false;
  std::string thread, jsThread;
};

class RuntimeScope {
 public:
  // Returns true if this call tore the adapter down (false: it already was).
  using Teardown = std::function<bool()>;

  RuntimeScope();
  ~RuntimeScope();
  RuntimeScope(const RuntimeScope&) = delete;
  RuntimeScope& operator=(const RuntimeScope&) = delete;

  uint64_t id() const { return id_; }
  bool invalidated() const { return invalidated_.load(std::memory_order_acquire); }

  // JS thread, at bindings installation.
  void recordJsThread();

  // Registers an adapter's teardown. `owner` is observed weakly: the scope never keeps an
  // adapter alive. Linearizes with invalidate(): either the entry is registered before
  // invalidation (and invalidate() tears it down) or this returns false and registers
  // nothing, in which case the caller must tear the adapter down itself.
  bool add(std::weak_ptr<void> owner, Teardown teardown);

  // Idempotent; any thread. Runs every live adapter's teardown outside the scope lock.
  // `jsThreadAlive` is the platform hook's report for the JS thread (diagnostics).
  InvalidateReport invalidate(bool jsThreadAlive);

 private:
  struct Entry {
    std::weak_ptr<void> owner;
    Teardown teardown;
  };
  const uint64_t id_;
  std::atomic<bool> invalidated_{false};
  std::mutex mutex_;
  std::vector<Entry> entries_;
  platform::ThreadId jsThread_ = 0;
  std::string jsThreadName_;
};

// Process-wide lifecycle diagnostics (they survive reloads).
struct LifecycleCounters {
  uint64_t scopesCreated, scopesDestroyed, scopesInvalidated, invalidateOnJsThread, invalidateJsThreadAlive,
      invalidateJsTaskLingering, adaptersAliveAtInvalidate, adaptersTornDownAtInvalidate,
      adaptersDestroyedAfterInvalidate, adaptersDestroyedBeforeInvalidate, registrationsRefused, drainsPosted,
      drainsRun, drainsSkipped, lastInvalidateAtMs, bindingsInstalled;
  std::string lastInvalidateThread, jsThreadName;
};
LifecycleCounters lifecycleCounters();

void noteAdapterDestroyed(const RuntimeScope& scope);
void noteDrainPosted();
void noteDrainRun(bool drained);

}  // namespace rnrs
