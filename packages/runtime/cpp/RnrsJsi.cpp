// Framework JSI adapter (handwritten, module-independent). Ownership rules:
// - Rust workers never see JSI values or the runtime; they only call notify(), which posts
//   a task through the CallInvoker. JSI is used only on the JS thread; teardown is the one
//   adapter operation that may run elsewhere, and it never touches JSI.
// - Generated module glue converts values through the vtable below, during one host-function
//   call (or one drain). Values live in that call's arena and are addressed by index; Rust
//   rejects indices from another call (epoch check). Nothing JSI-related outlives the call.
// - Property semantics come from framework JS helpers (packages/runtime/src/runtime.ts, captured when that
//   module initializes) passed with every call: own-property reads, own data-property
//   definitions, Array.isArray and `length`. JSI alone has no own-property read or define.
// - JS promise state lives in JS (packages/runtime/src/runtime.ts). Drains settle by calling the global
//   __rnrsSettle on the JS thread, so no jsi::Value is retained natively.
// - A native object's JS wrapper owns one Rust `NativeBox` via NativeState; GC finalization
//   or dispose() releases it (thread-safe). In-flight operations hold their own owners.
// - Teardown (lifecycle scope invalidation, the explicit test hook, a refused registration,
//   or the destructor fallback) is idempotent and never blocks.
#include "RnrsJsi.h"
#include "RnrsAbi.h"
#include "RnrsDelivery.h"
#include "RnrsRuntimeIdentityJsi.h"
#include "RnrsWorklets.h"
#include "Utf8Encoder.h"
#include <atomic>
#include <cmath>
#include <cstring>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <utility>
#include <vector>

using namespace facebook;

namespace rnrs {
namespace {
constexpr uint32_t kTeardownExplicit = 0, kTeardownLifecycle = 1, kTeardownDestructor = 2, kTeardownRefused = 3;
constexpr uint32_t kCallOk = 0, kCallError = 1, kCallThrown = 2;
constexpr double kMaxSafeInteger = 9007199254740991.0;

// Diagnostics: which thread runs NativeState finalizers relative to the JS thread.
std::atomic<uint64_t> gFinalizers{0}, gFinalizersOffJsThread{0};
// ArrayBuffer results: adopted Rust storage released, released off the JS thread, and
// results copied because the engine refused external storage.
std::atomic<uint64_t> gBytesFinalizedOffJsThread{0}, gBytesCopiedOut{0};
std::atomic<bool> gForceBytesCopyOut{false};  // set only by the RNRS_TEST_HOOKS hook
#ifdef RNRS_DIAGNOSTICS
// Attribution counters (diagnostics builds only): call contexts, helper lookups (property
// reads of the helpers object), helper uses, arena pushes.
std::atomic<uint64_t> gDiagContexts{0}, gDiagHelperLookups{0}, gDiagHelperUses{0}, gDiagArenaPushes{0};
#define RNRS_DIAG(counter) (counter)++
#else
#define RNRS_DIAG(counter) ((void)0)
#endif

// A Rust Vec<u8> owned by a JS ArrayBuffer. The engine destroys it when the ArrayBuffer is
// collected or the runtime is destroyed, possibly off the JS thread; the release is a
// thread-safe Rust drop. JS may read and write the bytes; Rust keeps no access to them.
struct RustBytes : jsi::MutableBuffer {
  uint8_t* ptr;
  size_t len, cap;
  platform::ThreadId jsThread = platform::currentThread();
  RustBytes(uint8_t* p, size_t l, size_t c) : ptr(p), len(l), cap(c) {}
  ~RustBytes() override {
    if (platform::currentThread() != jsThread) gBytesFinalizedOffJsThread++;
    rnrs_bytes_free(ptr, len, cap);
  }
  size_t size() const override { return len; }
  uint8_t* data() override { return ptr; }
};
std::atomic<uint32_t> gEpoch{1};

struct Adapter {
  RnrsAdapter* rust = nullptr;
  uint32_t module = 0;  // bundle index: wrappers of other modules are a type mismatch
  uint64_t generation = 0;
  std::string name;
  std::shared_ptr<RuntimeScope> scope;
  // The runtime this adapter was installed in. Every host function checks it first, so a
  // copy of one in another runtime (a worklet capture) is refused before it touches
  // arenaPool, the invoker or any value.
  std::optional<RuntimeBinding> runtime;
  // Cleared by the first teardown, which may run on React Native's background thread once the
  // JS thread has stopped; read on the JS thread before every JSI use.
  std::atomic<bool> alive{true};
  // Empty value arenas kept for reuse by later calls (JS thread only; they never hold
  // values: CallCtx clears an arena before returning it, and they are freed with the
  // adapter on any thread as plain empty vectors).
  std::vector<std::vector<jsi::Value>> arenaPool;

  // Any thread; no JSI.
  bool teardown(uint32_t reason) {
    if (!alive.exchange(false)) return false;
    rnrs_adapter_teardown(rust, reason);
    return true;
  }
  ~Adapter() {
    noteAdapterDestroyed(*scope);
    if (rust) {
      teardown(kTeardownDestructor);  // fallback only: normally already torn down
      rnrs_adapter_free(rust);
    }
  }
  void drain(jsi::Runtime& rt);
};

// A wrapper's ownership of one Rust NativeBox.
struct HandleState : jsi::NativeState {
  void* native;
  uint32_t module;
  uint64_t generation;
  platform::ThreadId jsThread = platform::currentThread();  // constructed on the JS thread
  HandleState(void* n, uint32_t m, uint64_t g) : native(n), module(m), generation(g) {}
  ~HandleState() override {
    gFinalizers++;
    if (platform::currentThread() != jsThread) gFinalizersOffJsThread++;
    if (native) rnrs_native_release(native);  // thread-safe
  }
};

// One host-function call (or drain) on the JS thread.
struct CallCtx {
  jsi::Runtime& rt;
  Adapter& adapter;
  uint32_t epoch = gEpoch++;
  std::vector<jsi::Value> arena;
  std::optional<jsi::JSError> thrown;
  std::optional<jsi::Function> settle;
  std::optional<jsi::Object> helpers;
  // The helpers argument of the host call in progress: turned into `helpers` only when a
  // helper is first needed (scalar and string calls need none). Valid for the whole call,
  // which this context never outlives.
  const jsi::Value* helpersArg = nullptr;
  std::optional<jsi::Function> readOwn, define, isArray, length, bufferKind, allocBuffer;
  CallCtx(jsi::Runtime& r, Adapter& a) : rt(r), adapter(a) {
    RNRS_DIAG(gDiagContexts);
    if (!adapter.arenaPool.empty()) {
      arena = std::move(adapter.arenaPool.back());
      adapter.arenaPool.pop_back();
    } else {
      arena.reserve(16);
    }
  }
  ~CallCtx() {
    arena.clear();  // the values are released here, on the JS thread, as before
    if (adapter.arenaPool.size() < 4 && arena.capacity() <= 4096) adapter.arenaPool.push_back(std::move(arena));
  }
  CallCtx(const CallCtx&) = delete;
  CallCtx& operator=(const CallCtx&) = delete;
  jsi::Function& helper(std::optional<jsi::Function>& slot, const char* name) {
    RNRS_DIAG(gDiagHelperUses);
    if (!slot) {
      RNRS_DIAG(gDiagHelperLookups);
      if (!helpers && helpersArg) helpers = helpersArg->getObject(rt);
      if (!helpers) throw jsi::JSError(rt, "rnrs: conversion helpers missing");
      slot = helpers->getPropertyAsFunction(rt, name);
    }
    return *slot;
  }
  uint32_t push(jsi::Value v) {
    RNRS_DIAG(gDiagArenaPushes);
    arena.push_back(std::move(v));
    return static_cast<uint32_t>(arena.size() - 1);
  }
  jsi::Value& at(uint32_t i) { return arena.at(i); }
  jsi::PropNameID key(const char* p, size_t n) {
    return jsi::PropNameID::forUtf8(rt, reinterpret_cast<const uint8_t*>(p), n);
  }
};

CallCtx& C(void* raw) { return *static_cast<CallCtx*>(raw); }

// No C++ exception may unwind into Rust frames (undefined behaviour). Fallible entries keep
// JS exceptions in the context (reported as `false`) and convert anything else the same way.
template <typename F>
bool guarded(CallCtx& c, F&& f) noexcept {
  try {
    f();
    return true;
  } catch (const jsi::JSError& e) {
    c.thrown = e;
  } catch (const std::exception& e) {
    try { c.thrown = jsi::JSError(c.rt, std::string("native conversion failed: ") + e.what()); } catch (...) {}
  } catch (...) {
    try { c.thrown = jsi::JSError(c.rt, "native conversion failed"); } catch (...) {}
  }
  return false;
}

// Infallible entries (value creation, reads after a kind check) have no error channel: a
// failure there (out of memory, engine invariant) aborts rather than unwind into Rust.
template <typename F>
auto noUnwind(const char* what, F&& f) noexcept -> decltype(f()) {
  try {
    return f();
  } catch (const std::exception& e) {
    platform::log(platform::LogLevel::Fatal, "%s failed: %s", what, e.what());
  } catch (...) {
    platform::log(platform::LogLevel::Fatal, "%s failed", what);
  }
  std::abort();
}

const JsiVTable kVTable = {
    [](void* raw, uint32_t v) -> uint32_t {
     // Any exception (JSI isArray on a revoked proxy throws) reads as an unsupported value.
     try {
      auto& c = C(raw);
      auto& x = c.at(v);
      if (x.isUndefined()) return 0;
      if (x.isNull()) return 1;
      if (x.isBool()) return 2;
      if (x.isNumber()) return 3;
      if (x.isString()) return 4;
      if (x.isObject()) {
        auto o = x.getObject(c.rt);
        if (o.isArray(c.rt)) return 5;
        if (o.isFunction(c.rt)) return 6;
        // Array.isArray semantics (proxies of arrays are arrays); a throwing check (a revoked
        // proxy) reads as an unsupported value.
        try {
          if (c.helper(c.isArray, "isArray").call(c.rt, jsi::Value(c.rt, x)).getBool()) return 5;
        } catch (const std::exception&) {
          return 8;
        }
        return 7;
      }
      return 8;  // symbol, bigint
     } catch (...) {
      return 8;
     }
    },
    [](void* raw, uint32_t v) -> double { return noUnwind("toNumber", [&] { return C(raw).at(v).getNumber(); }); },
    [](void* raw, uint32_t v) -> bool { return noUnwind("toBool", [&] { return C(raw).at(v).getBool(); }); },
    [](void* raw, uint32_t o, const char* k, size_t n, uint32_t* out) -> bool {
      auto& c = C(raw);
      return guarded(c, [&] {
        auto key = jsi::String::createFromUtf8(c.rt, reinterpret_cast<const uint8_t*>(k), n);
        *out = c.push(c.helper(c.readOwn, "readOwn").call(c.rt, jsi::Value(c.rt, c.at(o)), std::move(key)));
      });
    },
    [](void* raw, uint32_t a, double* out) -> bool {
      auto& c = C(raw);
      return guarded(c, [&] {
        auto v = c.helper(c.length, "length").call(c.rt, jsi::Value(c.rt, c.at(a)));
        *out = v.isNumber() ? v.getNumber() : std::nan("");  // Rust rejects non-integers
      });
    },
    [](void* raw, uint32_t a, uint32_t i, uint32_t* out) -> bool {
      auto& c = C(raw);
      return guarded(c, [&] { *out = c.push(c.helper(c.readOwn, "readOwn").call(c.rt, jsi::Value(c.rt, c.at(a)), static_cast<double>(i))); });
    },
    [](void* raw) -> uint32_t { return noUnwind("undefined", [&] { return C(raw).push(jsi::Value::undefined()); }); },
    [](void* raw) -> uint32_t { return noUnwind("null", [&] { return C(raw).push(jsi::Value::null()); }); },
    [](void* raw, double d) -> uint32_t { return noUnwind("number", [&] { return C(raw).push(jsi::Value(d)); }); },
    [](void* raw, bool b) -> uint32_t { return noUnwind("boolean", [&] { return C(raw).push(jsi::Value(b)); }); },
    [](void* raw, const char* p, size_t n) -> uint32_t {
      return noUnwind("string", [&] {
        auto& c = C(raw);
        return c.push(jsi::String::createFromUtf8(c.rt, reinterpret_cast<const uint8_t*>(p), n));
      });
    },
    [](void* raw) -> uint32_t {
      return noUnwind("object", [&] {
        auto& c = C(raw);
        return c.push(jsi::Object(c.rt));
      });
    },
    [](void* raw, uint32_t o, const char* k, size_t n, uint32_t v) -> bool {
      auto& c = C(raw);
      return guarded(c, [&] {
        auto key = jsi::String::createFromUtf8(c.rt, reinterpret_cast<const uint8_t*>(k), n);
        c.helper(c.define, "define").call(c.rt, jsi::Value(c.rt, c.at(o)), std::move(key), jsi::Value(c.rt, c.at(v)));
      });
    },
    [](void* raw, uint32_t n) -> uint32_t {
      return noUnwind("array", [&] {
        auto& c = C(raw);
        return c.push(jsi::Array(c.rt, n));
      });
    },
    [](void* raw, uint32_t a, uint32_t i, uint32_t v) -> bool {
      auto& c = C(raw);
      return guarded(c, [&] {
        c.helper(c.define, "define").call(c.rt, jsi::Value(c.rt, c.at(a)), static_cast<double>(i), jsi::Value(c.rt, c.at(v)));
      });
    },
    [](void* raw, void* native, uint32_t* out) -> bool {
      auto& c = C(raw);
      if (!c.adapter.alive.load()) return false;  // not adopted: Rust releases the box
      // Once HandleState exists it owns the box, so no failure may report "not adopted".
      return noUnwind("wrapNative", [&] {
        jsi::Object wrapper(c.rt);
        wrapper.setNativeState(c.rt, std::make_shared<HandleState>(native, c.adapter.module, c.adapter.generation));
        *out = c.push(std::move(wrapper));
        return true;
      });
    },
    [](void* raw, uint32_t v, const void** out) -> uint32_t {
     try {
      auto& c = C(raw);
      auto& x = c.at(v);
      if (!x.isObject()) return 1;
      auto o = x.getObject(c.rt);
      if (!o.hasNativeState<HandleState>(c.rt)) return 1;
      auto state = o.getNativeState<HandleState>(c.rt);
      if (state->module != c.adapter.module) return 1;
      if (state->generation != c.adapter.generation || !c.adapter.alive.load()) return 2;
      if (!state->native) return 3;
      *out = state->native;  // owned by the wrapper, which the arena keeps alive
      return 0;
     } catch (...) {
      return 1;  // not a wrapper we can read
     }
    },
    [](void* raw, uint32_t v, uint8_t* (*alloc)(void*, size_t), void* allocCtx) -> uint32_t {
      auto& c = C(raw);
      try {
        // Brand checks (view, shared, resizable, detached) through the framework helper;
        // after it no JS runs until the copy is complete, so JS cannot change the buffer
        // in between. Writers outside JS (native code holding the storage) are not excluded.
        auto status = c.helper(c.bufferKind, "bufferKind").call(c.rt, jsi::Value(c.rt, c.at(v)));
        if (!status.isNumber()) return 1;
        auto code = static_cast<uint32_t>(status.getNumber());
        if (code != 0) return code;
        auto& x = c.at(v);
        if (!x.isObject() || !x.getObject(c.rt).isArrayBuffer(c.rt)) return 1;  // must agree with the helper
        auto buffer = x.getObject(c.rt).getArrayBuffer(c.rt);
        size_t n = buffer.size(c.rt);
        uint8_t* src = n ? buffer.data(c.rt) : nullptr;
        if (n && !src) return 4;  // no storage: treat as detached
        uint8_t* dst = alloc(allocCtx, n);
        if (n && !dst) return 7;  // the copy's storage could not be allocated
        if (n) std::memcpy(dst, src, n);  // never memcpy with a null pointer, even for 0 bytes
        return 0;
      } catch (const jsi::JSError& e) {
        c.thrown = e;
      } catch (const std::exception& e) {
        try { c.thrown = jsi::JSError(c.rt, std::string("ArrayBuffer conversion failed: ") + e.what()); } catch (...) {}
      } catch (...) {
        try { c.thrown = jsi::JSError(c.rt, "ArrayBuffer conversion failed"); } catch (...) {}
      }
      return 6;
    },
    [](void* raw, uint8_t* ptr, size_t len, size_t cap, uint32_t* out) {
      auto& c = C(raw);
      noUnwind("newBytes", [&] {
        // From here the storage belongs to RustBytes (released exactly once by its destructor).
        auto owned = std::make_shared<RustBytes>(ptr, len, cap);
        try {
          if (gForceBytesCopyOut.load()) throw std::runtime_error("copy fallback forced (test hook)");
          *out = c.push(jsi::ArrayBuffer(c.rt, owned));
        } catch (const std::exception&) {
          // The engine refused external storage: copy into a JS-allocated ArrayBuffer made
          // by the framework helper (the ArrayBuffer constructor captured at init, not the
          // patchable global). The result is verified before its storage is written; a
          // failure here (including out of memory) aborts, as there is no error channel.
          // `owned` releases the Rust storage when this scope ends.
          gBytesCopiedOut++;
          auto copy = c.helper(c.allocBuffer, "allocBuffer").call(c.rt, static_cast<double>(len));
          if (!copy.isObject() || !copy.getObject(c.rt).isArrayBuffer(c.rt)) throw std::runtime_error("allocBuffer did not return an ArrayBuffer");
          auto buffer = copy.getObject(c.rt).getArrayBuffer(c.rt);
          if (buffer.size(c.rt) != len) throw std::runtime_error("allocBuffer returned a buffer of the wrong size");
          uint8_t* dst = len ? buffer.data(c.rt) : nullptr;
          if (len && !dst) throw std::runtime_error("allocBuffer returned a buffer without storage");
          if (len) std::memcpy(dst, owned->data(), len);
          *out = c.push(std::move(copy));
        }
        return 0;
      });
    },
    [](void* raw, uint32_t v, uint8_t* (*alloc)(void*, size_t), void* allocCtx) -> size_t {
      return noUnwind("toStringInto", [&] {
        auto& c = C(raw);
        auto str = c.at(v).getString(c.rt);
        // Two passes over the engine's own string data (ASCII or UTF-16 fragments; no
        // intermediate std::string): measure, then encode into the Rust buffer. The callback
        // touches no runtime functionality (getStringData contract).
        Utf8Encoder measure;
        auto measureCb = [&](bool ascii, const void* data, size_t num) { measure.fragment(ascii, data, num); };
        str.getStringData(c.rt, measureCb);
        measure.finish();
        size_t len = measure.len;
        uint8_t* out = alloc(allocCtx, len);
        Utf8Encoder write;
        write.out = out;
        write.cap = len;  // never writes past the measured capacity
        auto writeCb = [&](bool ascii, const void* data, size_t num) { write.fragment(ascii, data, num); };
        str.getStringData(c.rt, writeCb);
        write.finish();
        if (write.overflow || write.len != len) throw std::runtime_error("string changed between passes");
        return len;
      });
    },
};

}  // namespace

#ifdef RNRS_TEST_HOOKS
void setForceBytesCopyOutForTesting(bool force) { gForceBytesCopyOut = force; }
#endif

void throwForeignRuntime(jsi::Runtime& rt, const std::string& what) {
  // Created in the calling runtime from its own Error constructor; nothing else is touched.
  auto message = what + " belongs to another JS runtime; worklet runtimes need a worklet endpoint";
  auto error = rt.global().getPropertyAsFunction(rt, "Error").callAsConstructor(rt, jsi::String::createFromUtf8(rt, message));
  error.getObject(rt).setProperty(rt, "code", jsi::String::createFromAscii(rt, "ERR_RNRS_FOREIGN_RUNTIME"));
  throw jsi::JSError(rt, std::move(error));
}

namespace {

jsi::Value makeError(jsi::Runtime& rt, uint32_t kind, const char* message) {
  const char* ctor = kind == 0 ? "TypeError" : kind == 1 ? "RangeError" : "Error";
  return rt.global().getPropertyAsFunction(rt, ctor).callAsConstructor(rt, jsi::String::createFromUtf8(rt, message));
}

void requireOwnRuntime(jsi::Runtime& rt, const Adapter& adapter) {
  if (!adapter.runtime->accepts(&rt)) throwForeignRuntime(rt, "rnrs: the " + adapter.name + " adapter");
}

WorkletAdapterRef workletRef(const std::shared_ptr<Adapter>& adapter) {
  return WorkletAdapterRef{adapter, adapter->rust, &adapter->alive, adapter->module, adapter->generation, adapter->name};
}

// Runs method `index` with arguments already pushed into `c`'s arena (both call entries).
jsi::Value invokeAdapter(jsi::Runtime& rt, Adapter& adapter, CallCtx& c, uint32_t index, uint32_t self, const uint32_t* args, size_t count) {
  uint32_t out = 0, kind = 0;
  char error[512];
  error[0] = 0;  // Rust writes a terminated message only for kCallError
  switch (rnrs_adapter_call(adapter.rust, &kVTable, &c, c.epoch, index, self, args, count, &out, &kind, error, sizeof error)) {
    case kCallOk: return std::move(c.at(out));
    case kCallThrown:
      if (c.thrown) throw *c.thrown;
      throw jsi::JSError(rt, "native call failed");
    case kCallError:
    default: throw jsi::JSError(rt, makeError(rt, kind, error));
  }
}

void settleTrampoline(void* raw, uint64_t id, uint32_t status, uint32_t value, const char* msg, size_t len) {
  auto& c = C(raw);
  if (!c.settle) return;
  // The outcome is already removed from Rust; settle it even if a handler tears down this
  // adapter. JS ignores settlements for generations it has closed.
  try {
    c.settle->call(c.rt, static_cast<double>(c.adapter.generation), static_cast<double>(id), static_cast<double>(status),
                   jsi::Value(c.rt, c.at(value)), jsi::String::createFromUtf8(c.rt, reinterpret_cast<const uint8_t*>(msg), len));
  } catch (const jsi::JSError& e) {
    platform::log(platform::LogLevel::Error, "settle handler threw: %s", e.getMessage().c_str());
  } catch (const std::exception& e) {
    platform::log(platform::LogLevel::Error, "settlement failed: %s", e.what());
  } catch (...) {
    platform::log(platform::LogLevel::Error, "settlement failed");
  }
}

void Adapter::drain(jsi::Runtime& rt) {
  while (alive.load()) {
    CallCtx c(rt, *this);
    auto settle = rt.global().getProperty(rt, "__rnrsSettle");
    if (settle.isObject() && settle.getObject(rt).isFunction(rt)) {
      c.settle = settle.getObject(rt).getFunction(rt);
      // The framework attaches its conversion helpers to the settle entry point.
      auto helpers = c.settle->getProperty(rt, "helpers");
      if (helpers.isObject()) c.helpers = helpers.getObject(rt);
    }
    size_t n = rnrs_adapter_drain(rust, &kVTable, &c, c.epoch, 16, settleTrampoline);
    if (n == 0) return;
    // Outcomes (and their admission slots) are released either way; make a loss visible.
    if (!c.settle)
      platform::log(platform::LogLevel::Error, "__rnrsSettle is not a function; dropped %zu outcome(s) of %s generation %llu",
                          n, name.c_str(), static_cast<unsigned long long>(generation));
  }
}

// Owned by Rust's notifier; freed through release() exactly once. `current` is the latest
// post's delivery state: replaced by notify and read by deliveryOf, both called by Rust
// with its host lock held (so they never race each other).
struct NotifyContext {
  std::shared_ptr<react::CallInvoker> invoker;
  std::weak_ptr<Adapter> adapter;
  std::shared_ptr<DeliveryState> current;
};

// Called by Rust (from any thread, under its host lock): must not unwind.
void notifyFromAnyThread(void* raw) noexcept {
  auto* ctx = static_cast<NotifyContext*>(raw);
  // Only a weak reference crosses threads; the adapter is locked on the JS thread.
  noteDrainPosted();
  try {
    // The closure owns the guard (every std::function copy shares it); this context keeps
    // only the state. A closure the scheduler destroys unrun marks it Dropped (RnrsDelivery.h).
    auto post = makeDrainPost();
    ctx->current = post.state;
    ctx->invoker->invokeAsync([weak = ctx->adapter, guard = std::move(post.guard)](jsi::Runtime& rt) {
      guard->run([&] {
        // No exception may cross into the scheduler.
        try {
          // Checked here, on the JS thread, not only before enqueueing.
          auto adapter = weak.lock();
          bool open = adapter && adapter->alive.load() && !adapter->scope->invalidated();
          noteDrainRun(open);
          if (open) adapter->drain(rt);
        } catch (const std::exception& e) {
          platform::log(platform::LogLevel::Error, "drain failed: %s", e.what());
        } catch (...) {
          platform::log(platform::LogLevel::Error, "drain failed with a non-standard exception");
        }
      });
    });
  } catch (...) {
    // The previous state (if any) stays current; the host's monitor sees it and posts again.
    platform::log(platform::LogLevel::Error, "posting a drain failed");
  }
}

// Called by Rust under its host lock: only reads an atomic. No post yet reads as Done (the
// host only asks while a wake is posted, so that means the post itself failed).
uint8_t deliveryOf(void* raw) noexcept {
  auto* ctx = static_cast<NotifyContext*>(raw);
  return ctx->current ? ctx->current->load() : kDeliveryDone;
}

void releaseContext(void* raw) noexcept { delete static_cast<NotifyContext*>(raw); }

}  // namespace

void initBundle() {
  static std::once_flag once;
  std::call_once(once, [] { rnrs_bundle_init(); });
}

jsi::Object installModuleAdapter(
    jsi::Runtime& rt, std::shared_ptr<react::CallInvoker> invoker, std::shared_ptr<RuntimeScope> scope,
    const std::string& name, const std::string& hash, double maxInFlight) {
  if (!(maxInFlight >= 1 && maxInFlight <= 1024 && std::floor(maxInFlight) == maxInFlight))
    throw jsi::JSError(rt, makeError(rt, 1, "maxInFlight must be an integer from 1 to 1024"));
  initBundle();
  char error[256] = {0};
  uint32_t module = 0;
  if (rnrs_module_find(name.data(), name.size(), hash.data(), hash.size(), &module, error, sizeof error) != 0)
    throw jsi::JSError(rt, makeError(rt, 2, error));
  auto adapter = std::make_shared<Adapter>();
  adapter->scope = scope;
  adapter->name = name;
  adapter->module = module;
  adapter->runtime.emplace(bindRuntime(rt));
  auto* ctx = new NotifyContext{std::move(invoker), adapter};
  adapter->rust = rnrs_adapter_new(module, static_cast<uint32_t>(maxInFlight), notifyFromAnyThread, deliveryOf, releaseContext, ctx, error, sizeof error);
  if (!adapter->rust) throw jsi::JSError(rt, makeError(rt, 2, error));  // release() already freed ctx
  adapter->generation = rnrs_adapter_generation(adapter->rust);
  // The scope observes the adapter weakly; the host functions below own it. If the scope
  // was invalidated first, nothing was registered: tear down now and fail. `adapter` is the
  // only owner here, so the adapter is freed as this throw unwinds, not at some later GC.
  bool registered = scope->add(adapter, [weak = std::weak_ptr<Adapter>(adapter)] {
    auto a = weak.lock();
    return a && a->teardown(kTeardownLifecycle);
  });
  if (!registered) {
    adapter->teardown(kTeardownRefused);
    throw jsi::JSError(rt, makeError(rt, 2, "runtime is being torn down"));
  }

  jsi::Object api(rt);
  auto bind = [&](const char* fn, unsigned arity, jsi::HostFunctionType f) {
    api.setProperty(rt, fn, jsi::Function::createFromHostFunction(rt, jsi::PropNameID::forAscii(rt, fn), arity, std::move(f)));
  };
  api.setProperty(rt, "generation", static_cast<double>(adapter->generation));
  // call(helpers, index, receiver, args): sync result, or for async methods an operation id
  // or an admission failure {code, message}. `args` is the framework's own array literal
  // (no spread or rest, whose engine paths can observe Array.prototype).
  bind("call", 4, [adapter](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
    requireOwnRuntime(rt, *adapter);
    if (n != 4 || !a[0].isObject() || !a[1].isNumber() || a[1].getNumber() < 0 ||
        std::floor(a[1].getNumber()) != a[1].getNumber() || a[1].getNumber() > UINT32_MAX || !a[3].isObject() ||
        !a[3].getObject(rt).isArray(rt))
      throw jsi::JSError(rt, makeError(rt, 0, "call(helpers, index, receiver, args) needs helpers, a method index and an argument array"));
    CallCtx c(rt, *adapter);
    c.helpersArg = &a[0];  // validated as an object above
    uint32_t self = c.push(jsi::Value(rt, a[2]));
    auto list = a[3].getObject(rt).getArray(rt);
    size_t count = list.size(rt);
    // Up to 8 argument indices on the stack (no allocation per call).
    uint32_t inlineArgs[8];
    std::vector<uint32_t> heapArgs;
    uint32_t* args = inlineArgs;
    if (count > 8) {
      heapArgs.resize(count);
      args = heapArgs.data();
    }
    for (size_t i = 0; i < count; i++) args[i] = c.push(list.getValueAtIndex(rt, i));
    return invokeAdapter(rt, *adapter, c, static_cast<uint32_t>(a[1].getNumber()), self, args, count);
  });
  // callp(helpers, index, receiver, a0..a3): the same call with up to four positional
  // arguments (generated wrappers of sync methods with at most four parameters), so no
  // argument array is built or read. Positional parameters involve no Array at all.
  bind("callp", 7, [adapter](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
    requireOwnRuntime(rt, *adapter);
    if (n < 3 || n > 7 || !a[0].isObject() || !a[1].isNumber() || a[1].getNumber() < 0 ||
        std::floor(a[1].getNumber()) != a[1].getNumber() || a[1].getNumber() > UINT32_MAX)
      throw jsi::JSError(rt, makeError(rt, 0, "callp(helpers, index, receiver, ...up to 4 arguments) needs helpers and a method index"));
    CallCtx c(rt, *adapter);
    c.helpersArg = &a[0];  // validated as an object above
    uint32_t self = c.push(jsi::Value(rt, a[2]));
    uint32_t args[4];
    size_t count = n - 3;
    for (size_t i = 0; i < count; i++) args[i] = c.push(jsi::Value(rt, a[3 + i]));
    return invokeAdapter(rt, *adapter, c, static_cast<uint32_t>(a[1].getNumber()), self, args, count);
  });
  bind("dispose", 1, [adapter](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
    requireOwnRuntime(rt, *adapter);  // HandleState::native is JS-thread state of this runtime
    if (n < 1 || !a[0].isObject() || !a[0].getObject(rt).hasNativeState<HandleState>(rt))
      throw jsi::JSError(rt, makeError(rt, 0, "expected a native object"));
    auto state = a[0].getObject(rt).getNativeState<HandleState>(rt);
    if (state->native) rnrs_native_release(std::exchange(state->native, nullptr));
    return jsi::Value::undefined();
  });
  bind("cancel", 1, [adapter](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
    requireOwnRuntime(rt, *adapter);
    if (n < 1 || !a[0].isNumber()) throw jsi::JSError(rt, makeError(rt, 0, "id must be a number"));
    double id = a[0].getNumber();
    // Only exact integers in 1..Number.MAX_SAFE_INTEGER; anything else would be UB or alias.
    if (!adapter->alive || !std::isfinite(id) || id < 1 || id > kMaxSafeInteger || std::floor(id) != id) return false;
    return rnrs_adapter_cancel(adapter->rust, static_cast<uint64_t>(id));
  });
  bind("teardown", 0, [adapter](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t) -> jsi::Value {
    requireOwnRuntime(rt, *adapter);
    adapter->teardown(kTeardownExplicit);
    return jsi::Value::undefined();
  });
  // Optional worklet endpoint (RnrsWorklets.h): created here on the RN runtime only; the
  // returned HostObjects are what worklets capture.
  bind("workletEndpoint", 1, [adapter](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
    requireOwnRuntime(rt, *adapter);
    if (n < 1 || !a[0].isObject() || !a[0].getObject(rt).isArray(rt))
      throw jsi::JSError(rt, makeError(rt, 0, "workletEndpoint(methods) needs an array of method names"));
    if (!adapter->alive.load()) throw jsi::JSError(rt, makeError(rt, 2, "runtime adapter is closed"));
    return createWorkletEndpoint(rt, workletRef(adapter), a[0].getObject(rt).getArray(rt));
  });
  // workletBox(endpoint, handle): a boxed handle owning its own reference to the handle's
  // object, so disposing the RN wrapper never races calls through the box.
  bind("workletBox", 2, [adapter](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
    requireOwnRuntime(rt, *adapter);
    if (n < 2 || !a[1].isObject() || !a[1].getObject(rt).hasNativeState<HandleState>(rt))
      throw jsi::JSError(rt, makeError(rt, 0, "workletBox(endpoint, handle) needs a native object of this module"));
    auto state = a[1].getObject(rt).getNativeState<HandleState>(rt);
    if (state->module != adapter->module) throw jsi::JSError(rt, makeError(rt, 0, "workletBox: the native object belongs to another module"));
    if (state->generation != adapter->generation || !adapter->alive.load())
      throw jsi::JSError(rt, makeError(rt, 2, "workletBox: the native object belongs to a closed runtime adapter"));
    if (!state->native) throw jsi::JSError(rt, makeError(rt, 2, "workletBox: the native object is disposed"));
    return createWorkletBox(rt, workletRef(adapter), a[0], rnrs_native_share(state->native));
  });
  bind("stats", 1, [adapter](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
    requireOwnRuntime(rt, *adapter);
    CallCtx c(rt, *adapter);
    if (n < 1 || !a[0].isObject()) throw jsi::JSError(rt, makeError(rt, 0, "stats(helpers) needs the conversion helpers"));
    c.helpers = a[0].getObject(rt);
    jsi::Value v = std::move(c.at(rnrs_adapter_stats(adapter->rust, &kVTable, &c, c.epoch)));
    if (!v.isObject()) return v;
    auto s = v.getObject(rt);
    s.setProperty(rt, "nativeFinalizers", static_cast<double>(gFinalizers.load()));
    s.setProperty(rt, "nativeFinalizersOffJsThread", static_cast<double>(gFinalizersOffJsThread.load()));
    s.setProperty(rt, "bytesFinalizedOffJsThread", static_cast<double>(gBytesFinalizedOffJsThread.load()));
    s.setProperty(rt, "bytesCopiedOut", static_cast<double>(gBytesCopiedOut.load()));
    s.setProperty(rt, "scopeId", static_cast<double>(adapter->scope->id()));
#ifdef RNRS_DIAGNOSTICS
    uint64_t rust[10] = {0};
    rnrs_diagnostics(rust);
    s.setProperty(rt, "diagRustAllocations", static_cast<double>(rust[0]));
    s.setProperty(rt, "diagRustAllocatedBytes", static_cast<double>(rust[1]));
    s.setProperty(rt, "diagRustCalls", static_cast<double>(rust[6]));
    s.setProperty(rt, "diagContexts", static_cast<double>(gDiagContexts.load()));
    s.setProperty(rt, "diagHelperLookups", static_cast<double>(gDiagHelperLookups.load()));
    s.setProperty(rt, "diagHelperUses", static_cast<double>(gDiagHelperUses.load()));
    s.setProperty(rt, "diagArenaPushes", static_cast<double>(gDiagArenaPushes.load()));
#endif
    return s;
  });
  return api;
}

}  // namespace rnrs
