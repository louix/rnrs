// JNI entry of the framework library (librnrs.so): registers the lifecycle module's natives.
#include <fbjni/fbjni.h>
#include "RnrsRuntime.h"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, [] { rnrs::registerRuntimeNatives(); });
}
