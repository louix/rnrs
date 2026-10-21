#pragma once
// Fate of a posted drain task, observable without owning it. React Native 0.88's
// RuntimeScheduler destroys queued tasks unrun when another task throws (clearQueues), so a
// drain can be dropped while the runtime keeps running. The task's closure owns a DrainGuard
// (shared by every std::function copy); the poster keeps only the DeliveryState. The Rust
// host reads the state under its lock (Notify::delivery) and posts again only on Dropped, or
// on Done while outcomes remain queued; never while Queued or Running.
//
// The guard's destructor only touches atomics: it may run under the scheduler's queue mutex
// (clearQueues) or under the Rust host lock (an invoker that drops the closure inside
// invokeAsync). Pure C++, shared by Android and iOS, host-tested in
// native/tests/rnrs_delivery_test.cpp.
#include <atomic>
#include <cstdint>
#include <memory>
#include <utility>

namespace rnrs {

// Values match rnrs-android's DeliveryCallback mapping.
enum DeliveryValue : uint8_t { kDeliveryQueued = 0, kDeliveryRunning = 1, kDeliveryDone = 2, kDeliveryDropped = 3 };

struct DeliveryState {
  std::atomic<uint8_t> value{kDeliveryQueued};
  uint8_t load() const { return value.load(std::memory_order_acquire); }
};

// Process-wide count of drains destroyed unrun (diagnostics).
inline std::atomic<uint64_t>& drainsDroppedCounter() {
  static std::atomic<uint64_t> count{0};
  return count;
}

// Owned by the drain closure. Only the last copy's destruction can mark the state Dropped,
// and only if the closure never started.
class DrainGuard {
 public:
  explicit DrainGuard(std::shared_ptr<DeliveryState> state) : state_(std::move(state)) {}
  DrainGuard(const DrainGuard&) = delete;
  DrainGuard& operator=(const DrainGuard&) = delete;
  ~DrainGuard() {
    uint8_t queued = kDeliveryQueued;
    if (state_->value.compare_exchange_strong(queued, kDeliveryDropped, std::memory_order_acq_rel))
      drainsDroppedCounter().fetch_add(1, std::memory_order_relaxed);
  }

  // Runs the drain body: Running while it executes, Done on every exit path. The body must
  // not throw (callers catch); Done is stored even if it does.
  template <typename Body>
  void run(Body&& body) {
    state_->value.store(kDeliveryRunning, std::memory_order_release);
    struct Exit {
      DeliveryState& s;
      ~Exit() { s.value.store(kDeliveryDone, std::memory_order_release); }
    } exit{*state_};
    std::forward<Body>(body)();
  }

 private:
  std::shared_ptr<DeliveryState> state_;
};

// A fresh state and the guard for one post. The caller keeps `state` (to observe) and moves
// `guard` into the closure.
struct DrainPost {
  std::shared_ptr<DeliveryState> state;
  std::shared_ptr<DrainGuard> guard;
};

inline DrainPost makeDrainPost() {
  auto state = std::make_shared<DeliveryState>();
  auto guard = std::make_shared<DrainGuard>(state);
  return {std::move(state), std::move(guard)};
}

}  // namespace rnrs
