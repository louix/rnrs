// The JNI entry points of dev.rustjsilab.rnrs.surface.RnrsSurfaceNative (@rnrs/surface's
// RnrsSurfaceView): each forwards to the binary owning the surface key (RnrsSurfaceHost.h). All
// run on the UI thread; none touches JS. This file is their only definition in the app.
#include <android/native_window_jni.h>
#include <jni.h>
#include "RnrsPlatform.h"
#include "RnrsSurfaceHost.h"

namespace {

using rnrs::surface::route;

void releaseWindow(void* window) { ANativeWindow_release(static_cast<ANativeWindow*>(window)); }

uint32_t extent(jint value) { return value > 0 ? static_cast<uint32_t>(value) : 0; }

}  // namespace

// The attachment number (positive), -1 busy (the view retries), or 0 refused (unknown or closed
// key, no window for the Surface).
extern "C" JNIEXPORT jlong JNICALL Java_dev_rustjsilab_rnrs_surface_RnrsSurfaceNative_nativeAttach(
    JNIEnv* env, jclass, jlong key, jobject surface, jint width, jint height, jfloat density) {
  const RnrsSurfaceV1* table = key > 0 ? route(static_cast<uint64_t>(key)) : nullptr;
  if (!table) return rnrs::abi::kAttachRefused;  // the view logs the refusal
  ANativeWindow* window = ANativeWindow_fromSurface(env, surface);  // one reference, ours
  if (!window) {
    rnrs::platform::log(rnrs::platform::LogLevel::Error, "surface %lld: ANativeWindow_fromSurface returned null",
                        static_cast<long long>(key));
    return rnrs::abi::kAttachRefused;
  }
  return rnrs::surface::attach(table, static_cast<uint64_t>(key), reinterpret_cast<uintptr_t>(window), window, nullptr,
                               extent(width), extent(height), density, releaseWindow);
}

// False if the attachment is not current.
extern "C" JNIEXPORT jboolean JNICALL Java_dev_rustjsilab_rnrs_surface_RnrsSurfaceNative_nativeResize(
    JNIEnv*, jclass, jlong key, jlong attachment, jint width, jint height, jfloat density) {
  const RnrsSurfaceV1* table = key > 0 && attachment > 0 ? route(static_cast<uint64_t>(key)) : nullptr;
  return table && table->resize(static_cast<uint64_t>(key), static_cast<uint64_t>(attachment), extent(width), extent(height), density);
}

// Waits (bounded) for the owning renderer to release the window; false only on timeout.
extern "C" JNIEXPORT jboolean JNICALL Java_dev_rustjsilab_rnrs_surface_RnrsSurfaceNative_nativeDetach(
    JNIEnv*, jclass, jlong key, jlong attachment, jint timeoutMs) {
  const RnrsSurfaceV1* table = key > 0 && attachment > 0 ? route(static_cast<uint64_t>(key)) : nullptr;
  return !table || table->detach(static_cast<uint64_t>(key), static_cast<uint64_t>(attachment), static_cast<uint32_t>(timeoutMs > 0 ? timeoutMs : 0));
}

// One pointer transition (rnrs-surface touch.rs phase codes); true if accepted.
extern "C" JNIEXPORT jboolean JNICALL Java_dev_rustjsilab_rnrs_surface_RnrsSurfaceNative_nativeTouch(
    JNIEnv*, jclass, jlong key, jlong attachment, jint phase, jint pointer, jfloat x, jfloat y, jlong timeMs) {
  const RnrsSurfaceV1* table = key > 0 && attachment >= 0 ? route(static_cast<uint64_t>(key)) : nullptr;
  return table && table->touch(static_cast<uint64_t>(key), static_cast<uint64_t>(attachment), phase, pointer, x, y, timeMs);
}

extern "C" JNIEXPORT jint JNICALL Java_dev_rustjsilab_rnrs_surface_RnrsSurfaceNative_nativeLiveSurfaces(JNIEnv*, jclass) {
  const uint32_t n = rnrs::surface::liveSurfaces();
  return n > INT32_MAX ? INT32_MAX : static_cast<jint>(n);
}
