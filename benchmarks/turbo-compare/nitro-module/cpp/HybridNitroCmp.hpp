// Benchmark-only Nitro HybridObject (pure C++): the same operations as the rnrs module, the C++
// TurboModule and the handwritten JSI controls. Argument conversion and validation are Nitro's
// own (generated HybridNitroCmpSpec + JSIConverter); nothing here adds or removes checks.
#pragma once
#include "HybridNitroCmpSpec.hpp"

namespace margelo::nitro::rnrscmp {

class HybridNitroCmp : public HybridNitroCmpSpec {
 public:
  HybridNitroCmp() : HybridObject(TAG) {}

  void nop() override {}
  double add(double a, double b) override { return a + b; }
  bool flip(bool b) override { return !b; }
  double arrSum(const std::vector<double>& xs) override {
    double sum = 0;
    for (double x : xs) sum += x;
    return sum;
  }
};

}  // namespace margelo::nitro::rnrscmp
