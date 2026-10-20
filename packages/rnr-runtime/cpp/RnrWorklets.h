#pragma once
// Optional worklet endpoint (docs/research/worklets-poc-plan.md, W3): a sync-only, scalar-only
// entry to one module adapter that any JS runtime may call, reached by closure capture of a
// HostObject (worklets shares HostObjects by reference; undocumented upstream, checked by the
// lab tests). It is not the module adapter: no arena pool, CallInvoker, settlement or cached
// JSI value. Every value is created in the calling runtime, during the call.
#include <jsi/jsi.h>
#include <atomic>
#include <memory>
#include <string>
#include "RnrAbi.h"

namespace rnr {

// What the endpoint needs of a module adapter. `owner` keeps the adapter (and so `rust`,
// `alive` and the Rust module instance) allocated while any endpoint or boxed handle exists,
// past teardown; the last release, possibly on a UI or finalizer thread, needs no JSI but runs
// the module's Drop there (see RnrWorklets.cpp).
struct WorkletAdapterRef {
  std::shared_ptr<const void> owner;
  RnrAdapter* rust = nullptr;
  const std::atomic<bool>* alive = nullptr;  // cleared by the adapter's teardown (reload)
  uint32_t module = 0;
  uint64_t generation = 0;
  std::string name;
};

// RN runtime only (the caller checks the runtime). `methods`: IR names (`scale`,
// `Accumulator.add`); each must exist and be sync, else this throws TypeError.
facebook::jsi::Object createWorkletEndpoint(
    facebook::jsi::Runtime& rt, WorkletAdapterRef adapter, const facebook::jsi::Array& methods);

// RN runtime only. Takes ownership of `shared` (a NativeBox from rnr_native_share, of this
// adapter's module and generation) and returns a boxed handle whose allow-listed object
// methods are callable from any runtime. `endpoint` must come from createWorkletEndpoint for
// the same adapter generation, else this throws TypeError (and releases `shared`).
facebook::jsi::Object createWorkletBox(
    facebook::jsi::Runtime& rt, const WorkletAdapterRef& adapter, const facebook::jsi::Value& endpoint, void* shared);

// Process-wide endpoint diagnostics, written into `out` as properties (lifecycle()).
void writeWorkletStats(facebook::jsi::Runtime& rt, facebook::jsi::Object& out);

}  // namespace rnr
