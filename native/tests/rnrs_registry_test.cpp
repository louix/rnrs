// Host tests for the module registry (packages/runtime/cpp/RnrsRegistry.cpp) with fake module
// tables: a table of another ABI or size is refused before any of its fields beyond the frozen
// {abi, size} prefix or any of its functions is used; a table with other boundary struct sizes and
// a second definition of a module name are refused; each accepted binary's init runs once,
// after validation and before anything else; the app data directory reaches every accepted
// module, and one refusal makes the broadcast fail. Run: bash scripts/test-native.sh.
#include "RnrsRegistry.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

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
int gInits = 0, gGoodDirs = 0, gSecondDirs = 0;
std::string gEvents;

void initGood() { gInits++, gEvents += "init "; }
bool dirGood(const uint8_t* p, size_t n) {
  gGoodDirs++;
  gEvents += "dir:" + std::string(reinterpret_cast<const char*>(p), n) + " ";
  return true;
}
bool dirSecond(const uint8_t*, size_t) {
  gSecondDirs++;
  return false;  // e.g. already set to another path
}
[[noreturn]] void neverCalled() {
  std::fprintf(stderr, "a refused table's function was called\n");
  std::abort();
}
void neverInit() { neverCalled(); }
bool neverDir(const uint8_t*, size_t) { neverCalled(); }

RnrsModuleV1 table(const char* name, const char* hash, void (*init)(), bool (*dir)(const uint8_t*, size_t)) {
  RnrsModuleV1 t{};
  t.abi = RNRS_ABI;
  t.size = sizeof(RnrsModuleV1);
  t.vtableSize = sizeof(JsiVTable);
  t.scalarBindingSize = sizeof(RnrsScalarBinding);
  t.name = name, t.nameLen = std::strlen(name);
  t.hash = hash, t.hashLen = std::strlen(hash);
  t.init = init;
  t.setAppDataDir = dir;
  return t;
}

const RnrsModuleV1 kGood = table("Good", "h1", initGood, dirGood);
const RnrsModuleV1 kSecond = table("Second", "h2", initGood, dirSecond);
const RnrsModuleV1 kDuplicate = table("Good", "h1", neverInit, neverDir);
const RnrsModuleV1 kBadVtable = [] {
  auto t = table("BadVtable", "h", neverInit, neverDir);
  t.vtableSize += sizeof(void*);
  return t;
}();
// A future ABI: only the frozen prefix may be read. Everything after it is garbage here.
struct OtherAbi {
  uint32_t abi = RNRS_ABI + 1, size = 4096;
  unsigned char garbage[4096];
} kOtherAbi{};
}  // namespace

extern "C" const RnrsModuleV1* rnrs_module_v1_good() { return &kGood; }
extern "C" const RnrsModuleV1* rnrs_module_v1_second() { return &kSecond; }
extern "C" const RnrsModuleV1* rnrs_module_v1_duplicate() { return &kDuplicate; }
extern "C" const RnrsModuleV1* rnrs_module_v1_bad_vtable() { return &kBadVtable; }
extern "C" const RnrsModuleV1* rnrs_module_v1_other_abi() {
  std::memset(kOtherAbi.garbage, 0xff, sizeof kOtherAbi.garbage);
  return reinterpret_cast<const RnrsModuleV1*>(&kOtherAbi);
}

int main() {
  // The platform module sets the app data dir first: validation and init precede it.
  CHECK(!rnrs::setAppDataDir("/data/app"), "one module refused, so the broadcast reports failure");
  CHECK(gInits == 2, "init ran %d times (once per accepted table)", gInits);
  CHECK(gEvents == "init init dir:/data/app ", "order: %s", gEvents.c_str());
  CHECK(gGoodDirs == 1 && gSecondDirs == 1, "every accepted module got the directory");

  std::string error;
  CHECK(rnrs::findModule("Good", "h1", error) == &kGood, "found: %s", error.c_str());
  CHECK(!rnrs::findModule("Good", "stale", error) && error.find("different specs") != std::string::npos, "%s", error.c_str());
  CHECK(!rnrs::findModule("BadVtable", "h", error), "a table with other struct sizes is not used");
  CHECK(error.find("rnrs_module_v1_other_abi was built for rnrs ABI 2") != std::string::npos, "%s", error.c_str());
  CHECK(error.find("rnrs_module_v1_bad_vtable was built with different boundary struct sizes") != std::string::npos, "%s", error.c_str());
  CHECK(error.find("rnrs_module_v1_duplicate defines module Good, which another linked binary also defines") != std::string::npos,
        "%s", error.c_str());
  CHECK(error.find("linked: Good, Second") != std::string::npos, "%s", error.c_str());
  CHECK(gInits == 2, "init does not run again");
  std::puts("rnrs_registry_test: ok");
}
