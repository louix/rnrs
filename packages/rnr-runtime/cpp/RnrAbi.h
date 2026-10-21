#pragma once
// C ABI of the Rust backend (rust/rnrs-android), shared by the framework's JSI adapter
// (RnrJsi.cpp) and the optional worklet endpoint (RnrWorklets.cpp). Private to the framework.
// Call contexts: the adapter's is used on its RN runtime's JS thread; the endpoint's on the
// thread of whichever runtime calls it. Each context serves one call on one thread; values
// are rooted in it (arena or fixed slots) for that call. See rust/rnrs-android/src/lib.rs.
#include <cstddef>
#include <cstdint>

extern "C" {
#ifdef RNR_DIAGNOSTICS
void rnr_diagnostics(uint64_t* out);  // rust/rnrs-android, feature "diagnostics"
#endif
struct RnrAdapter;
typedef void (*RnrCallback)(void*);
typedef void (*RnrSettle)(void* ctx, uint64_t id, uint32_t status, uint32_t value, const char* msg, size_t len);
struct JsiVTable {
  uint32_t (*kind)(void*, uint32_t);
  double (*toNumber)(void*, uint32_t);
  bool (*toBool)(void*, uint32_t);
  bool (*getProperty)(void*, uint32_t, const char*, size_t, uint32_t*);
  bool (*arrayLength)(void*, uint32_t, double*);
  bool (*getIndex)(void*, uint32_t, uint32_t, uint32_t*);
  uint32_t (*undefinedValue)(void*);
  uint32_t (*nullValue)(void*);
  uint32_t (*number)(void*, double);
  uint32_t (*boolean)(void*, bool);
  uint32_t (*string)(void*, const char*, size_t);
  uint32_t (*object)(void*);
  bool (*setProperty)(void*, uint32_t, const char*, size_t, uint32_t);
  uint32_t (*array)(void*, uint32_t);
  bool (*setIndex)(void*, uint32_t, uint32_t, uint32_t);
  bool (*wrapNative)(void*, void*, uint32_t*);
  uint32_t (*unwrapNative)(void*, uint32_t, const void**);
  uint32_t (*toBytes)(void*, uint32_t, uint8_t* (*alloc)(void*, size_t), void* allocCtx);
  void (*newBytes)(void*, uint8_t* ptr, size_t len, size_t cap, uint32_t* out);
  // UTF-8 copy of a string straight into storage from alloc(allocCtx, len); returns the
  // bytes written.
  size_t (*toStringInto)(void*, uint32_t v, uint8_t* (*alloc)(void*, size_t), void* allocCtx);
};
void rnr_bytes_free(uint8_t* ptr, size_t len, size_t cap);
void rnr_bundle_init();
uint32_t rnr_module_find(const char*, size_t, const char*, size_t, uint32_t*, char*, size_t);
// delivery: the latest post's state (RnrDelivery.h values), read under the host lock.
typedef uint8_t (*RnrDeliveryCallback)(void*);
RnrAdapter* rnr_adapter_new(uint32_t module, uint32_t maxInFlight, RnrCallback notify, RnrDeliveryCallback delivery,
                            RnrCallback release, void* ctx, char*, size_t);
uint64_t rnr_adapter_generation(const RnrAdapter*);
uint32_t rnr_adapter_call(const RnrAdapter*, const JsiVTable*, void* ctx, uint32_t epoch, uint32_t method, uint32_t self,
                          const uint32_t* args, size_t nargs, uint32_t* out, uint32_t* errorKind, char* error, size_t cap);
size_t rnr_adapter_drain(const RnrAdapter*, const JsiVTable*, void* ctx, uint32_t epoch, size_t max, RnrSettle settle);
uint32_t rnr_adapter_stats(const RnrAdapter*, const JsiVTable*, void* ctx, uint32_t epoch);
bool rnr_adapter_cancel(const RnrAdapter*, uint64_t id);
uint32_t rnr_adapter_teardown(const RnrAdapter*, uint32_t reason);
void rnr_adapter_free(RnrAdapter*);
void rnr_native_release(void*);
bool rnr_adapter_method_find(const RnrAdapter*, const char* name, size_t len, uint32_t* index, bool* isAsync);
void* rnr_native_share(const void* native);
const char* rnr_native_spec_name(const void* native, size_t* len);
}
