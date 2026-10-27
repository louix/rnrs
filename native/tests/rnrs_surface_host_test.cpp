// Host tests for the surface host (packages/runtime/cpp/RnrsSurfaceHost.cpp) and the registry's
// surface binding, with fake surface tables standing for separately built binaries:
// - each distinct table is checked, then bound once before any init; modules of one binary
//   share an owner; a table of another surface ABI, or one that refuses to bind, refuses its
//   module by name and nothing else;
// - keys route by their owner; zero, unbound, unknown and malformed keys reach no binary;
// - a window held by an attachment of binary A (detach timed out, renderer still leasing) is
//   refused as busy for binary B without calling B, and B attaches once A returns the claim
//   from another thread;
// - a refusal inside the binary returns the claim during attach (no host lock is held then);
// - a stale, repeated or unknown claim release never ends a newer claim on the same window.
// Run: bash scripts/test-native.sh (TSan).
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include "RnrsRegistry.h"
#include "RnrsSurfaceHost.h"

#define CHECK(cond, ...)                                                            \
  do {                                                                              \
    if (!(cond)) {                                                                  \
      std::fprintf(stderr, "%s:%d: CHECK(%s) failed: ", __FILE__, __LINE__, #cond); \
      std::fprintf(stderr, __VA_ARGS__);                                            \
      std::fprintf(stderr, "\n");                                                   \
      std::exit(1);                                                                 \
    }                                                                               \
  } while (0)

namespace {
std::mutex gEventsLock;
std::string gEvents;
void event(const std::string& e) {
  std::lock_guard g(gEventsLock);
  gEvents += e + " ";
}

// One fake binary's rnrs-surface: its owner, and the claims it holds per attachment.
template <int N>
struct Binary {
  static inline uint32_t owner = 0;
  static inline int binds = 0;
  static inline RnrsSurfaceRelease release = nullptr;
  static inline std::mutex lock;
  static inline std::map<uint64_t, uint64_t> claims;  // attachment -> claim
  static inline uint64_t nextAttachment = 1;
  static inline std::atomic<int> attaches{0};

  static bool bind(uint32_t o, RnrsSurfaceRelease r) {
    binds++;
    event("bind" + std::to_string(N) + "=" + std::to_string(o));
    if (owner && owner != o) return false;
    owner = o, release = r;
    return true;
  }
  // Local key 999: refused inside the binary, which returns the claim before attach returns.
  static int64_t attach(uint64_t key, void*, void*, uint32_t, uint32_t, float, uint64_t claim) {
    attaches++;
    CHECK(key >> 32 == owner, "binary %d got key %llu of another owner", N, static_cast<unsigned long long>(key));
    if ((key & 0xffffffff) == 999) {
      release(claim);
      return rnrs::abi::kAttachRefused;
    }
    std::lock_guard g(lock);
    claims[nextAttachment] = claim;
    return static_cast<int64_t>(nextAttachment++);
  }
  // The renderer drops its last lease: the window, then the claim, go back.
  static void retire(uint64_t attachment) {
    uint64_t claim;
    {
      std::lock_guard g(lock);
      claim = claims.at(attachment);
      claims.erase(attachment);
    }
    release(claim);
  }
  static uint64_t claimOf(uint64_t attachment) {
    std::lock_guard g(lock);
    return claims.at(attachment);
  }
  static bool resize(uint64_t, uint64_t, uint32_t, uint32_t, float) { return true; }
  static bool detach(uint64_t, uint64_t, uint32_t) { return false; }
  static int32_t revoke(uint64_t, uint64_t) { return rnrs::abi::kRevokeRetiring; }
  static bool touch(uint64_t, uint64_t, int32_t, int32_t, float, float, int64_t) { return true; }
  static uint32_t live() { return N; }
  static inline const RnrsSurfaceV1 table{RNRS_SURFACE_ABI, sizeof(RnrsSurfaceV1), bind, attach, resize, detach, revoke, touch, live};
};
using A = Binary<1>;
using B = Binary<2>;
using Unbindable = Binary<3>;

const RnrsSurfaceV1 kOtherAbi = [] {
  RnrsSurfaceV1 t = A::table;
  t.abi = RNRS_SURFACE_ABI + 1;
  t.bind = [](uint32_t, RnrsSurfaceRelease) -> bool {
    std::fprintf(stderr, "a refused surface table was bound\n");
    std::abort();
  };
  return t;
}();

void init() { event("init"); }
bool dir(const uint8_t*, size_t) { return true; }

RnrsModuleV3 module(const char* name, const RnrsSurfaceV1* surface) {
  RnrsModuleV3 t{};
  t.abi = RNRS_ABI;
  t.size = sizeof(RnrsModuleV3);
  t.vtableSize = sizeof(JsiVTable);
  t.scalarBindingSize = sizeof(RnrsScalarBinding);
  t.name = name, t.nameLen = std::strlen(name);
  t.hash = "h", t.hashLen = 1;
  t.init = init;
  t.setAppDataDir = dir;
  t.surface = surface;
  return t;
}
const RnrsModuleV3 kA = module("A", &A::table);
const RnrsModuleV3 kHeadless = module("Headless", nullptr);
const RnrsModuleV3 kOther = module("OtherSurfaceAbi", &kOtherAbi);
const RnrsModuleV3 kB1 = module("B1", &B::table);
const RnrsModuleV3 kB2 = module("B2", &B::table);
const RnrsModuleV3 kUnbindable = [] {
  Unbindable::owner = 77;  // already bound elsewhere: binding to another owner fails
  return module("Unbindable", &Unbindable::table);
}();

std::atomic<int> gWindowRefsReleased{0};
void releaseWindow(void*) { gWindowRefsReleased++; }

uint64_t key(uint32_t owner, uint32_t local) { return (uint64_t{owner} << 32) | local; }
}  // namespace

extern "C" const RnrsModuleV3* rnrs_module_v3_a() { return &kA; }
extern "C" const RnrsModuleV3* rnrs_module_v3_headless() { return &kHeadless; }
extern "C" const RnrsModuleV3* rnrs_module_v3_other_surface_abi() { return &kOther; }
extern "C" const RnrsModuleV3* rnrs_module_v3_b1() { return &kB1; }
extern "C" const RnrsModuleV3* rnrs_module_v3_b2() { return &kB2; }
extern "C" const RnrsModuleV3* rnrs_module_v3_unbindable() { return &kUnbindable; }

int main() {
  using namespace rnrs;
  // Binding: before every init, once per table, in registry order; refusals by module name.
  std::string error;
  CHECK(findModule("A", "h", error) == &kA, "%s", error.c_str());
  CHECK(gEvents == "bind1=1 bind2=2 bind3=3 init init init init ", "order: %s", gEvents.c_str());
  CHECK(A::binds == 1 && B::binds == 1, "B's two modules share one bind (%d)", B::binds);
  CHECK(findModule("B1", "h", error) && findModule("B2", "h", error) && findModule("Headless", "h", error), "%s", error.c_str());
  CHECK(!findModule("OtherSurfaceAbi", "h", error), "refused");
  CHECK(error.find("module OtherSurfaceAbi was built with rnrs-surface ABI 2") != std::string::npos, "%s", error.c_str());
  CHECK(error.find("module Unbindable has a surface table that was already bound") != std::string::npos, "%s", error.c_str());
  CHECK(surfaceOwner(1) == &A::table && surfaceOwner(2) == &B::table && !surfaceOwner(3) && !surfaceOwner(0), "owners");

  // Routing by the key's owner only.
  CHECK(surface::route(key(1, 5)) == &A::table && surface::route(key(2, 5)) == &B::table, "route");
  for (uint64_t k : {uint64_t{0}, key(0, 5), key(1, 0), key(3, 5), key(99, 5), uint64_t{1} << 53, ~uint64_t{0}})
    CHECK(!surface::route(k), "key %llx reaches no binary", static_cast<unsigned long long>(k));
  CHECK(surface::liveSurfaces() == 1 + 2, "summed over bound tables");

  // A window held by binary A (its detach timed out; the renderer still leases it).
  int window = 0;
  const auto identity = reinterpret_cast<uintptr_t>(&window);
  const int64_t a = surface::attach(&A::table, key(1, 5), identity, &window, nullptr, 10, 10, 1, releaseWindow);
  CHECK(a > 0 && surface::claimedWindows() == 1, "attached %lld", static_cast<long long>(a));
  const uint64_t claimA = A::claimOf(static_cast<uint64_t>(a));
  // The view's key swaps to binary B: busy, B never called, the view's reference released.
  CHECK(surface::attach(&B::table, key(2, 7), identity, &window, nullptr, 10, 10, 1, releaseWindow) == abi::kAttachBusy, "busy");
  CHECK(B::attaches == 0 && gWindowRefsReleased == 1, "B called %d, refs released %d", B::attaches.load(), gWindowRefsReleased.load());
  // Also for another surface of A itself.
  CHECK(surface::attach(&A::table, key(1, 6), identity, &window, nullptr, 10, 10, 1, releaseWindow) == abi::kAttachBusy, "busy");
  // A's renderer drops its last lease on its render thread: the claim goes back from there.
  std::thread([&] { A::retire(static_cast<uint64_t>(a)); }).join();
  CHECK(surface::claimedWindows() == 0, "released");
  const int64_t b = surface::attach(&B::table, key(2, 7), identity, &window, nullptr, 10, 10, 1, releaseWindow);
  CHECK(b > 0 && B::attaches == 1, "the view's retry attaches to B");
  const uint64_t claimB = B::claimOf(static_cast<uint64_t>(b));
  CHECK(claimB != claimA, "a new claim");

  // A stale, repeated or unknown release does not end B's claim on the same window.
  surface::releaseClaim(claimA);
  surface::releaseClaim(claimA + 1000);
  CHECK(surface::claimedWindows() == 1, "B still holds the window");
  CHECK(surface::attach(&A::table, key(1, 5), identity, &window, nullptr, 10, 10, 1, releaseWindow) == abi::kAttachBusy, "busy");

  // A refusal inside the binary returns its claim during attach (no host lock held: no deadlock).
  int other = 0;
  CHECK(surface::attach(&A::table, key(1, 999), reinterpret_cast<uintptr_t>(&other), &other, nullptr, 10, 10, 1, releaseWindow) ==
            abi::kAttachRefused,
        "refused inside");
  CHECK(surface::claimedWindows() == 1, "the refused window is not claimed");

  // Concurrent attaches of one window through both binaries: exactly one wins.
  B::retire(static_cast<uint64_t>(b));
  for (int round = 0; round < 200; ++round) {
    std::atomic<int> won{0};
    std::thread t1([&] { won += surface::attach(&A::table, key(1, 5), identity, &window, nullptr, 1, 1, 1, releaseWindow) > 0; });
    std::thread t2([&] { won += surface::attach(&B::table, key(2, 7), identity, &window, nullptr, 1, 1, 1, releaseWindow) > 0; });
    t1.join(), t2.join();
    CHECK(won == 1 && surface::claimedWindows() == 1, "round %d: %d winners", round, won.load());
    std::lock_guard ga(A::lock);
    std::lock_guard gb(B::lock);
    for (auto& [att, claim] : A::claims) surface::releaseClaim(claim);
    for (auto& [att, claim] : B::claims) surface::releaseClaim(claim);
    A::claims.clear(), B::claims.clear();
  }
  CHECK(surface::claimedWindows() == 0, "all released");
  std::puts("rnrs_surface_host_test: ok");
}
