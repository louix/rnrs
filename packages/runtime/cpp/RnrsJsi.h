#pragma once
#include <ReactCommon/CallInvoker.h>
#include <jsi/jsi.h>
#include <memory>
#include <string>
#include "RnrsPlatform.h"
#include "RnrsScope.h"

namespace rnrs {
// Framework JSI adapter, generic over modules: creates one adapter generation of the linked
// module `name` (checked against the JS wrapper's IR `hash`, see RnrsRegistry.h) bound to this
// runtime and registered with its lifecycle scope. Module code never touches JSI; it
// converts values through the vtable in RnrsJsi.cpp (see rust/rnrs-android).
facebook::jsi::Object installModuleAdapter(
    facebook::jsi::Runtime& rt, std::shared_ptr<facebook::react::CallInvoker> invoker,
    std::shared_ptr<RuntimeScope> scope, const std::string& name, const std::string& hash, double maxInFlight);

// Throws `Error` with code ERR_RNRS_FOREIGN_RUNTIME, created in the calling runtime `rt`.
// Framework host functions bound to one runtime call this, before touching any state, when
// a copy of them is called from another runtime.
[[noreturn]] void throwForeignRuntime(facebook::jsi::Runtime& rt, const std::string& what);

#ifdef RNRS_TEST_HOOKS
// Test hook: make ArrayBuffer results take the copy fallback, as if the engine refused
// external storage, so that path can be exercised on an engine that never refuses.
void setForceBytesCopyOutForTesting(bool force);
// Test hook: number[] results throw after the first native element write, between the
// prototype detach and its restore, so failure before publication can be exercised.
void setFailNumberFillForTesting(bool fail);
#endif
}  // namespace rnrs
