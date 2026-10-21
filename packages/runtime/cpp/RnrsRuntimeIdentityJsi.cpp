#include "RnrsRuntimeIdentityJsi.h"

using namespace facebook;

namespace rnrs {
namespace {
// Fixed key of the framework's runtime-data slot.
const jsi::UUID kIdentityKey(0x5f0c2a91, 0x7d3e, 0x4b6a, 0x9e21, 0x3c8f4d17a6b5ULL);
}  // namespace

std::shared_ptr<RuntimeIdentity> findRuntimeIdentity(jsi::Runtime& rt) {
  auto data = rt.getRuntimeData(kIdentityKey);
  return data ? std::static_pointer_cast<RuntimeIdentityHolder>(data)->identity : nullptr;
}

std::shared_ptr<RuntimeIdentity> runtimeIdentity(jsi::Runtime& rt) {
  if (auto existing = findRuntimeIdentity(rt)) return existing;
  auto identity = std::make_shared<RuntimeIdentity>(nextRuntimeIdentityId());
  rt.setRuntimeData(kIdentityKey, std::make_shared<RuntimeIdentityHolder>(identity));
  return identity;
}

}  // namespace rnrs
