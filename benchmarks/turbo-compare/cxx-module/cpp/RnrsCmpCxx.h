// Benchmark-only C++ TurboModule (RN codegen spec ../specs/NativeRnrsCmpCxx.ts): the C++ side of
// the rnrs vs C++ TurboModule comparison. Arguments and results use React Native's standard
// Bridging types; every method's algorithm matches ../../rnrs-module/rust/src/lib.rs.
#pragma once
#include <string>
#include <vector>
#if __has_include(<react/renderer/components/RnrsCmpCxxSpec/RnrsCmpCxxSpecJSI.h>)
#include <react/renderer/components/RnrsCmpCxxSpec/RnrsCmpCxxSpecJSI.h>
#elif __has_include(<ReactCodegen/RnrsCmpCxxSpecJSI.h>)
#include <ReactCodegen/RnrsCmpCxxSpecJSI.h>
#else
#include <RnrsCmpCxxSpecJSI.h>
#endif

namespace facebook::react {

using CmpPoint8 = NativeRnrsCmpCxxPoint8<double, double, double, double, double, double, double, double>;
template <>
struct Bridging<CmpPoint8> : NativeRnrsCmpCxxPoint8Bridging<CmpPoint8> {};

using CmpVec2 = NativeRnrsCmpCxxVec2<double, double>;
template <>
struct Bridging<CmpVec2> : NativeRnrsCmpCxxVec2Bridging<CmpVec2> {};

using CmpFrame = NativeRnrsCmpCxxFrame<CmpVec2, CmpVec2>;
template <>
struct Bridging<CmpFrame> : NativeRnrsCmpCxxFrameBridging<CmpFrame> {};

using CmpRgba = NativeRnrsCmpCxxRgba<double, double, double, double>;
template <>
struct Bridging<CmpRgba> : NativeRnrsCmpCxxRgbaBridging<CmpRgba> {};

using CmpNested = NativeRnrsCmpCxxNested<double, bool, CmpFrame, CmpRgba>;
template <>
struct Bridging<CmpNested> : NativeRnrsCmpCxxNestedBridging<CmpNested> {};

// The class name is the autolinking header name (react-native.config.js cxxModuleHeaderName).
class RnrsCmpCxx : public NativeRnrsCmpCxxCxxSpec<RnrsCmpCxx> {
 public:
  explicit RnrsCmpCxx(std::shared_ptr<CallInvoker> jsInvoker);

  void nop(jsi::Runtime& rt);
  double add(jsi::Runtime& rt, double a, double b);
  bool flip(jsi::Runtime& rt, bool b);
  double strLen(jsi::Runtime& rt, std::string s);
  std::string strGet(jsi::Runtime& rt, double id);
  double pointSum(jsi::Runtime& rt, CmpPoint8 p);
  CmpPoint8 pointMake(jsi::Runtime& rt, double x);
  double nestedSum(jsi::Runtime& rt, CmpNested n);
  CmpNested nestedMake(jsi::Runtime& rt, double x);
  double arrSum(jsi::Runtime& rt, std::vector<double> xs);
  std::vector<double> arrMake(jsi::Runtime& rt, double len, double x);
  double pointSumBatch(jsi::Runtime& rt, std::vector<CmpPoint8> ps);
  bool installHarness(jsi::Runtime& rt);

 private:
  // Fixture strings by id: ASCII 16 B, 1 KiB, 64 KiB, then Unicode at the same sizes.
  std::vector<std::string> strings_;
};

}  // namespace facebook::react
