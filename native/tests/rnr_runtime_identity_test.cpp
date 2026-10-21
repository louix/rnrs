// Host tests for the runtime identity rule (packages/runtime/cpp/RnrRuntimeIdentity.h),
// which is pure C++. A "runtime" here is a slot of storage plus the data a JSI runtime would
// hold for it: destroying the runtime releases its RuntimeIdentityHolder, as the runtime-data
// slot does. Run: bash scripts/test-native.sh (ThreadSanitizer build).
#include "RnrRuntimeIdentity.h"
#include <cstdio>
#include <cstdlib>
#include <optional>
#include <thread>
#include <vector>

using rnr::RuntimeBinding;
using rnr::RuntimeIdentity;
using rnr::RuntimeIdentityHolder;

#define CHECK(cond, ...)                                                   \
  do {                                                                     \
    if (!(cond)) {                                                         \
      std::fprintf(stderr, "%s:%d: CHECK(%s) failed: ", __FILE__, __LINE__, #cond); \
      std::fprintf(stderr, __VA_ARGS__);                                   \
      std::fprintf(stderr, "\n");                                          \
      std::exit(1);                                                        \
    }                                                                      \
  } while (0)

// The runtime data slot of a simulated runtime.
struct FakeRuntime {
  std::optional<RuntimeIdentityHolder> data;
  std::shared_ptr<RuntimeIdentity> identity() {
    if (!data) data.emplace(std::make_shared<RuntimeIdentity>(rnr::nextRuntimeIdentityId()));
    return data->identity;
  }
  void destroy() { data.reset(); }
};

static void acceptsOnlyItsRuntime() {
  FakeRuntime a, b;
  RuntimeBinding binding(&a, a.identity());
  CHECK(binding.accepts(&a), "own runtime refused");
  CHECK(!binding.accepts(&b), "foreign runtime accepted");
  CHECK(!binding.accepts(nullptr), "null runtime accepted");
  CHECK(binding.id() != 0 && binding.id() != b.identity()->id, "identities must be unique and nonzero");
  RuntimeBinding again(&a, a.identity());
  CHECK(again.id() == binding.id(), "one identity per runtime");
}

// A later runtime at the same address must not pass for the destroyed one.
static void addressReuseIsRefused() {
  alignas(FakeRuntime) unsigned char storage[sizeof(FakeRuntime)];
  auto* first = new (storage) FakeRuntime();
  RuntimeBinding old(first, first->identity());
  CHECK(old.accepts(storage), "live runtime refused");
  first->destroy();
  first->~FakeRuntime();
  auto* second = new (storage) FakeRuntime();  // same address
  CHECK(static_cast<void*>(second) == static_cast<void*>(first), "test setup: address not reused");
  CHECK(!old.accepts(second), "binding of a destroyed runtime accepted its successor at the same address");
  RuntimeBinding fresh(second, second->identity());
  CHECK(fresh.accepts(second), "new runtime refused");
  CHECK(fresh.id() != old.id(), "successor reused the identity");
  second->destroy();
  second->~FakeRuntime();
}

// Destruction on one thread while others check (TSan): checks never race the flag, and every
// check after destruction is visible as refused.
static void destructionRacesChecks() {
  for (int round = 0; round < 200; round++) {
    FakeRuntime rt;
    RuntimeBinding binding(&rt, rt.identity());
    std::atomic<bool> destroyed{false};
    std::vector<std::thread> threads;
    for (int t = 0; t < 3; t++) {
      threads.emplace_back([&] {
        for (int i = 0; i < 200; i++) {
          bool after = destroyed.load(std::memory_order_acquire);
          bool ok = binding.accepts(&rt);
          CHECK(!(after && ok), "accepted after destruction");
        }
      });
    }
    rt.destroy();
    destroyed.store(true, std::memory_order_release);
    for (auto& t : threads) t.join();
    CHECK(!binding.accepts(&rt), "accepted after destruction");
  }
}

int main() {
  acceptsOnlyItsRuntime();
  addressReuseIsRefused();
  destructionRacesChecks();
  std::printf("rnr_runtime_identity_test: ok\n");
}
