// Optional worklet endpoint (see RnrWorklets.h). Rules, against R1-R7 of
// docs/research/worklets-integration.md:
// - R1: host functions are created in the runtime that reads them, and every value of a call
//   is created from that call's `rt`. Nothing captures a runtime, invoker or JSI value.
// - R2: shared state is immutable after creation (the method table) or atomic. The Rust
//   module and its objects are Send + Sync (rnrs-core's NativeObject bound); generated glue
//   for sync methods only reads the module instance.
// - R4: sync only. Async methods are refused when the endpoint is created; nothing settles.
// - R5: a boxed handle owns its own NativeBox (rnr_native_share), released by its destructor
//   on whatever thread finalizes the last JS object holding it, with no JSI.
// - Retention: every endpoint and box holds the whole Adapter (`owner`), so the Rust adapter
//   and its module instance stay allocated after teardown until the last endpoint or box is
//   finalized, which can be the UI runtime's GC or destruction, on the UI or a finalizer
//   thread. Module and object Drop can therefore run there, late, while the next runtime
//   generation already runs. Modules exposed through an endpoint must not block in Drop and
//   must not hold exclusive resources (files, locks, devices) that the next generation needs.
//   Generations isolate adapters, not process-wide resources.
// - R7: teardown refuses new calls only. A call checks the adapter's `alive` flag before it
//   enters Rust, and Rust checks that the adapter is open after argument conversion; a call
//   already past those checks runs to completion even if teardown happens meanwhile, and may
//   change process-shared state after teardown. There is no barrier that waits for such calls.
//   Later calls throw ERR_RNR_CLOSED. Memory stays valid through `owner`. An uncaught error
//   in a UI-thread worklet is fatal under Reanimated (rethrown as a native exception), so every
//   worklet that may outlive the RN runtime must catch it; `$open` only lets it skip calls
//   cheaply (teardown can happen between the check and the call).
// - Values: only undefined, null, booleans, numbers and boxed handles. Any other value asked
//   of or produced through the call context marks it refused (ERR_RNR_WORKLET_SHAPE).
//   Argument shapes are refused before the method runs; a refused *result* (for example a
//   string) is detected after the method ran, so methods are allow-listed by name.
// - R6 is the author's: the framework does not bound the Rust method body.
#include "RnrWorklets.h"
#include "RnrPlatform.h"
#include <chrono>
#include <optional>
#include <vector>

using namespace facebook;

namespace rnr {
namespace {

std::atomic<uint64_t> gEndpoints{0}, gBoxesCreated{0}, gBoxesReleased{0}, gBoxesReleasedOffCreator{0}, gCalls{0},
    gCallsOffCreator{0}, gRefusedClosed{0}, gRefusedShape{0}, gNextObjectId{1};
#ifdef RNR_TEST_HOOKS
// Call duration of calls off the creating thread (diagnostics; not a bound).
std::atomic<uint64_t> gOffCreatorNsTotal{0}, gOffCreatorNsMax{0};
#endif
std::atomic<uint32_t> gEpoch{0x80000000u};

struct Method {
  std::string prop;  // JS property: `scale`, or `add` for `Accumulator.add`
  std::string spec;  // "" for module methods, else the native object's spec name
  uint32_t index = 0;
};

struct EndpointState {
  WorkletAdapterRef adapter;
  std::vector<Method> methods;  // immutable after creation
  platform::ThreadId creator = platform::currentThread();
  uint64_t id = gNextObjectId++;
  const Method* find(const std::string& spec, const std::string& prop) const {
    for (const auto& m : methods)
      if (m.spec == spec && m.prop == prop) return &m;
    return nullptr;
  }
};

[[noreturn]] void throwCoded(jsi::Runtime& rt, const char* ctor, const std::string& message, const char* code) {
  auto error = rt.global().getPropertyAsFunction(rt, ctor).callAsConstructor(rt, jsi::String::createFromUtf8(rt, message));
  error.getObject(rt).setProperty(rt, "code", jsi::String::createFromAscii(rt, code));
  throw jsi::JSError(rt, std::move(error));
}

class WorkletEndpoint;

// A boxed native handle: the object of one RN-runtime wrapper, owned independently of it.
class WorkletBox : public jsi::HostObject, public std::enable_shared_from_this<WorkletBox> {
 public:
  WorkletBox(std::shared_ptr<const EndpointState> e, void* n, std::string s)
      : ep(std::move(e)), native(n), spec(std::move(s)) {
    gBoxesCreated++;
  }
  ~WorkletBox() override {
    gBoxesReleased++;
    if (platform::currentThread() != creator) gBoxesReleasedOffCreator++;
    rnr_native_release(native);  // thread-safe; no JSI
  }
  jsi::Value get(jsi::Runtime& rt, const jsi::PropNameID& name) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime& rt) override;

  const std::shared_ptr<const EndpointState> ep;
  void* const native;
  const std::string spec;
  const platform::ThreadId creator = platform::currentThread();
  const uint64_t id = gNextObjectId++;
};

class WorkletEndpoint : public jsi::HostObject {
 public:
  explicit WorkletEndpoint(std::shared_ptr<const EndpointState> e) : ep(std::move(e)) {}
  jsi::Value get(jsi::Runtime& rt, const jsi::PropNameID& name) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime& rt) override;
  const std::shared_ptr<const EndpointState> ep;
};

// One endpoint call, on the calling runtime's thread. Values live in a fixed inline array.
struct WorkletCall {
  static constexpr uint32_t kSlots = 12;
  WorkletCall(jsi::Runtime& r, const EndpointState& e) : rt(r), ep(e) {}
  jsi::Runtime& rt;
  const EndpointState& ep;
  const uint32_t epoch = gEpoch.fetch_add(1, std::memory_order_relaxed);
  jsi::Value slots[kSlots];
  uint32_t used = 0;
  uint32_t receiver = UINT32_MAX;
  const void* receiverNative = nullptr;
  bool refused = false;
  uint32_t push(jsi::Value v) {
    if (used == kSlots) {
      refused = true;
      return 0;
    }
    slots[used] = std::move(v);
    return used++;
  }
  jsi::Value& at(uint32_t i) { return slots[i < used ? i : 0]; }
  uint32_t refuse() {
    refused = true;
    return push(jsi::Value::undefined());
  }
};

WorkletCall& W(void* raw) { return *static_cast<WorkletCall*>(raw); }

bool isBox(jsi::Runtime& rt, const jsi::Value& v) {
  return v.isObject() && v.getObject(rt).isHostObject<WorkletBox>(rt);
}

const JsiVTable kWorkletVTable = {
    [](void* raw, uint32_t v) -> uint32_t {
      try {
        auto& c = W(raw);
        if (v == c.receiver) return 7;  // its slot holds an undefined placeholder
        auto& x = c.at(v);
        if (x.isUndefined()) return 0;
        if (x.isNull()) return 1;
        if (x.isBool()) return 2;
        if (x.isNumber()) return 3;
        if (isBox(c.rt, x)) return 7;
        return 8;  // strings, records, arrays, functions: unsupported here
      } catch (...) {
        return 8;
      }
    },
    [](void* raw, uint32_t v) -> double { auto& x = W(raw).at(v); return x.isNumber() ? x.getNumber() : 0; },
    [](void* raw, uint32_t v) -> bool { auto& x = W(raw).at(v); return x.isBool() && x.getBool(); },
    [](void* raw, uint32_t, const char*, size_t, uint32_t*) -> bool { W(raw).refused = true; return false; },
    [](void* raw, uint32_t, double*) -> bool { W(raw).refused = true; return false; },
    [](void* raw, uint32_t, uint32_t, uint32_t*) -> bool { W(raw).refused = true; return false; },
    [](void* raw) -> uint32_t { return W(raw).push(jsi::Value::undefined()); },
    [](void* raw) -> uint32_t { return W(raw).push(jsi::Value::null()); },
    [](void* raw, double d) -> uint32_t { return W(raw).push(jsi::Value(d)); },
    [](void* raw, bool b) -> uint32_t { return W(raw).push(jsi::Value(b)); },
    [](void* raw, const char*, size_t) -> uint32_t { return W(raw).refuse(); },
    [](void* raw) -> uint32_t { return W(raw).refuse(); },
    [](void* raw, uint32_t, const char*, size_t, uint32_t) -> bool { W(raw).refused = true; return false; },
    [](void* raw, uint32_t) -> uint32_t { return W(raw).refuse(); },
    [](void* raw, uint32_t, uint32_t, uint32_t) -> bool { W(raw).refused = true; return false; },
    // wrapNative: not adopted (Rust releases the object).
    [](void* raw, void*, uint32_t*) -> bool { W(raw).refused = true; return false; },
    [](void* raw, uint32_t v, const void** out) -> uint32_t {
      try {
        auto& c = W(raw);
        if (v == c.receiver) {
          *out = c.receiverNative;
          return 0;
        }
        auto& x = c.at(v);
        if (!isBox(c.rt, x)) return 1;
        auto box = x.getObject(c.rt).getHostObject<WorkletBox>(c.rt);
        if (box->ep->adapter.module != c.ep.adapter.module) return 1;
        if (box->ep->adapter.generation != c.ep.adapter.generation || !c.ep.adapter.alive->load()) return 2;
        *out = box->native;  // the box is rooted by its JS object in this call's slots
        return 0;
      } catch (...) {
        return 1;
      }
    },
    [](void* raw, uint32_t, uint8_t* (*)(void*, size_t), void*) -> uint32_t { W(raw).refused = true; return 1; },
    // newBytes: the storage is ours now; release it and refuse.
    [](void* raw, uint8_t* ptr, size_t len, size_t cap, uint32_t* out) {
      rnr_bytes_free(ptr, len, cap);
      *out = W(raw).refuse();
    },
    [](void* raw, uint32_t, uint8_t* (*)(void*, size_t), void*) -> size_t { W(raw).refused = true; return 0; },
};

jsi::Value invoke(jsi::Runtime& rt, const EndpointState& ep, const Method& m, const void* receiverNative, const jsi::Value* a, size_t n) {
  if (!ep.adapter.alive->load(std::memory_order_acquire)) {
    gRefusedClosed++;
    throwCoded(rt, "Error", "rnr: " + ep.adapter.name + " is closed (its React Native runtime was torn down or reloaded)", "ERR_RNR_CLOSED");
  }
  if (n > 4) {
    gRefusedShape++;
    throwCoded(rt, "TypeError", m.prop + ": worklet endpoint methods take at most 4 arguments", "ERR_RNR_WORKLET_SHAPE");
  }
  bool offCreator = platform::currentThread() != ep.creator;
  gCalls++;
  if (offCreator) gCallsOffCreator++;
#ifdef RNR_TEST_HOOKS
  auto started = std::chrono::steady_clock::now();
#endif
  WorkletCall c(rt, ep);
  uint32_t self = c.push(jsi::Value::undefined());
  if (receiverNative) {
    c.receiver = self;
    c.receiverNative = receiverNative;
  }
  uint32_t args[4];
  for (size_t i = 0; i < n; i++) args[i] = c.push(jsi::Value(rt, a[i]));
  uint32_t out = 0, kind = 0;
  char error[256];
  error[0] = 0;
  uint32_t status = rnr_adapter_call(ep.adapter.rust, &kWorkletVTable, &c, c.epoch, m.index, self, args, n, &out, &kind, error, sizeof error);
#ifdef RNR_TEST_HOOKS
  if (offCreator) {
    auto ns = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - started).count());
    gOffCreatorNsTotal += ns;
    for (uint64_t max = gOffCreatorNsMax.load(); ns > max && !gOffCreatorNsMax.compare_exchange_weak(max, ns);) {}
  }
#endif
  if (c.refused) {
    gRefusedShape++;
    throwCoded(rt, "TypeError", m.prop + ": worklet endpoints pass only numbers, booleans, undefined, null and boxed native handles", "ERR_RNR_WORKLET_SHAPE");
  }
  if (status == 0) return std::move(c.at(out));
  if (!ep.adapter.alive->load(std::memory_order_acquire)) {
    gRefusedClosed++;
    throwCoded(rt, "Error", "rnr: " + ep.adapter.name + " is closed (its React Native runtime was torn down or reloaded)", "ERR_RNR_CLOSED");
  }
  if (status == 1) {
    const char* ctor = kind == 0 ? "TypeError" : kind == 1 ? "RangeError" : "Error";
    throw jsi::JSError(rt, rt.global().getPropertyAsFunction(rt, ctor).callAsConstructor(rt, jsi::String::createFromUtf8(rt, error)));
  }
  throw jsi::JSError(rt, "native call failed");  // no JS ran, so nothing was thrown
}

jsi::Function method(jsi::Runtime& rt, const jsi::PropNameID& name, jsi::HostFunctionType f) {
  return jsi::Function::createFromHostFunction(rt, name, 0, std::move(f));
}

jsi::Value WorkletBox::get(jsi::Runtime& rt, const jsi::PropNameID& name) {
  auto prop = name.utf8(rt);
  if (prop == "$id") return static_cast<double>(id);
  if (prop == "$open") return ep->adapter.alive->load(std::memory_order_acquire);
  if (prop == "$spec") return jsi::String::createFromUtf8(rt, spec);
  const Method* m = ep->find(spec, prop);
  if (!m) return jsi::Value::undefined();
  return method(rt, name, [self = shared_from_this(), m](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
    return invoke(rt, *self->ep, *m, self->native, a, n);
  });
}

std::vector<jsi::PropNameID> WorkletBox::getPropertyNames(jsi::Runtime& rt) {
  std::vector<jsi::PropNameID> names;
  for (const auto& m : ep->methods)
    if (m.spec == spec) names.push_back(jsi::PropNameID::forUtf8(rt, m.prop));
  return names;
}

jsi::Value WorkletEndpoint::get(jsi::Runtime& rt, const jsi::PropNameID& name) {
  auto prop = name.utf8(rt);
  if (prop == "$id") return static_cast<double>(ep->id);
  if (prop == "$open") return ep->adapter.alive->load(std::memory_order_acquire);
  const Method* m = ep->find("", prop);
  if (!m) return jsi::Value::undefined();
  return method(rt, name, [state = ep, m](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
    return invoke(rt, *state, *m, nullptr, a, n);
  });
}

std::vector<jsi::PropNameID> WorkletEndpoint::getPropertyNames(jsi::Runtime& rt) {
  std::vector<jsi::PropNameID> names;
  for (const auto& m : ep->methods)
    if (m.spec.empty()) names.push_back(jsi::PropNameID::forUtf8(rt, m.prop));
  return names;
}

}  // namespace

jsi::Object createWorkletEndpoint(jsi::Runtime& rt, WorkletAdapterRef adapter, const jsi::Array& methods) {
  auto ep = std::make_shared<EndpointState>();
  ep->adapter = std::move(adapter);
  size_t count = methods.size(rt);
  if (count == 0 || count > 64) throwCoded(rt, "TypeError", "workletEndpoint: list 1 to 64 method names", "ERR_RNR_WORKLET_SHAPE");
  for (size_t i = 0; i < count; i++) {
    auto v = methods.getValueAtIndex(rt, i);
    if (!v.isString()) throwCoded(rt, "TypeError", "workletEndpoint: method names must be strings", "ERR_RNR_WORKLET_SHAPE");
    auto name = v.getString(rt).utf8(rt);
    uint32_t index = 0;
    bool isAsync = false;
    if (!rnr_adapter_method_find(ep->adapter.rust, name.data(), name.size(), &index, &isAsync))
      throwCoded(rt, "TypeError", "workletEndpoint: " + ep->adapter.name + " has no method " + name, "ERR_RNR_WORKLET_SHAPE");
    if (isAsync)
      throwCoded(rt, "TypeError", "workletEndpoint: " + name + " is async; worklet endpoints are sync-only (no Promises off the React Native runtime)", "ERR_RNR_WORKLET_ASYNC");
    Method m;
    m.index = index;
    auto dot = name.find('.');
    if (dot == std::string::npos) {
      m.prop = name;
    } else {
      m.spec = name.substr(0, dot);
      m.prop = name.substr(dot + 1);
    }
    if (m.prop.empty() || m.prop[0] == '$') throwCoded(rt, "TypeError", "workletEndpoint: invalid method name " + name, "ERR_RNR_WORKLET_SHAPE");
    if (!ep->find(m.spec, m.prop)) ep->methods.push_back(std::move(m));
  }
  gEndpoints++;
  return jsi::Object::createFromHostObject(rt, std::make_shared<WorkletEndpoint>(ep));
}

jsi::Object createWorkletBox(jsi::Runtime& rt, const WorkletAdapterRef& adapter, const jsi::Value& endpoint, void* shared) {
  struct Owned {
    void* p;
    ~Owned() {
      if (p) rnr_native_release(p);
    }
  } owned{shared};
  if (!endpoint.isObject() || !endpoint.getObject(rt).isHostObject<WorkletEndpoint>(rt))
    throwCoded(rt, "TypeError", "workletBox: expected a worklet endpoint of this module", "ERR_RNR_WORKLET_SHAPE");
  auto ep = endpoint.getObject(rt).getHostObject<WorkletEndpoint>(rt)->ep;
  if (ep->adapter.module != adapter.module || ep->adapter.generation != adapter.generation)
    throwCoded(rt, "TypeError", "workletBox: the endpoint belongs to another module or adapter generation", "ERR_RNR_WORKLET_SHAPE");
  size_t len = 0;
  const char* specName = rnr_native_spec_name(shared, &len);
  std::string spec(specName, len);
  bool any = false;
  for (const auto& m : ep->methods) any = any || m.spec == spec;
  if (!any) throwCoded(rt, "TypeError", "workletBox: no " + spec + " method is allow-listed on this endpoint", "ERR_RNR_WORKLET_SHAPE");
  auto box = std::make_shared<WorkletBox>(ep, owned.p, std::move(spec));
  owned.p = nullptr;  // the box owns it now
  return jsi::Object::createFromHostObject(rt, std::move(box));
}

void writeWorkletStats(jsi::Runtime& rt, jsi::Object& out) {
  auto set = [&](const char* k, const std::atomic<uint64_t>& v) { out.setProperty(rt, k, static_cast<double>(v.load())); };
  set("workletEndpoints", gEndpoints);
  set("workletBoxesCreated", gBoxesCreated);
  set("workletBoxesReleased", gBoxesReleased);
  set("workletBoxesReleasedOffCreator", gBoxesReleasedOffCreator);
  set("workletCalls", gCalls);
  set("workletCallsOffCreator", gCallsOffCreator);
  set("workletRefusedClosed", gRefusedClosed);
  set("workletRefusedShape", gRefusedShape);
#ifdef RNR_TEST_HOOKS
  set("workletOffCreatorNsTotal", gOffCreatorNsTotal);
  set("workletOffCreatorNsMax", gOffCreatorNsMax);
#endif
}

}  // namespace rnr
