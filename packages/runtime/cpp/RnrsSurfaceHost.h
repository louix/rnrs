#pragma once
// The platform side of rendering surfaces (@rnrs/surface views), shared by every module binary:
// routes each view operation to the binary that owns the surface, and owns the process-wide
// window claims. No JSI, JNI or Objective-C here; the Android JNI functions (android/src/main/jni)
// and the iOS entry points (ios/RnrsSurfaceEntry.mm) call these.
//
// Owners: every distinct surface table (RnrsAbi.h RnrsSurfaceV1; one per binary) is bound by the
// registry to an owner number 1, 2, ... before its binary's init. Its surface keys are
// owner * 2^32 + local, so a key names its owner and a key of one binary never reaches another.
// Binaries are never unloaded, so owners are never reused.
//
// Claims: a platform window (an ANativeWindow, a CAMetalLayer) is claimed here before it is
// handed to a binary, and stays claimed until that binary reports it released (its last lease
// dropped, possibly long after a timed-out detach or an asynchronous revocation). While it is
// claimed, attaching it to any surface of any binary is refused as busy, so two renderers never
// share one window. The claim lock is taken alone and never held across a call into a binary.
#include <cstdint>
#include "RnrsAbi.h"

namespace rnrs::surface {

// The table owning `key`, or null (zero key, owner 0 (unbound), unknown owner, local key 0).
const RnrsSurfaceV1* route(uint64_t key);

// Attaches the platform window `window` (+ `layer` on iOS), whose identity is `identity`, to
// `key` of `table` (from route). Claims the identity first: if another attachment holds it,
// calls `refuse(window)` (the caller's reference is released) and returns kAttachBusy. Otherwise
// the binary owns both the window and the claim from then on, whatever it returns.
int64_t attach(const RnrsSurfaceV1* table, uint64_t key, uintptr_t identity, void* window, void* layer, uint32_t width,
               uint32_t height, float scale, void (*refuse)(void* window));

// Live surfaces across every bound table (diagnostics).
uint32_t liveSurfaces();

// RnrsSurfaceRelease, given to every table at bind: ends `claim`. Any thread. Unknown or already
// released claims are ignored (logged), so a late or repeated release never ends a newer claim.
void releaseClaim(uint64_t claim);

// Windows currently claimed (tests and diagnostics).
size_t claimedWindows();

}  // namespace rnrs::surface
