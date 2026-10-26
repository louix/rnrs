#pragma once
// The binary boundary between the framework C++ (RnrsJsi.cpp, RnrsWorklets.cpp, RnrsRegistry.cpp)
// and Rust module binaries (rust/rnrs-android `ModuleTable`). Each module binary, prebuilt and
// sealed or source-built, exports one function per module:
//
//   const RnrsModuleV2* rnrs_module_v2_<crate>(void);
//
// It is called before the table is validated, so it may only return the address of a static
// table. The C++ runtime reaches a module only through its table, keeps the table pointer with
// every pointer the module handed out, and releases each through that table (binaries are linked
// statically and never unloaded, so table pointers stay valid for the process, including in
// late finalizers). No allocation crosses allocators.
//
// Versioning: RNRS_ABI is matched exactly, together with the struct sizes the binary was built
// with, before any other call into it. Any change to this file (layouts, signatures, status
// codes, callback contracts) bumps RNRS_ABI here and in rnrs-android, and the symbol suffix;
// comment-only edits need no bump. The contract is pinned twice: by the static_asserts at the
// end of this file and by the same layout and constants in rnrs-android's `abi_contract` test.
// The leading {abi, size} fields are frozen in every future version so that an old or new
// table can always be refused safely. The surface table (RnrsSurfaceV1) and its constants are
// versioned the same way by RNRS_SURFACE_ABI, pinned by rnrs-surface's `host` contract test.
//
// Call contexts: the adapter's is used on its RN runtime's JS thread; the endpoint's on the
// thread of whichever runtime calls it. Each context serves one call on one thread; values
// are rooted in it (arena or fixed slots) for that call. See rust/rnrs-android/src/lib.rs.
#include <cstddef>
#include <cstdint>

#define RNRS_ABI 2
// The surface table (RnrsSurfaceV1), versioned on its own: rust/rnrs-android builds the module
// table, packages/surface/rust (rnrs-surface) the surface table.
#define RNRS_SURFACE_ABI 1

extern "C" {
struct RnrsAdapter;
struct RnrsSurfaceV1;
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
  // Takes ownership of the module's NativeBox (released through that module's native_release).
  bool (*wrapNative)(void*, void*, uint32_t*);
  // 0 ok, 1 not a wrapper of this module, 2 closed adapter, 3 disposed.
  uint32_t (*unwrapNative)(void*, uint32_t, const void**);
  uint32_t (*toBytes)(void*, uint32_t, uint8_t* (*alloc)(void*, size_t), void* allocCtx);
  // Takes ownership of the module's Vec<u8> (released through that module's bytes_free).
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
// delivery: the latest post's state (RnrsDelivery.h values), read under the host lock.
typedef uint8_t (*RnrsDeliveryCallback)(void*);
struct RnrsScalarBinding {
  uint32_t args, result;
  const void* definition;
  const void* instance;
};

struct RnrsModuleV2 {
  // Frozen in every version.
  uint32_t abi;   // RNRS_ABI the binary was built for
  uint32_t size;  // sizeof(RnrsModuleV2) as the binary was built
  // Checked with abi/size before the first call into the binary.
  uint32_t vtableSize;         // sizeof(JsiVTable) the binary expects
  uint32_t scalarBindingSize;  // sizeof(RnrsScalarBinding)
  const char* name;            // spec module name, UTF-8, static
  size_t nameLen;
  const char* hash;  // IR hash of the spec the glue was generated from
  size_t hashLen;
  const char* build;  // diagnostics: the backend version
  size_t buildLen;
  const void* def;  // opaque; only passed back through adapterNew's table argument
  // Once per process, after validation and before any other entry (idempotent per binary).
  void (*init)();
  bool (*setAppDataDir)(const uint8_t*, size_t);
  RnrsAdapter* (*adapterNew)(const RnrsModuleV2* self, uint32_t maxInFlight, RnrsCallback notify,
      RnrsDeliveryCallback delivery, RnrsCallback release, void* ctx, char* error, size_t cap);
  bool (*adapterScalar)(const RnrsAdapter*, size_t index, uint32_t* method, RnrsScalarBinding*);
  uint32_t (*scalarCall)(const RnrsAdapter*, const RnrsScalarBinding*, const double* args, double* out,
      uint32_t* errorKind, char* error, size_t cap);
  uint32_t (*adapterCall)(const RnrsAdapter*, const JsiVTable*, void* ctx, uint32_t epoch, uint32_t method,
      uint32_t self, const uint32_t* args, size_t nargs, uint32_t* out, uint32_t* errorKind, char* error, size_t cap);
  size_t (*adapterDrain)(const RnrsAdapter*, const JsiVTable*, void* ctx, uint32_t epoch, size_t max, RnrsSettle settle);
  uint32_t (*adapterStats)(const RnrsAdapter*, const JsiVTable*, void* ctx, uint32_t epoch);
  bool (*adapterCancel)(const RnrsAdapter*, uint64_t id);
  uint32_t (*adapterTeardown)(const RnrsAdapter*, uint32_t reason);  // any thread
  void (*adapterFree)(RnrsAdapter*);
  bool (*adapterMethodFind)(const RnrsAdapter*, const char* name, size_t len, uint32_t* index, bool* isAsync);
  void* (*nativeShare)(const void* native);
  const char* (*nativeSpecName)(const void* native, size_t* len);
  void (*nativeRelease)(void*);                          // any thread
  void (*bytesFree)(uint8_t* ptr, size_t len, size_t cap);  // any thread
  void (*diagnostics)(uint64_t* out);                    // null unless built with diagnostics
  const RnrsSurfaceV1* surface;                          // null unless the module renders to surfaces
};

// Called by a binary exactly once per claim it was given (RnrsSurfaceV1::attach), after it has
// released its own reference to the claimed window; any thread, with no lock of the binary held.
typedef void (*RnrsSurfaceRelease)(uint64_t claim);
// One binary's rnrs-surface (packages/surface/rust/src/host.rs): every module of that binary
// that renders to surfaces points at the same static table. Surface keys are owner * 2^32 +
// local, where owner is the number this table was bound to; the host routes platform calls by
// that owner. Main/UI thread for every entry except bind (registry init) and liveSurfaces.
struct RnrsSurfaceV1 {
  // Frozen in every version.
  uint32_t abi;   // RNRS_SURFACE_ABI the binary was built for
  uint32_t size;  // sizeof(RnrsSurfaceV1) as the binary was built
  // Once, before any surface exists. False if already bound to another owner.
  bool (*bind)(uint32_t owner, RnrsSurfaceRelease release);
  // Takes ownership of the window and of `claim` on every path, accepted or refused (Android:
  // `window` is one ANativeWindow reference, `layer` null; iOS: `window` the view and `layer` its
  // CAMetalLayer, both retained by the binary). > 0 the attachment, -1 busy, 0 refused.
  int64_t (*attach)(uint64_t key, void* window, void* layer, uint32_t width, uint32_t height, float scale, uint64_t claim);
  bool (*resize)(uint64_t key, uint64_t attachment, uint32_t width, uint32_t height, float scale);
  // Android: revokes and waits up to timeoutMs for the renderer; false if it timed out.
  bool (*detach)(uint64_t key, uint64_t attachment, uint32_t timeoutMs);
  // iOS: revokes without waiting: 0 released, 1 retiring, -1 stale.
  int32_t (*revoke)(uint64_t key, uint64_t attachment);
  bool (*touch)(uint64_t key, uint64_t attachment, int32_t phase, int32_t pointer, float x, float y, int64_t timeMs);
  uint32_t (*liveSurfaces)();
};
typedef const RnrsModuleV2* (*RnrsModuleGetter)();
// One entry of the generated registry (rnrs_registry.inc).
struct RnrsModuleEntry {
  const char* symbol;
  RnrsModuleGetter getter;
};
}

// The ABI contract (rnrs-android's `abi_contract` test pins the same): every field after the
// four uint32_t header fields is pointer-sized, in this order.
#define RNRS_SLOT(type, field, i) \
  static_assert(offsetof(type, field) == (i) * sizeof(void*), #type "." #field " offset")
#define RNRS_TABLE_SLOT(field, i) \
  static_assert(offsetof(RnrsModuleV2, field) == 4 * sizeof(uint32_t) + (i) * sizeof(void*), "RnrsModuleV2." #field " offset")
static_assert(offsetof(RnrsModuleV2, abi) == 0 && offsetof(RnrsModuleV2, size) == 4, "frozen RnrsModuleV2 prefix");
static_assert(offsetof(RnrsModuleV2, vtableSize) == 8 && offsetof(RnrsModuleV2, scalarBindingSize) == 12, "RnrsModuleV2 header");
RNRS_TABLE_SLOT(name, 0); RNRS_TABLE_SLOT(nameLen, 1); RNRS_TABLE_SLOT(hash, 2); RNRS_TABLE_SLOT(hashLen, 3);
RNRS_TABLE_SLOT(build, 4); RNRS_TABLE_SLOT(buildLen, 5); RNRS_TABLE_SLOT(def, 6); RNRS_TABLE_SLOT(init, 7);
RNRS_TABLE_SLOT(setAppDataDir, 8); RNRS_TABLE_SLOT(adapterNew, 9); RNRS_TABLE_SLOT(adapterScalar, 10);
RNRS_TABLE_SLOT(scalarCall, 11); RNRS_TABLE_SLOT(adapterCall, 12); RNRS_TABLE_SLOT(adapterDrain, 13);
RNRS_TABLE_SLOT(adapterStats, 14); RNRS_TABLE_SLOT(adapterCancel, 15); RNRS_TABLE_SLOT(adapterTeardown, 16);
RNRS_TABLE_SLOT(adapterFree, 17); RNRS_TABLE_SLOT(adapterMethodFind, 18); RNRS_TABLE_SLOT(nativeShare, 19);
RNRS_TABLE_SLOT(nativeSpecName, 20); RNRS_TABLE_SLOT(nativeRelease, 21); RNRS_TABLE_SLOT(bytesFree, 22);
RNRS_TABLE_SLOT(diagnostics, 23); RNRS_TABLE_SLOT(surface, 24);
static_assert(sizeof(RnrsModuleV2) == 4 * sizeof(uint32_t) + 25 * sizeof(void*), "RnrsModuleV2 size");
#define RNRS_SURFACE_SLOT(field, i) \
  static_assert(offsetof(RnrsSurfaceV1, field) == 2 * sizeof(uint32_t) + (i) * sizeof(void*), "RnrsSurfaceV1." #field " offset")
static_assert(offsetof(RnrsSurfaceV1, abi) == 0 && offsetof(RnrsSurfaceV1, size) == 4, "frozen RnrsSurfaceV1 prefix");
RNRS_SURFACE_SLOT(bind, 0); RNRS_SURFACE_SLOT(attach, 1); RNRS_SURFACE_SLOT(resize, 2); RNRS_SURFACE_SLOT(detach, 3);
RNRS_SURFACE_SLOT(revoke, 4); RNRS_SURFACE_SLOT(touch, 5); RNRS_SURFACE_SLOT(liveSurfaces, 6);
static_assert(sizeof(RnrsSurfaceV1) == 2 * sizeof(uint32_t) + 7 * sizeof(void*), "RnrsSurfaceV1 size");
#undef RNRS_SURFACE_SLOT
RNRS_SLOT(JsiVTable, kind, 0); RNRS_SLOT(JsiVTable, toNumber, 1); RNRS_SLOT(JsiVTable, toBool, 2);
RNRS_SLOT(JsiVTable, getProperty, 3); RNRS_SLOT(JsiVTable, arrayLength, 4); RNRS_SLOT(JsiVTable, getIndex, 5);
RNRS_SLOT(JsiVTable, undefinedValue, 6); RNRS_SLOT(JsiVTable, nullValue, 7); RNRS_SLOT(JsiVTable, number, 8);
RNRS_SLOT(JsiVTable, boolean, 9); RNRS_SLOT(JsiVTable, string, 10); RNRS_SLOT(JsiVTable, object, 11);
RNRS_SLOT(JsiVTable, setProperty, 12); RNRS_SLOT(JsiVTable, array, 13); RNRS_SLOT(JsiVTable, setIndex, 14);
RNRS_SLOT(JsiVTable, wrapNative, 15); RNRS_SLOT(JsiVTable, unwrapNative, 16); RNRS_SLOT(JsiVTable, toBytes, 17);
RNRS_SLOT(JsiVTable, newBytes, 18); RNRS_SLOT(JsiVTable, toStringInto, 19); RNRS_SLOT(JsiVTable, numberArray, 20);
static_assert(sizeof(JsiVTable) == 21 * sizeof(void*), "JsiVTable size");
static_assert(offsetof(RnrsScalarBinding, args) == 0 && offsetof(RnrsScalarBinding, result) == 4 &&
                  offsetof(RnrsScalarBinding, definition) == 8 &&
                  offsetof(RnrsScalarBinding, instance) == 8 + sizeof(void*) &&
                  sizeof(RnrsScalarBinding) == 8 + 2 * sizeof(void*),
    "RnrsScalarBinding layout");
#undef RNRS_SLOT
#undef RNRS_TABLE_SLOT

// Status codes and callback values of this ABI (pinned with the layout).
namespace rnrs::abi {
constexpr uint32_t kCallOk = 0, kCallError = 1, kCallThrown = 2;  // adapterCall, scalarCall
constexpr uint32_t kErrorType = 0, kErrorRange = 1, kErrorPlain = 2;  // errorKind
constexpr uint32_t kTeardownExplicit = 0, kTeardownLifecycle = 1, kTeardownDestructor = 2, kTeardownRefused = 3;
constexpr uint32_t kUnwrapOk = 0, kUnwrapNotNative = 1, kUnwrapClosed = 2, kUnwrapDisposed = 3;
// JsiVTable::kind: index into the binary's Kind table.
constexpr uint32_t kKindUndefined = 0, kKindNull = 1, kKindBoolean = 2, kKindNumber = 3, kKindString = 4,
                   kKindArray = 5, kKindFunction = 6, kKindObject = 7, kKindOther = 8;
// JsiVTable::toBytes (1-5 are the bufferKind helper's codes).
constexpr uint32_t kBytesOk = 0, kBytesNotArrayBuffer = 1, kBytesShared = 2, kBytesResizable = 3, kBytesDetached = 4,
                   kBytesView = 5, kBytesThrown = 6, kBytesTooLarge = 7;
constexpr uint32_t kNumbersOk = 0, kNumbersInvalid = 1, kNumbersThrown = 2;  // JsiVTable::numberArray
// RnrsDeliveryCallback results (RnrsDelivery.h's DeliveryValue is checked against these).
constexpr uint8_t kDeliveryResultQueued = 0, kDeliveryResultRunning = 1, kDeliveryResultDone = 2, kDeliveryResultDropped = 3;
// Produced by the binary for the JS runtime (packages/runtime/src/runtime.ts), passed through
// unchanged by C++: settlement statuses and admission failure codes.
constexpr uint32_t kSettleOk = 0, kSettleCancelled = 1, kSettleFailed = 2, kSettleLost = 3;
constexpr double kAdmitClosed = -1, kAdmitOverloaded = -2, kAdmitSaturated = -3;
// RnrsSurfaceV1: surface keys (owner in the high bits) and attach/revoke results.
constexpr unsigned kSurfaceOwnerShift = 32;
constexpr uint64_t kSurfaceOwnerLimit = uint64_t{1} << 21;  // owners stay below this, so keys are < 2^53
constexpr int64_t kAttachRefused = 0, kAttachBusy = -1;
constexpr int32_t kRevokeReleased = 0, kRevokeRetiring = 1, kRevokeStale = -1;
}  // namespace rnrs::abi
