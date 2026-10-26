// The rnrs_surface_* entry points of @rnrs/surface's iOS view (RnrsSurfaceEntry.h): each
// forwards to the binary owning the surface key (cpp/RnrsSurfaceHost.h). The view calls them on
// the main thread; the binaries refuse other threads. This file is their only definition in the app.
#include "RnrsSurfaceEntry.h"
#include <cstdint>
#include "RnrsSurfaceHost.h"

namespace {
// Nothing to release: the binary retains the view and the layer itself, on attach.
void keepWindow(void*) {}
}  // namespace

extern "C" int64_t rnrs_surface_attach(uint64_t key, void* view, void* layer, uint32_t width, uint32_t height, float scale) {
  const RnrsSurfaceV1* table = rnrs::surface::route(key);
  if (!table || !view || !layer) return rnrs::abi::kAttachRefused;
  // The layer identifies the window: the view's standalone CAMetalLayer.
  return rnrs::surface::attach(table, key, reinterpret_cast<uintptr_t>(layer), view, layer, width, height, scale, keepWindow);
}

extern "C" bool rnrs_surface_resize(uint64_t key, uint64_t attachment, uint32_t width, uint32_t height, float scale) {
  const RnrsSurfaceV1* table = rnrs::surface::route(key);
  return table && table->resize(key, attachment, width, height, scale);
}

extern "C" int32_t rnrs_surface_revoke(uint64_t key, uint64_t attachment) {
  const RnrsSurfaceV1* table = rnrs::surface::route(key);
  return table ? table->revoke(key, attachment) : rnrs::abi::kRevokeStale;
}

extern "C" bool rnrs_surface_touch(uint64_t key, uint64_t attachment, int32_t phase, int32_t slot, float x, float y, int64_t timeMs) {
  const RnrsSurfaceV1* table = rnrs::surface::route(key);
  return table && table->touch(key, attachment, phase, slot, x, y, timeMs);
}

extern "C" int32_t rnrs_surface_live_surfaces(void) {
  const uint32_t n = rnrs::surface::liveSurfaces();
  return n > INT32_MAX ? INT32_MAX : static_cast<int32_t>(n);
}
