#include "RnrScope.h"

namespace rnr {
using platform::currentThread;
using platform::currentThreadName;
using platform::realtimeMs;

namespace {
std::atomic<uint64_t> gNextScope{1};
std::atomic<uint64_t> gScopesCreated{0}, gScopesDestroyed{0}, gScopesInvalidated{0}, gInvalidateOnJsThread{0},
    gInvalidateJsThreadAlive{0}, gInvalidateJsTaskLingering{0}, gAdaptersAliveAtInvalidate{0},
    gAdaptersTornDownAtInvalidate{0}, gAdaptersDestroyedAfterInvalidate{0}, gAdaptersDestroyedBeforeInvalidate{0},
    gRegistrationsRefused{0}, gBindingsInstalled{0}, gDrainsPosted{0}, gDrainsRun{0}, gDrainsSkipped{0}, gLastInvalidateAtMs{0};
std::mutex gLastMutex;
std::string gLastInvalidateThread, gLastJsThread;
}  // namespace

RuntimeScope::RuntimeScope() : id_(gNextScope++) { gScopesCreated++; }
RuntimeScope::~RuntimeScope() { gScopesDestroyed++; }

void RuntimeScope::recordJsThread() {
  gBindingsInstalled++;
  std::lock_guard<std::mutex> lock(mutex_);
  jsThread_ = currentThread();
  jsThreadName_ = currentThreadName();
  std::lock_guard<std::mutex> last(gLastMutex);
  gLastJsThread = jsThreadName_;
}

bool RuntimeScope::add(std::weak_ptr<void> owner, Teardown teardown) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (invalidated()) {
    gRegistrationsRefused++;
    return false;
  }
  std::erase_if(entries_, [](const Entry& e) { return e.owner.expired(); });
  entries_.push_back({std::move(owner), std::move(teardown)});
  return true;
}

InvalidateReport RuntimeScope::invalidate(bool jsThreadAlive) {
  InvalidateReport report;
  std::vector<Entry> entries;
  platform::ThreadId jsThread;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (invalidated_.exchange(true, std::memory_order_acq_rel)) return report;
    entries.swap(entries_);
    jsThread = jsThread_;
    report.jsThread = jsThreadName_;
  }
  report.first = true;
  gLastInvalidateAtMs = realtimeMs();
  if (currentThread() == jsThread) gInvalidateOnJsThread++;
  if (jsThreadAlive) gInvalidateJsThreadAlive++;
  // Kernel view (Android): a terminated Java thread's task entry can linger briefly while it exits.
  report.jsTaskLingering = platform::threadEntryLingering(jsThread, report.jsThread);
  if (report.jsTaskLingering) gInvalidateJsTaskLingering++;
  report.thread = currentThreadName();
  {
    std::lock_guard<std::mutex> last(gLastMutex);
    gLastInvalidateThread = report.thread;
  }
  for (auto& entry : entries) {
    // Holding the owner keeps the adapter alive while its teardown runs. Adapters already
    // torn down explicitly (test hook) but not yet finalized are alive and skipped.
    if (auto owner = entry.owner.lock()) {
      report.alive++;
      report.tornDown += entry.teardown();
    }
  }
  gAdaptersAliveAtInvalidate += report.alive;
  gAdaptersTornDownAtInvalidate += report.tornDown;
  gScopesInvalidated++;
  return report;
}

void noteAdapterDestroyed(const RuntimeScope& scope) {
  (scope.invalidated() ? gAdaptersDestroyedAfterInvalidate : gAdaptersDestroyedBeforeInvalidate)++;
}
void noteDrainPosted() { gDrainsPosted++; }
void noteDrainRun(bool drained) { (drained ? gDrainsRun : gDrainsSkipped)++; }

LifecycleCounters lifecycleCounters() {
  LifecycleCounters c{gScopesCreated, gScopesDestroyed, gScopesInvalidated, gInvalidateOnJsThread,
                      gInvalidateJsThreadAlive, gInvalidateJsTaskLingering, gAdaptersAliveAtInvalidate,
                      gAdaptersTornDownAtInvalidate, gAdaptersDestroyedAfterInvalidate,
                      gAdaptersDestroyedBeforeInvalidate, gRegistrationsRefused, gDrainsPosted, gDrainsRun,
                      gDrainsSkipped, gLastInvalidateAtMs, gBindingsInstalled, {}, {}};
  std::lock_guard<std::mutex> last(gLastMutex);
  c.lastInvalidateThread = gLastInvalidateThread;
  c.jsThreadName = gLastJsThread;
  return c;
}

}  // namespace rnr
