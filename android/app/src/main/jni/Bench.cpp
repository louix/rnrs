// Test-only GC hook used by the Android ownership and lifetime suites.
#include "Bench.h"
#include <jsi/instrumentation.h>

using namespace facebook;

namespace facebook::react {
bool Bench::install(jsi::Runtime& rt) {
  jsi::Object lab(rt);
  lab.setProperty(rt, "collect", jsi::Function::createFromHostFunction(
    rt, jsi::PropNameID::forAscii(rt, "collect"), 0,
    [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t) {
      rt.instrumentation().collectGarbage("rnr-lifetime-tests");
      return jsi::Value::undefined();
    }));
  rt.global().setProperty(rt, "__lab", std::move(lab));
  return true;
}
}
