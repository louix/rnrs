// Host tests for the shared runtime scope (packages/runtime/cpp/RnrsScope.cpp), which is
// pure C++. Run: bash scripts/test-native.sh (builds with ThreadSanitizer).
#include "RnrsScope.h"
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>

using rnrs::RuntimeScope;

#define CHECK(cond, ...)                                                   \
  do {                                                                     \
    if (!(cond)) {                                                         \
      std::fprintf(stderr, "%s:%d: CHECK(%s) failed: ", __FILE__, __LINE__, #cond); \
      std::fprintf(stderr, __VA_ARGS__);                                   \
      std::fprintf(stderr, "\n");                                          \
      std::exit(1);                                                        \
    }                                                                      \
  } while (0)

// Registration racing invalidation: every adapter is either registered and torn down exactly
// once by invalidate(), or refused (and torn down by its creator). Never both, never neither.
static void registrationRacesInvalidation() {
  constexpr int kRounds = 400, kThreads = 4, kPerThread = 16;
  int roundsWithBoth = 0;
  for (int round = 0; round < kRounds; round++) {
    RuntimeScope scope;
    struct Adapter {
      std::shared_ptr<int> owner = std::make_shared<int>(0);
      std::atomic<int> byScope{0}, byCreator{0};
      bool registered = false;
    };
    std::vector<Adapter> adapters(kThreads * kPerThread);
    std::atomic<bool> go{false};
    std::atomic<int> attempts{0};
    std::vector<std::thread> threads;
    for (int t = 0; t < kThreads; t++) {
      threads.emplace_back([&, t] {
        while (!go.load()) {}
        for (int i = 0; i < kPerThread; i++) {
          auto& a = adapters[t * kPerThread + i];
          attempts++;
          a.registered = scope.add(a.owner, [&a] { a.byScope++; return true; });
          if (!a.registered) a.byCreator++;  // what installCounterAdapter does on refusal
        }
      });
    }
    go = true;
    // Invalidate while registrations are in progress (roughly half-way through).
    while (attempts.load() < kThreads * kPerThread / 2) {}
    auto report = scope.invalidate(false);
    for (auto& t : threads) t.join();
    int registered = 0, refused = 0;
    for (auto& a : adapters) {
      CHECK(a.byScope + a.byCreator == 1, "adapter torn down %d times", a.byScope + a.byCreator);
      CHECK(a.registered == (a.byScope == 1), "registered adapter not torn down by the scope");
      a.registered ? registered++ : refused++;
    }
    CHECK(report.first && report.tornDown == static_cast<uint64_t>(registered), "report %llu vs %d",
          static_cast<unsigned long long>(report.tornDown), registered);
    CHECK(!scope.add(adapters[0].owner, [] { return true; }), "registration accepted after invalidation");
    roundsWithBoth += registered > 0 && refused > 0;
  }
  CHECK(roundsWithBoth > 0, "race never interleaved");
  std::printf("registrationRacesInvalidation: ok (%d/%d rounds interleaved)\n", roundsWithBoth, kRounds);
}

// Concurrent invalidate calls: exactly one does the work.
static void invalidateIsIdempotentAcrossThreads() {
  for (int round = 0; round < 200; round++) {
    RuntimeScope scope;
    auto owner = std::make_shared<int>(0);
    std::atomic<int> teardowns{0};
    CHECK(scope.add(owner, [&] { teardowns++; return true; }), "add");
    std::atomic<int> firsts{0};
    std::vector<std::thread> threads;
    for (int t = 0; t < 4; t++) threads.emplace_back([&] { firsts += scope.invalidate(false).first; });
    for (auto& t : threads) t.join();
    CHECK(firsts == 1 && teardowns == 1, "firsts %d teardowns %d", firsts.load(), teardowns.load());
  }
  std::printf("invalidateIsIdempotentAcrossThreads: ok\n");
}

// Adapters already destroyed are skipped; the scope never extends an adapter's life; a
// teardown callback may call back into the scope (it runs outside the scope lock).
static void ownershipAndReentrancy() {
  RuntimeScope scope;
  {
    auto gone = std::make_shared<int>(0);
    CHECK(scope.add(gone, [] { CHECK(false, "teardown of a destroyed adapter"); return true; }), "add");
  }
  auto owner = std::make_shared<int>(0);
  bool reentered = true;
  CHECK(scope.add(owner, [&] { reentered = scope.add(owner, [] { return true; }); return true; }), "add");
  CHECK(owner.use_count() == 1, "scope holds a strong reference");
  auto report = scope.invalidate(false);
  CHECK(report.alive == 1 && report.tornDown == 1, "alive %llu", static_cast<unsigned long long>(report.alive));
  CHECK(!reentered, "re-entrant registration during invalidation accepted");
  std::printf("ownershipAndReentrancy: ok\n");
}

static void scopesAreCountedWhenDestroyed() {
  auto before = rnrs::lifecycleCounters();
  { auto s = std::make_shared<RuntimeScope>(); auto copy = s; s->invalidate(false); }
  auto after = rnrs::lifecycleCounters();
  CHECK(after.scopesCreated == before.scopesCreated + 1 && after.scopesDestroyed == before.scopesDestroyed + 1, "counts");
  std::printf("scopesAreCountedWhenDestroyed: ok\n");
}

int main() {
  registrationRacesInvalidation();
  invalidateIsIdempotentAcrossThreads();
  ownershipAndReentrancy();
  scopesAreCountedWhenDestroyed();
  return 0;
}
