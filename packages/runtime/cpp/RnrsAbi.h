#pragma once
// C ABI of the Rust backend (rust/rnrs-android), shared by the framework's JSI adapter
// (RnrsJsi.cpp) and the optional worklet endpoint (RnrsWorklets.cpp). Private to the framework.
// Call contexts: the adapter's is used on its RN runtime's JS thread; the endpoint's on the
// thread of whichever runtime calls it. Each context serves one call on one thread; values
// are rooted in it (arena or fixed slots) for that call. See rust/rnrs-android/src/lib.rs.
#include <cstddef>
#include <cstdint>

extern "C" {
#ifdef RNRS_DIAGNOSTICS
void rnrs_diagnostics(uint64_t* out);  // rust/rnrs-android, feature "diagnostics"
#endif
struct RnrsAdapter;
typedef void (*RnrsCallback)(void*);
typedef void (*RnrsSettle)(void* ctx, uint64_t id, uint32_t status, uint32_t value, const char* msg, size_t len);
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
  // Array already brand/length checked. One ordinary read per index; stops at first
  // invalid value. alloc owns/grows Rust storage, preserving initialized doubles;
  // it runs no JS. Capacity requests start <=4096, grow only after a valid read.
  // 0 success, 1 invalid (writes index/value), 2 exception retained in call context.
  uint32_t (*numberArray)(void*, uint32_t, uint32_t,
      double* (*alloc)(void*, size_t initialized, size_t capacity), void*, uint32_t*, uint32_t*);
};
void rnrs_bytes_free(uint8_t* ptr, size_t len, size_t cap);
void rnrs_bundle_init();
uint32_t rnrs_module_find(const char*, size_t, const char*, size_t, uint32_t*, char*, size_t);
// delivery: the latest post's state (RnrsDelivery.h values), read under the host lock.
typedef uint8_t (*RnrsDeliveryCallback)(void*);
RnrsAdapter* rnrs_adapter_new(uint32_t module, uint32_t maxInFlight, RnrsCallback notify, RnrsDeliveryCallback delivery,
                            RnrsCallback release, void* ctx, char*, size_t);
uint64_t rnrs_adapter_generation(const RnrsAdapter*);
struct RnrsScalarBinding {
  uint32_t args, result;
  const void* definition;
  const void* instance;
};
bool rnrs_adapter_scalar(const RnrsAdapter*, size_t index, uint32_t* method, RnrsScalarBinding*);
uint32_t rnrs_scalar_call(const RnrsAdapter*, const RnrsScalarBinding*, const double* args,
                          double* out, uint32_t* errorKind, char* error, size_t cap);
uint32_t rnrs_adapter_call(const RnrsAdapter*, const JsiVTable*, void* ctx, uint32_t epoch, uint32_t method, uint32_t self,
                          const uint32_t* args, size_t nargs, uint32_t* out, uint32_t* errorKind, char* error, size_t cap);
size_t rnrs_adapter_drain(const RnrsAdapter*, const JsiVTable*, void* ctx, uint32_t epoch, size_t max, RnrsSettle settle);
uint32_t rnrs_adapter_stats(const RnrsAdapter*, const JsiVTable*, void* ctx, uint32_t epoch);
bool rnrs_adapter_cancel(const RnrsAdapter*, uint64_t id);
uint32_t rnrs_adapter_teardown(const RnrsAdapter*, uint32_t reason);
void rnrs_adapter_free(RnrsAdapter*);
void rnrs_native_release(void*);
bool rnrs_adapter_method_find(const RnrsAdapter*, const char* name, size_t len, uint32_t* index, bool* isAsync);
void* rnrs_native_share(const void* native);
const char* rnrs_native_spec_name(const void* native, size_t* len);
}
