#pragma once
#include <string>
// App-only codegen for the lifetime suite GC hook.
#if __has_include(<react/renderer/components/LabSpecs/LabSpecsJSI.h>)
#include <react/renderer/components/LabSpecs/LabSpecsJSI.h>
#elif __has_include(<LabSpecs/LabSpecsJSI.h>)
#include <LabSpecs/LabSpecsJSI.h>
#else
#include <LabSpecsJSI.h>
#endif
namespace facebook::react {
class Bench : public NativeBenchCxxSpec<Bench> {
public:
  explicit Bench(std::shared_ptr<CallInvoker> invoker) : NativeBenchCxxSpec(std::move(invoker)) {}
  bool install(jsi::Runtime&);
};
}
