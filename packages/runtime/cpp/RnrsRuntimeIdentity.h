#pragma once
// Runtime identity that survives address reuse.
// A `jsi::Runtime*` alone is not an identity: after a runtime is destroyed, the next one may
// be allocated at the same address. Each runtime that the framework binds to gets one
// RuntimeIdentity, stored with the runtime through public JSI runtime data
// (RnrsRuntimeIdentityJsi.cpp). The runtime releases that data when it is destroyed, which marks
// the identity destroyed, before the address can be reused. A RuntimeBinding (address plus
// identity) therefore accepts only the runtime it was made for: a foreign runtime has
// another address, and a later runtime at the same address finds the old identity destroyed.
//
// This header is pure C++ (no JSI), so the address-reuse rule is host-tested
// (native/tests/rnrs_runtime_identity_test.cpp).
#include <atomic>
#include <cstdint>
#include <memory>

namespace rnrs {

struct RuntimeIdentity {
  explicit RuntimeIdentity(uint64_t i) : id(i) {}
  // Process-unique, never 0 (0 reads as "none" in diagnostics).
  const uint64_t id;
  // Set once, by the runtime's destruction (any thread; no JSI).
  std::atomic<bool> destroyed{false};
};

// Owned by the runtime's data slot; its destruction is the runtime's destruction.
struct RuntimeIdentityHolder {
  explicit RuntimeIdentityHolder(std::shared_ptr<RuntimeIdentity> i) : identity(std::move(i)) {}
  ~RuntimeIdentityHolder() { identity->destroyed.store(true, std::memory_order_release); }
  RuntimeIdentityHolder(const RuntimeIdentityHolder&) = delete;
  RuntimeIdentityHolder& operator=(const RuntimeIdentityHolder&) = delete;
  const std::shared_ptr<RuntimeIdentity> identity;
};

inline uint64_t nextRuntimeIdentityId() {
  static std::atomic<uint64_t> next{1};
  return next.fetch_add(1, std::memory_order_relaxed);
}

// What a host function captures instead of a runtime: compared on every call with the
// calling runtime's address. One pointer compare and one atomic load; no lock or lookup.
class RuntimeBinding {
 public:
  RuntimeBinding(const void* address, std::shared_ptr<RuntimeIdentity> identity)
      : address_(address), identity_(std::move(identity)) {}
  bool accepts(const void* callingRuntime) const {
    return callingRuntime == address_ && !identity_->destroyed.load(std::memory_order_acquire);
  }
  uint64_t id() const { return identity_->id; }
  const void* address() const { return address_; }

 private:
  const void* address_;
  std::shared_ptr<RuntimeIdentity> identity_;
};

}  // namespace rnrs
