#include "RnrsSurfaceHost.h"
#include <mutex>
#include <unordered_map>
#include "RnrsPlatform.h"
#include "RnrsRegistry.h"

namespace rnrs::surface {
namespace {

struct Claims {
  std::mutex lock;
  uint64_t next = 0;
  std::unordered_map<uintptr_t, uint64_t> byWindow;
  std::unordered_map<uint64_t, uintptr_t> bySerial;
};

Claims& claims() {
  static Claims c;
  return c;
}

// The new claim's serial, or 0 if `identity` is claimed.
uint64_t claim(uintptr_t identity) {
  auto& c = claims();
  std::lock_guard guard(c.lock);
  if (c.byWindow.count(identity)) return 0;
  const uint64_t serial = ++c.next;
  c.byWindow.emplace(identity, serial);
  c.bySerial.emplace(serial, identity);
  return serial;
}

}  // namespace

const RnrsSurfaceV1* route(uint64_t key) {
  const uint64_t owner = key >> abi::kSurfaceOwnerShift;
  const uint64_t local = key & ((uint64_t{1} << abi::kSurfaceOwnerShift) - 1);
  if (owner == 0 || local == 0 || owner >= abi::kSurfaceOwnerLimit) return nullptr;
  return surfaceOwner(static_cast<uint32_t>(owner));
}

int64_t attach(const RnrsSurfaceV1* table, uint64_t key, uintptr_t identity, void* window, void* layer, uint32_t width,
               uint32_t height, float scale, void (*refuse)(void*)) {
  const uint64_t serial = claim(identity);
  if (!serial) {
    refuse(window);
    return abi::kAttachBusy;
  }
  // No lock held: the binary may release the claim before this returns (a refused attach).
  return table->attach(key, window, layer, width, height, scale, serial);
}

uint32_t liveSurfaces() {
  uint32_t n = 0;
  for (uint32_t owner = 1; const RnrsSurfaceV1* t = surfaceOwner(owner); ++owner) n += t->liveSurfaces();
  return n;
}

void releaseClaim(uint64_t serial) {
  bool known = false;
  {
    auto& c = claims();
    std::lock_guard guard(c.lock);
    if (auto it = c.bySerial.find(serial); it != c.bySerial.end()) {
      known = true;
      if (auto w = c.byWindow.find(it->second); w != c.byWindow.end() && w->second == serial) c.byWindow.erase(w);
      c.bySerial.erase(it);
    }
  }
  if (!known) platform::log(platform::LogLevel::Error, "surface window claim %llu released twice or never given; ignored",
                            static_cast<unsigned long long>(serial));
}

size_t claimedWindows() {
  auto& c = claims();
  std::lock_guard guard(c.lock);
  return c.byWindow.size();
}

}  // namespace rnrs::surface
