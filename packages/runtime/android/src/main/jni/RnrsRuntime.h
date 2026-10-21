#pragma once
// JNI side of the Android RnrsRuntime lifecycle module. The runtime
// bindings themselves are shared with iOS (../../../../cpp/RnrsBindings.h).
namespace rnrs {

// Called from JNI_OnLoad.
void registerRuntimeNatives();

}  // namespace rnrs
