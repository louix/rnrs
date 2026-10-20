#pragma once
// JSI side of RnrRuntimeIdentity.h: the identity stored with a runtime as runtime data.
#include <jsi/jsi.h>
#include <memory>
#include "RnrRuntimeIdentity.h"

namespace rnr {

// The calling runtime's identity, created on first use. Call only on a thread that may use
// `rt` (its JS thread, or with its runtime lock held), as for any JSI call.
std::shared_ptr<RuntimeIdentity> runtimeIdentity(facebook::jsi::Runtime& rt);

// Lookup only: the identity if this runtime has one, else null (diagnostics).
std::shared_ptr<RuntimeIdentity> findRuntimeIdentity(facebook::jsi::Runtime& rt);

inline RuntimeBinding bindRuntime(facebook::jsi::Runtime& rt) { return RuntimeBinding(&rt, runtimeIdentity(rt)); }

}  // namespace rnr
