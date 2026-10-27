// Framework JSI adapter (handwritten, module-independent). Ownership rules:
// - Rust workers never see JSI values or the runtime; they only call notify(), which posts
//   a task through the CallInvoker. JSI is used only on the JS thread; teardown is the one
//   adapter operation that may run elsewhere, and it never touches JSI.
// - Generated module glue converts values through the vtable below, during one host-function
//   call (or one drain). Values live in that call's arena and are addressed by index; Rust
//   rejects indices from another call (epoch check). Nothing JSI-related outlives the call.
// - Input reads are ordinary JS reads through native JSI (record fields, union tags, array
//   elements and `length`: prototype-inclusive [[Get]], getters and proxy traps run). Output and
//   Array.isArray semantics come from framework JS helpers (packages/runtime/src/runtime.ts,
//   captured when that module initializes) passed with every call: own data-property definitions
//   (JSI alone has no define) and Array.isArray (whether JSI's isArray accepts proxies of arrays
//   is engine-dependent: Hermes does; the helper keeps Array.isArray semantics on any engine).
// - JS promise state lives in JS (packages/runtime/src/runtime.ts). Drains settle by calling the global
//   __rnrsSettle on the JS thread, so no jsi::Value is retained natively.
// - A native object's JS wrapper owns one Rust `NativeBox` via NativeState; GC finalization
//   or dispose() releases it (thread-safe). In-flight operations hold their own owners.
// - Teardown (lifecycle scope invalidation, the explicit test hook, a refused registration,
//   or the destructor fallback) is idempotent and never blocks.
// - Modules are reached only through their binary's table (RnrsAbi.h). Every pointer a module
//   hands out (adapter, NativeBox, ArrayBuffer storage) is kept with that table and released
//   through it, so it returns to the allocator and code that created it, even in a finalizer
//   after the adapter is gone. Identity is (table, serial): the serial is process-unique across
//   all binaries (each binary numbers its own Rust generations), so wrappers, settlements and
//   worklet boxes of one module can never be taken for another's.
#include "RnrsJsi.h"
#include "RnrsAbi.h"
#include "RnrsDelivery.h"
#include "RnrsRegistry.h"
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
using namespace abi;
static_assert(kDeliveryResultQueued == kDeliveryQueued && kDeliveryResultRunning == kDeliveryRunning &&
                  kDeliveryResultDone == kDeliveryDone && kDeliveryResultDropped == kDeliveryDropped,
              "RnrsDelivery.h values are the ABI's delivery results");
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
  const RnrsModuleV3* table;  // the binary that allocated the storage
  uint8_t* ptr;
  size_t len, cap;
  platform::ThreadId jsThread = platform::currentThread();
  RustBytes(const RnrsModuleV3* t, uint8_t* p, size_t l, size_t c) : table(t), ptr(p), len(l), cap(c) {}
  ~RustBytes() override {
    if (platform::currentThread() != jsThread) gBytesFinalizedOffJsThread++;
    table->bytesFree(ptr, len, cap);
  }
  size_t size() const override { return len; }
  uint8_t* data() override { return ptr; }
};
std::atomic<uint32_t> gEpoch{1};
// Adapter serials: process-unique across every module binary (exposed to JS as `generation`).
std::atomic<uint64_t> gNextSerial{1};

struct Adapter {
  const RnrsModuleV3* table = nullptr;  // the module's binary; static for the process
  RnrsAdapter* rust = nullptr;
  // Process-unique serial of this adapter (JS `generation`): wrappers of other modules or
  // other adapters of this module are a mismatch.
  uint64_t generation = gNextSerial.fetch_add(1);
  std::string name;
  std::vector<RnrsScalarBinding> scalars;
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
    table->adapterTeardown(rust, reason);
    return true;
  }
  ~Adapter() {
    noteAdapterDestroyed(*scope);
    if (rust) {
      teardown(kTeardownDestructor);  // fallback only: normally already torn down
      table->adapterFree(rust);
    }
  }
  void drain(jsi::Runtime& rt);
};

// A wrapper's ownership of one Rust NativeBox, released through the table of the binary that
// created it (never through an adapter, which may be freed before this finalizer runs).
struct HandleState : jsi::NativeState {
  void* native;
  const RnrsModuleV3* table;
  uint64_t generation;  // the creating adapter's serial
  platform::ThreadId jsThread = platform::currentThread();  // constructed on the JS thread
  HandleState(void* n, const RnrsModuleV3* t, uint64_t g) : native(n), table(t), generation(g) {}
  ~HandleState() override {
    gFinalizers++;
    if (platform::currentThread() != jsThread) gFinalizersOffJsThread++;
    if (native) table->nativeRelease(native);  // thread-safe
  }
};

// ModuleHost's own, non-writable property holding the helpers (runtime.ts HOST_HELPERS_KEY).
constexpr const char* kHostHelpers = "rnrs:helpers";

// One host-function call (or drain) on the JS thread.
struct CallCtx {
  jsi::Runtime& rt;
  Adapter& adapter;
  uint32_t epoch = gEpoch++;
  std::vector<jsi::Value> arena;
  std::optional<jsi::JSError> thrown;
  std::optional<jsi::Function> settle;
  std::optional<jsi::Object> helpers;
  // Where the host call in progress carries the helpers, read only when a helper is first
  // needed (scalar and string calls need none): `helpersArg` is the helpers object itself (the
  // `call` argument or callh's bound `this`); `helpersHost` is a prepared scalar entry's `this`,
  // the module's ModuleHost, holding them under kHostHelpers. Both are valid for the whole
  // call, which this context never outlives. Reading `helpersHost` may run JS (a getter or
  // proxy on a non-genuine host); helpers are only used inside guarded or try/catch callbacks.
  const jsi::Value* helpersArg = nullptr;
  const jsi::Value* helpersHost = nullptr;
  std::optional<jsi::Function> define, isArray, bufferKind, allocBuffer, entries;
  // The array most recently read by `length` or index (its arena index), so elements are read
  // without a handle clone each; arena values never change during the call, so the index
  // identifies the value.
  uint32_t cachedIndex = UINT32_MAX;
  std::optional<jsi::Object> cachedArray;
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
      if (!helpers && helpersHost && helpersHost->isObject()) {
        auto held = helpersHost->getObject(rt).getProperty(rt, kHostHelpers);
        if (held.isObject()) helpers = held.getObject(rt);
      }
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
  // An object operand of a property or index read. Rust reads properties only after a record
  // (object) or array kind check, so anything else is an internal error, not UB.
  jsi::Object objectAt(uint32_t v) {
    auto& x = at(v);
    if (!x.isObject()) throw jsi::JSError(rt, "rnrs: property read on a non-object");
    return x.getObject(rt);
  }
  jsi::Object& arrayAt(uint32_t a) {
    if (cachedIndex != a) {
      cachedIndex = UINT32_MAX;
      cachedArray.emplace(objectAt(a));
      cachedIndex = a;
    }
    return *cachedArray;
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
      if (x.isUndefined()) return kKindUndefined;
      if (x.isNull()) return kKindNull;
      if (x.isBool()) return kKindBoolean;
      if (x.isNumber()) return kKindNumber;
      if (x.isString()) return kKindString;
      if (x.isObject()) {
        auto o = x.getObject(c.rt);
        if (o.isArray(c.rt)) return kKindArray;
        if (o.isFunction(c.rt)) return kKindFunction;
        // Array.isArray semantics (proxies of arrays are arrays); a throwing check (a revoked
        // proxy) reads as an unsupported value.
        try {
          if (c.helper(c.isArray, "isArray").call(c.rt, jsi::Value(c.rt, x)).getBool()) return kKindArray;
        } catch (const std::exception&) {
          return kKindOther;
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
    // Ordinary property read (record fields, union tags): `object[key]`, prototype-inclusive;
    // getters and proxy traps run and their exceptions propagate.
    [](void* raw, uint32_t o, const char* k, size_t n, uint32_t* out) -> bool {
      auto& c = C(raw);
      return guarded(c, [&] {
        auto object = c.objectAt(o);
        auto key = jsi::String::createFromUtf8(c.rt, reinterpret_cast<const uint8_t*>(k), n);
        *out = c.push(object.getProperty(c.rt, key));
      });
    },
    // `length`, read once per conversion with an ordinary read (a proxy's trap runs once). Not
    // jsi::Array::size(): Hermes's JSI isArray also accepts proxies of arrays, and size() would
    // return a converted size_t instead of the JS value the integer check needs.
    [](void* raw, uint32_t a, double* out) -> bool {
      auto& c = C(raw);
      return guarded(c, [&] {
        auto v = c.arrayAt(a).getProperty(c.rt, "length");
        *out = v.isNumber() ? v.getNumber() : std::nan("");  // Rust rejects non-integers
      });
    },
    // Ordinary element read `array[i]` with a number key: holes and indices past a length that
    // shrank during conversion fall through to the prototype chain; getters and proxy traps run
    // once. Not getValueAtIndex: it checks the bound with another `length` read (observable on
    // proxies) and throws past the end instead of reading through the prototype chain.
    [](void* raw, uint32_t a, uint32_t i, uint32_t* out) -> bool {
      auto& c = C(raw);
      return guarded(c, [&] { *out = c.push(c.arrayAt(a).getProperty(c.rt, jsi::Value(static_cast<double>(i)))); });
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
        wrapper.setNativeState(c.rt, std::make_shared<HandleState>(native, c.adapter.table, c.adapter.generation));
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
      if (state->table != c.adapter.table) return kUnwrapNotNative;  // another module's object
      if (state->generation != c.adapter.generation || !c.adapter.alive.load()) return kUnwrapClosed;
      if (!state->native) return kUnwrapDisposed;
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
        if (!status.isNumber()) return kBytesNotArrayBuffer;
        auto code = static_cast<uint32_t>(status.getNumber());
        if (code != kBytesOk) return code;
        auto& x = c.at(v);
        if (!x.isObject() || !x.getObject(c.rt).isArrayBuffer(c.rt)) return kBytesNotArrayBuffer;  // must agree with the helper
        auto buffer = x.getObject(c.rt).getArrayBuffer(c.rt);
        size_t n = buffer.size(c.rt);
        uint8_t* src = n ? buffer.data(c.rt) : nullptr;
        if (n && !src) return kBytesDetached;  // no storage: treat as detached
        uint8_t* dst = alloc(allocCtx, n);
        if (n && !dst) return kBytesTooLarge;  // the copy's storage could not be allocated
        if (n) std::memcpy(dst, src, n);  // never memcpy with a null pointer, even for 0 bytes
        return kBytesOk;
      } catch (const jsi::JSError& e) {
        c.thrown = e;
      } catch (const std::exception& e) {
        try { c.thrown = jsi::JSError(c.rt, std::string("ArrayBuffer conversion failed: ") + e.what()); } catch (...) {}
      } catch (...) {
        try { c.thrown = jsi::JSError(c.rt, "ArrayBuffer conversion failed"); } catch (...) {}
      }
      return kBytesThrown;
    },
    [](void* raw, uint8_t* ptr, size_t len, size_t cap, uint32_t* out) {
      auto& c = C(raw);
      noUnwind("newBytes", [&] {
        // From here the storage belongs to RustBytes (released exactly once by its destructor).
        auto owned = std::make_shared<RustBytes>(c.adapter.table, ptr, len, cap);
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
    [](void* raw, uint32_t a, uint32_t length,
       double* (*alloc)(void*, size_t, size_t), void* allocCtx, uint32_t* badIndex, uint32_t* badValue) -> uint32_t {
      auto& c = C(raw);
      uint32_t status = kNumbersOk;
      if (!guarded(c, [&] {
        // This call owns the handle. Reentrant host calls have separate CallCtxs.
        auto array = c.objectAt(a);
        size_t capacity = std::min<uint32_t>(length, 4096);
        double* data = capacity ? alloc(allocCtx, 0, capacity) : nullptr;
        for (uint32_t i = 0; i < length; ++i) {
          auto value = array.getProperty(c.rt, jsi::Value(static_cast<double>(i)));
          if (!value.isNumber()) {
            *badIndex = i;
            *badValue = c.push(std::move(value));
            status = kNumbersInvalid;
            return;
          }
          if (i == capacity) {
            capacity += std::min<size_t>(capacity, length - capacity);
            data = alloc(allocCtx, i, capacity);
          }
          data[i] = value.getNumber();
        }
      })) return kNumbersThrown;
      return status;
    },
    // Object.entries of a plain object (Record<string, T>, JsonValue), through the framework
    // helper: getters and proxy traps run; null means another prototype.
    [](void* raw, uint32_t v, uint32_t* out) -> uint32_t {
      auto& c = C(raw);
      uint32_t status = kEntriesOk;
      if (!guarded(c, [&] {
        auto entries = c.helper(c.entries, "entries").call(c.rt, jsi::Value(c.rt, c.at(v)));
        if (entries.isNull()) status = kEntriesNotPlain;
        else *out = c.push(std::move(entries));
      })) return kEntriesThrown;
      return status;
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

[[noreturn, gnu::noinline, gnu::cold]] void throwForeignAdapter(jsi::Runtime& rt, const Adapter& adapter) {
  throwForeignRuntime(rt, "rnrs: the " + adapter.name + " adapter");
}

// Inline on every entry: a pointer compare and an acquire load; the message is built out of line.
inline void requireOwnRuntime(jsi::Runtime& rt, const Adapter& adapter) {
  if (!adapter.runtime->accepts(&rt)) [[unlikely]] throwForeignAdapter(rt, adapter);
}

WorkletAdapterRef workletRef(const std::shared_ptr<Adapter>& adapter) {
  return WorkletAdapterRef{adapter, adapter->table, adapter->rust, &adapter->alive, adapter->generation, adapter->name};
}

// Runs method `index` with arguments already pushed into `c`'s arena (both call entries).
jsi::Value invokeAdapter(jsi::Runtime& rt, Adapter& adapter, CallCtx& c, uint32_t index, uint32_t self, const uint32_t* args, size_t count) {
  uint32_t out = 0, kind = 0;
  char error[512];
  error[0] = 0;  // Rust writes a terminated message only for kCallError
  switch (adapter.table->adapterCall(adapter.rust, &kVTable, &c, c.epoch, index, self, args, count, &out, &kind, error, sizeof error)) {
    case kCallOk: return std::move(c.at(out));
    case kCallThrown:
      if (c.thrown) throw *c.thrown;
      throw jsi::JSError(rt, "native call failed");
    case kCallError:
    default: throw jsi::JSError(rt, makeError(rt, kind, error));
  }
}

// A generated scalar leaf with strictly typed primitive arguments `a[0..n)`: true with the leaf's
// result in `out` (a number, or 0/1 for a boolean). False when an argument is missing or of another
// type: the caller then uses the generic reader, which reports it (after the closed check). Reading
// primitives runs no JS. Inlined into both entries; the caller builds the JS value in place.
[[gnu::always_inline]] inline bool callScalar(jsi::Runtime& rt, Adapter& adapter, const RnrsScalarBinding& binding,
                                              const jsi::Value* a, size_t n, double& out) {
  double inputs[4] = {};
  size_t i = 0;
  for (uint32_t types = binding.args; types; ++i, types >>= 2) {
    if (i >= n) return false;
    const auto& value = a[i];
    if ((types & 3) == 1) {
      if (!value.isNumber()) return false;
      inputs[i] = value.getNumber();
    } else {
      if (!value.isBool()) return false;
      inputs[i] = value.getBool() ? 1.0 : 0.0;
    }
  }
  uint32_t kind = 0;
  char error[512];
  error[0] = 0;
  if (adapter.table->scalarCall(adapter.rust, &binding, inputs, &out, &kind, error, sizeof error) != kCallOk) [[unlikely]]
    throw jsi::JSError(rt, makeError(rt, kind, error));
  return true;
}

// A scalar leaf's result as a JS value, returned as a prvalue (built in the caller's return slot,
// with no out-of-line jsi::Value move or destructor).
inline jsi::Value scalarValue(const RnrsScalarBinding& binding, double out) {
  if (binding.result == 1) return jsi::Value(out);
  if (binding.result == 2) return jsi::Value(out != 0.0);
  return jsi::Value::undefined();
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
    size_t n = table->adapterDrain(rust, &kVTable, &c, c.epoch, 16, settleTrampoline);
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

jsi::Object installModuleAdapter(
    jsi::Runtime& rt, std::shared_ptr<react::CallInvoker> invoker, std::shared_ptr<RuntimeScope> scope,
    const std::string& name, const std::string& hash, double maxInFlight) {
  if (!(maxInFlight >= 1 && maxInFlight <= 1024 && std::floor(maxInFlight) == maxInFlight))
    throw jsi::JSError(rt, makeError(rt, 1, "maxInFlight must be an integer from 1 to 1024"));
  std::string missing;
  const RnrsModuleV3* table = findModule(name, hash, missing);
  if (!table) throw jsi::JSError(rt, makeError(rt, 2, missing.c_str()));
  char error[256] = {0};
  auto adapter = std::make_shared<Adapter>();
  adapter->table = table;
  adapter->scope = scope;
  adapter->name = name;
  adapter->runtime.emplace(bindRuntime(rt));
  auto* ctx = new NotifyContext{std::move(invoker), adapter};
  adapter->rust = table->adapterNew(table, static_cast<uint32_t>(maxInFlight), notifyFromAnyThread, deliveryOf, releaseContext, ctx, error, sizeof error);
  if (!adapter->rust) throw jsi::JSError(rt, makeError(rt, 2, error));  // release() already freed ctx
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

  // Bind generated scalar leaves once, before publishing any host function.
  for (size_t i = 0;; ++i) {
    uint32_t method;
    RnrsScalarBinding binding;
    if (!table->adapterScalar(adapter->rust, i, &method, &binding)) break;
    if (adapter->scalars.size() <= method) adapter->scalars.resize(static_cast<size_t>(method) + 1);
    adapter->scalars[method] = binding;
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
  // callh(index, receiver, a0..a3) with the helpers as `this`: the same call with up to four
  // positional arguments (generated wrappers of sync methods with at most four parameters),
  // so no argument array is built or read. Positional parameters involve no Array at all.
  // The framework binds `this` once. A host function receives a converted `this` on every
  // call regardless, so carrying the helpers there costs no extra object argument.
  bind("callh", 6, [adapter](jsi::Runtime& rt, const jsi::Value& helpers, const jsi::Value* a, size_t n) -> jsi::Value {
    requireOwnRuntime(rt, *adapter);
    if (n < 2 || n > 6 || !helpers.isObject() || !a[0].isNumber() || a[0].getNumber() < 0 ||
        std::floor(a[0].getNumber()) != a[0].getNumber() || a[0].getNumber() > UINT32_MAX)
      throw jsi::JSError(rt, makeError(rt, 0, "callh(index, receiver, ...up to 4 arguments) needs the helpers as this and a method index"));
    const auto index = static_cast<uint32_t>(a[0].getNumber());
    // Invalid/missing inputs use the existing reader, including closed-before-type-error
    // priority and JS exceptions from cold kind classification.
    double out;
    if (index < adapter->scalars.size() && adapter->scalars[index].definition &&
        callScalar(rt, *adapter, adapter->scalars[index], a + 2, n - 2, out))
      return scalarValue(adapter->scalars[index], out);
    CallCtx c(rt, *adapter);
    c.helpersArg = &helpers;  // validated as an object above
    uint32_t self = c.push(jsi::Value(rt, a[1]));
    uint32_t args[4];
    size_t count = n - 2;
    for (size_t i = 0; i < count; i++) args[i] = c.push(jsi::Value(rt, a[2 + i]));
    return invokeAdapter(rt, *adapter, c, index, self, args, count);
  });
  // entry(index): the prepared host function of generated scalar method `index` (protocol 3
  // wrappers call it as this.host.m<index>(...arguments), the host as `this`), or undefined.
  // It captures the adapter owner and the immutable binding: no index, receiver or helpers
  // argument per call. Module methods only, so the receiver is undefined.
  bind("entry", 1, [adapter](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
    requireOwnRuntime(rt, *adapter);
    if (n < 1 || !a[0].isNumber() || a[0].getNumber() < 0 || std::floor(a[0].getNumber()) != a[0].getNumber() ||
        a[0].getNumber() >= static_cast<double>(adapter->scalars.size()))
      return jsi::Value::undefined();
    const auto index = static_cast<uint32_t>(a[0].getNumber());
    const RnrsScalarBinding binding = adapter->scalars[index];
    if (!binding.definition) return jsi::Value::undefined();
    unsigned arity = 0;
    for (uint32_t types = binding.args; types; types >>= 2) arity++;
    // Named like its host property (m<index>), so stacks and `.name` identify the method.
    return jsi::Function::createFromHostFunction(rt, jsi::PropNameID::forAscii(rt, "m" + std::to_string(index)), arity,
        [adapter, index, binding](jsi::Runtime& rt, const jsi::Value& host, const jsi::Value* a, size_t n) -> jsi::Value {
          requireOwnRuntime(rt, *adapter);
          double out;
          if (callScalar(rt, *adapter, binding, a, n, out)) return scalarValue(binding, out);
          // Same generic reader as callh with the actual arguments (at most four are read,
          // extra ones ignored); helpers come from the host only if a helper is needed.
          CallCtx c(rt, *adapter);
          c.helpersHost = &host;
          uint32_t self = c.push(jsi::Value::undefined());
          uint32_t args[4];
          size_t count = std::min<size_t>(n, 4);
          for (size_t i = 0; i < count; i++) args[i] = c.push(jsi::Value(rt, a[i]));
          return invokeAdapter(rt, *adapter, c, index, self, args, count);
        });
  });
  bind("dispose", 1, [adapter](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
    requireOwnRuntime(rt, *adapter);  // HandleState::native is JS-thread state of this runtime
    if (n < 1 || !a[0].isObject() || !a[0].getObject(rt).hasNativeState<HandleState>(rt))
      throw jsi::JSError(rt, makeError(rt, 0, "expected a native object"));
    auto state = a[0].getObject(rt).getNativeState<HandleState>(rt);
    if (state->native) state->table->nativeRelease(std::exchange(state->native, nullptr));
    return jsi::Value::undefined();
  });
  bind("cancel", 1, [adapter](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
    requireOwnRuntime(rt, *adapter);
    if (n < 1 || !a[0].isNumber()) throw jsi::JSError(rt, makeError(rt, 0, "id must be a number"));
    double id = a[0].getNumber();
    // Only exact integers in 1..Number.MAX_SAFE_INTEGER; anything else would be UB or alias.
    if (!adapter->alive || !std::isfinite(id) || id < 1 || id > kMaxSafeInteger || std::floor(id) != id) return false;
    return adapter->table->adapterCancel(adapter->rust, static_cast<uint64_t>(id));
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
    if (state->table != adapter->table) throw jsi::JSError(rt, makeError(rt, 0, "workletBox: the native object belongs to another module"));
    if (state->generation != adapter->generation || !adapter->alive.load())
      throw jsi::JSError(rt, makeError(rt, 2, "workletBox: the native object belongs to a closed runtime adapter"));
    if (!state->native) throw jsi::JSError(rt, makeError(rt, 2, "workletBox: the native object is disposed"));
    return createWorkletBox(rt, workletRef(adapter), a[0], adapter->table->nativeShare(state->native));
  });
  bind("stats", 1, [adapter](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* a, size_t n) -> jsi::Value {
    requireOwnRuntime(rt, *adapter);
    CallCtx c(rt, *adapter);
    if (n < 1 || !a[0].isObject()) throw jsi::JSError(rt, makeError(rt, 0, "stats(helpers) needs the conversion helpers"));
    c.helpers = a[0].getObject(rt);
    jsi::Value v = std::move(c.at(adapter->table->adapterStats(adapter->rust, &kVTable, &c, c.epoch)));
    if (!v.isObject()) return v;
    auto s = v.getObject(rt);
    // The adapter's identity as JS sees it (the Rust host's own generation counts per binary).
    s.setProperty(rt, "generation", static_cast<double>(adapter->generation));
    s.setProperty(rt, "nativeFinalizers", static_cast<double>(gFinalizers.load()));
    s.setProperty(rt, "nativeFinalizersOffJsThread", static_cast<double>(gFinalizersOffJsThread.load()));
    s.setProperty(rt, "bytesFinalizedOffJsThread", static_cast<double>(gBytesFinalizedOffJsThread.load()));
    s.setProperty(rt, "bytesCopiedOut", static_cast<double>(gBytesCopiedOut.load()));
    s.setProperty(rt, "scopeId", static_cast<double>(adapter->scope->id()));
#ifdef RNRS_DIAGNOSTICS
    uint64_t rust[10] = {0};
    if (adapter->table->diagnostics) adapter->table->diagnostics(rust);  // this module's binary
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
