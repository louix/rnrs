// JNI entry of the framework library (librnr.so): registers the lifecycle module's natives.
#include <fbjni/fbjni.h>
#include "RnrRuntime.h"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, [] { rnr::registerRuntimeNatives(); });
}
