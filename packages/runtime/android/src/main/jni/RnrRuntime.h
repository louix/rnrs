#pragma once
// JNI side of the Android RnrRuntime lifecycle module (see docs/prototype.md). The runtime
// bindings themselves are shared with iOS (../../../../cpp/RnrBindings.h).
namespace rnr {

// Called from JNI_OnLoad.
void registerRuntimeNatives();

}  // namespace rnr
