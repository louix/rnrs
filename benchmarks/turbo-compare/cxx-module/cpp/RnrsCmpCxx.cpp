#include "RnrsCmpCxx.h"
#include <cmath>
#include <algorithm>
#include <cstdlib>
#include <atomic>

#ifdef __APPLE__
extern "C" int rnrsCmpThermalState(void);  // ios/RnrsCmpCxxProvider.mm
#endif

namespace facebook::react {
namespace {
constexpr size_t kSizes[] = {16, 1024, 65536};

// 'a' + (i % 26) for `bytes` bytes.
std::string asciiString(size_t bytes) {
  std::string s(bytes, ' ');
  for (size_t i = 0; i < bytes; i++) s[i] = static_cast<char>('a' + i % 26);
  return s;
}

// Cycles a, é, 中, 😀 (1-4 UTF-8 bytes) while the next one fits, then pads with 'z' to exactly
// `bytes` UTF-8 bytes.
std::string unicodeString(size_t bytes) {
  static const std::string kUnits[] = {"a", "\xC3\xA9", "\xE4\xB8\xAD", "\xF0\x9F\x98\x80"};
  std::string s;
  s.reserve(bytes);
  for (size_t k = 0; s.size() + kUnits[k % 4].size() <= bytes; k++) s += kUnits[k % 4];
  while (s.size() < bytes) s += 'z';
  return s;
}

double sumPoint(const CmpPoint8& p) {
  return p.a + p.b + p.c + p.d + p.e + p.f + p.g + p.h;
}

// Handwritten JSI control (custom JSI, not a TurboModule): the scalar methods as plain host
// functions with the same argument checks as the codegen invoker (count, asNumber/asBool).
jsi::Function hostFunction(jsi::Runtime& rt, const char* name, unsigned params, jsi::HostFunctionType fn) {
  return jsi::Function::createFromHostFunction(rt, jsi::PropNameID::forAscii(rt, name), params, std::move(fn));
}
}  // namespace

RnrsCmpCxx::RnrsCmpCxx(std::shared_ptr<CallInvoker> jsInvoker) : NativeRnrsCmpCxxCxxSpec(std::move(jsInvoker)) {
  for (size_t n : kSizes) strings_.push_back(asciiString(n));
  for (size_t n : kSizes) strings_.push_back(unicodeString(n));
}

void RnrsCmpCxx::nop(jsi::Runtime&) {}

double RnrsCmpCxx::add(jsi::Runtime&, double a, double b) {
  return a + b;
}

bool RnrsCmpCxx::flip(jsi::Runtime&, bool b) {
  return !b;
}

double RnrsCmpCxx::strLen(jsi::Runtime&, std::string s) {
  return static_cast<double>(s.size());
}

std::string RnrsCmpCxx::strGet(jsi::Runtime& rt, double id) {
  if (!(std::trunc(id) == id && id >= 0 && id < static_cast<double>(strings_.size())))
    throw jsi::JSError(rt, "id must be an integer from 0 to 5");
  return strings_[static_cast<size_t>(id)];
}

double RnrsCmpCxx::pointSum(jsi::Runtime&, CmpPoint8 p) {
  return sumPoint(p);
}

CmpPoint8 RnrsCmpCxx::pointMake(jsi::Runtime&, double x) {
  return CmpPoint8{x, x + 1, x + 2, x + 3, x + 4, x + 5, x + 6, x + 7};
}

double RnrsCmpCxx::nestedSum(jsi::Runtime&, CmpNested n) {
  double visible = n.visible ? 1.0 : 0.0;
  return n.id + visible + n.frame.origin.x + n.frame.origin.y + n.frame.size.x + n.frame.size.y + n.tint.r + n.tint.g +
      n.tint.b + n.tint.a;
}

CmpNested RnrsCmpCxx::nestedMake(jsi::Runtime&, double x) {
  return CmpNested{x, true, CmpFrame{CmpVec2{x + 1, x + 2}, CmpVec2{x + 3, x + 4}}, CmpRgba{x + 5, x + 6, x + 7, x + 8}};
}

double RnrsCmpCxx::arrSum(jsi::Runtime&, std::vector<double> xs) {
  double sum = 0;
  for (double x : xs) sum += x;
  return sum;
}

std::vector<double> RnrsCmpCxx::arrMake(jsi::Runtime& rt, double len, double x) {
  if (!(std::trunc(len) == len && len >= 0 && len <= 1048576))
    throw jsi::JSError(rt, "len must be an integer from 0 to 1048576");
  size_t n = static_cast<size_t>(len);
  std::vector<double> out;
  out.reserve(n);
  for (size_t i = 0; i < n; i++) out.push_back(x + static_cast<double>(i));
  return out;
}

double RnrsCmpCxx::pointSumBatch(jsi::Runtime&, std::vector<CmpPoint8> ps) {
  double sum = 0;
  for (const auto& p : ps) sum += sumPoint(p);
  return sum;
}

bool RnrsCmpCxx::installHarness(jsi::Runtime& rt) {
  jsi::Object o(rt);
  // Independent control state: equivalent hot guards, not an rnrs adapter. The
  // runtime-data holder marks destruction even if a captured function survives it.
  struct State {
    jsi::Runtime* runtime;
    std::atomic<bool> destroyed{false}, open{true};
    explicit State(jsi::Runtime* r) : runtime(r) {}
    void check(jsi::Runtime& r) const {
      if (&r != runtime || destroyed.load(std::memory_order_acquire))
        throw jsi::JSError(r, "ERR_RNRS_FOREIGN_RUNTIME");
      if (!open.load(std::memory_order_acquire))
        throw jsi::JSError(r, "runtime adapter is closed");
    }
  };
  struct Holder {
    std::shared_ptr<State> state;
    explicit Holder(std::shared_ptr<State> s) : state(std::move(s)) {}
    ~Holder() { state->destroyed.store(true, std::memory_order_release); }
  };
  auto state = std::make_shared<State>(&rt);
  const jsi::UUID key(0x93bc2157, 0x380d, 0x471a, 0x8914, 0x52601a7b490cULL);
  rt.setRuntimeData(key, std::make_shared<Holder>(state));
  jsi::Object guarded(rt);
  guarded.setProperty(rt, "nop", hostFunction(rt, "nop", 0,
      [state](jsi::Runtime& r, const jsi::Value&, const jsi::Value*, size_t) {
        state->check(r);
        return jsi::Value::undefined();
      }));
  guarded.setProperty(rt, "add", hostFunction(rt, "add", 2,
      [state](jsi::Runtime& r, const jsi::Value&, const jsi::Value* a, size_t n) {
        state->check(r);
        if (n < 2 || !a[0].isNumber() || !a[1].isNumber())
          throw jsi::JSError(r, "add expects two numbers");
        return jsi::Value(a[0].getNumber() + a[1].getNumber());
      }));
  guarded.setProperty(rt, "flip", hostFunction(rt, "flip", 1,
      [state](jsi::Runtime& r, const jsi::Value&, const jsi::Value* a, size_t n) {
        state->check(r);
        if (n < 1 || !a[0].isBool()) throw jsi::JSError(r, "flip expects a boolean");
        return jsi::Value(!a[0].getBool());
      }));
  guarded.setProperty(rt, "close", hostFunction(rt, "close", 0,
      [state](jsi::Runtime& r, const jsi::Value&, const jsi::Value*, size_t) {
        state->check(r);
        state->open.store(false, std::memory_order_release);
        return jsi::Value::undefined();
      }));
  // Shape controls: the guarded C++ leaves behind rnrs's positional calling shape
  // (index, receiver, ...arguments, index 0 nop / 1 add / 2 flip), with rnrs's index
  // validation. callp also takes a leading helpers object; callpThis takes it as `this`.
  // They separate JS/JSI calling-shape cost from the Rust side; no rnrs state involved.
  auto shaped = [state](jsi::Runtime& r, const jsi::Value* a, size_t n) -> jsi::Value {
    state->check(r);
    if (n < 2 || n > 6 || !a[0].isNumber() || a[0].getNumber() < 0 ||
        std::floor(a[0].getNumber()) != a[0].getNumber() || a[0].getNumber() > UINT32_MAX)
      throw jsi::JSError(r, "callp needs a method index");
    switch (static_cast<uint32_t>(a[0].getNumber())) {
      case 0:
        return jsi::Value::undefined();
      case 1:
        if (n < 4 || !a[2].isNumber() || !a[3].isNumber()) throw jsi::JSError(r, "add expects two numbers");
        return jsi::Value(a[2].getNumber() + a[3].getNumber());
      case 2:
        if (n < 3 || !a[2].isBool()) throw jsi::JSError(r, "flip expects a boolean");
        return jsi::Value(!a[2].getBool());
      default:
        throw jsi::JSError(r, "unknown method");
    }
  };
  guarded.setProperty(rt, "callp", hostFunction(rt, "callp", 7,
      [shaped](jsi::Runtime& r, const jsi::Value&, const jsi::Value* a, size_t n) {
        if (n < 1 || !a[0].isObject()) throw jsi::JSError(r, "callp needs helpers");
        return shaped(r, a + 1, n - 1);
      }));
  guarded.setProperty(rt, "callpThis", hostFunction(rt, "callpThis", 6,
      [shaped](jsi::Runtime& r, const jsi::Value& self, const jsi::Value* a, size_t n) {
        if (!self.isObject()) throw jsi::JSError(r, "callpThis needs helpers as this");
        return shaped(r, a, n);
      }));
  o.setProperty(rt, "guarded", std::move(guarded));
  o.setProperty(rt, "nop", hostFunction(rt, "nop", 0, [](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
    return jsi::Value::undefined();
  }));
  o.setProperty(rt, "add", hostFunction(rt, "add", 2, [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
    if (count < 2) throw jsi::JSError(rt, "add expects 2 arguments");
    return jsi::Value(args[0].asNumber() + args[1].asNumber());
  }));
  o.setProperty(rt, "flip", hostFunction(rt, "flip", 1, [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
    if (count < 1) throw jsi::JSError(rt, "flip expects 1 argument");
    return jsi::Value(!args[0].asBool());
  }));
  // Owned conversion before the same left-to-right sum as the Rust module.
  // No adapter lifetime/runtime-origin guards: this control owns no adapter.
  o.setProperty(rt, "arrSum", hostFunction(rt, "arrSum", 1, [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
    auto typeError = [&](const std::string& message) {
      throw jsi::JSError(rt, rt.global().getPropertyAsFunction(rt, "TypeError").callAsConstructor(rt, message));
    };
    if (count < 1 || !args[0].isObject()) typeError("xs must be an array");
    auto array = args[0].getObject(rt);
    if (!array.isArray(rt)) typeError("xs must be an array");
    auto length = array.getProperty(rt, "length");
    if (!length.isNumber() || !std::isfinite(length.getNumber()) ||
        std::trunc(length.getNumber()) != length.getNumber() ||
        length.getNumber() < 0 || length.getNumber() > UINT32_MAX)
      throw jsi::JSError(rt, rt.global().getPropertyAsFunction(rt, "RangeError").callAsConstructor(rt, "invalid array length"));
    const auto n = static_cast<uint32_t>(length.getNumber());
    std::vector<double> xs;
    xs.reserve(std::min<uint32_t>(n, 4096));
    for (uint32_t i = 0; i < n; ++i) {
      auto value = array.getProperty(rt, jsi::Value(static_cast<double>(i)));
      if (!value.isNumber()) typeError("xs[" + std::to_string(i) + "] must be a number");
      xs.push_back(value.getNumber());
    }
    double sum = 0;
    for (double x : xs) sum += x;
    return jsi::Value(sum);
  }));
  // Harness helpers (never timed): environment variables (iOS run config), the OS thermal
  // state (iOS ProcessInfo; -1 elsewhere) and how this library was compiled.
  o.setProperty(rt, "env", hostFunction(rt, "env", 1, [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
    if (count < 1 || !args[0].isString()) throw jsi::JSError(rt, "env expects a name");
    const char* v = std::getenv(args[0].getString(rt).utf8(rt).c_str());
    return v ? jsi::Value(jsi::String::createFromUtf8(rt, v)) : jsi::Value::null();
  }));
  o.setProperty(rt, "thermalState", hostFunction(rt, "thermalState", 0, [](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
#ifdef __APPLE__
    return jsi::Value(rnrsCmpThermalState());
#else
    return jsi::Value(-1);
#endif
  }));
  jsi::Object build(rt);
#ifdef __OPTIMIZE__
  build.setProperty(rt, "optimize", true);
#else
  build.setProperty(rt, "optimize", false);
#endif
#ifdef NDEBUG
  build.setProperty(rt, "ndebug", true);
#else
  build.setProperty(rt, "ndebug", false);
#endif
  build.setProperty(rt, "compiler", jsi::String::createFromUtf8(rt, __VERSION__));
  o.setProperty(rt, "build", build);
  rt.global().setProperty(rt, "__rnrsCmpJsi", o);
  return true;
}

}  // namespace facebook::react
