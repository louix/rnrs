// The surface entry points @rnrs/surface's iOS view calls (a public header of the RnrsRuntime
// pod; defined in RnrsSurfaceEntry.mm): each forwards to the module binary that owns the
// surface key. Main thread only.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Attaches `layer` (the standalone CAMetalLayer sublayer of `view`; both retained before this
/// returns) to the surface
/// `key`: the attachment number (> 0), -1 (busy: retry later) or 0 (refused).
int64_t rnrs_surface_attach(uint64_t key, void *view, void *layer, uint32_t width, uint32_t height, float scale);
/// Updates the extent of the current attachment; false if it is not current.
bool rnrs_surface_resize(uint64_t key, uint64_t attachment, uint32_t width, uint32_t height, float scale);
/// Revokes without waiting: 0 released, 1 retiring, -1 stale.
int32_t rnrs_surface_revoke(uint64_t key, uint64_t attachment);
/// One touch transition (rnrs-surface touch.rs): phase 0 down, 1 move, 2 up, 3 cancel, 4 cancel all;
/// `slot` 0..9 per attachment; view-local physical pixels; UITouch.timestamp in ms. True if accepted.
bool rnrs_surface_touch(uint64_t key, uint64_t attachment, int32_t phase, int32_t slot, float x, float y, int64_t timeMs);
int32_t rnrs_surface_live_surfaces(void);

#ifdef __cplusplus
}
#endif
