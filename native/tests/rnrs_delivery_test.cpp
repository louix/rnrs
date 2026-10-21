// Host test for RnrsDelivery.h (drain-post fate tracking), with a fake invoker that stores,
// copies, invokes and drops std::function closures the way React Native's CallInvoker and
// RuntimeScheduler do. Built with TSan by scripts/test-native.sh.
#include "RnrsDelivery.h"

#include <cassert>
#include <cstdio>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

using namespace rnrs;

namespace {

using Task = std::function<void()>;

// Mirrors notifyFromAnyThread: the poster keeps the state, the closure owns the guard.
struct Posted {
  std::shared_ptr<DeliveryState> state;
  Task task;
};

Posted post(std::function<void()> body) {
  auto p = makeDrainPost();
  Task task = [guard = std::move(p.guard), body = std::move(body)] { guard->run(body); };
  return {std::move(p.state), std::move(task)};
}

uint64_t dropped() { return drainsDroppedCounter().load(); }

void copiesDoNotFalseDrop() {
  auto before = dropped();
  auto p = post([] {});
  {
    Task copy = p.task;   // the scheduler/buffer copies the closure
    Task copy2 = copy;
  }                       // copies destroyed: the original still owns the guard
  assert(p.state->load() == kDeliveryQueued);
  Task moved = std::move(p.task);
  moved();                // one copy runs
  assert(p.state->load() == kDeliveryDone);
  moved = nullptr;        // destroyed after running: not a drop
  assert(p.state->load() == kDeliveryDone);
  assert(dropped() == before);
  std::puts("copies: ok");
}

void droppedUnrun() {
  auto before = dropped();
  auto p = post([] {});
  Task queued = p.task;   // a copy in the queue
  p.task = nullptr;
  assert(p.state->load() == kDeliveryQueued);
  queued = nullptr;       // clearQueues: the last copy destroyed unrun
  assert(p.state->load() == kDeliveryDropped);
  assert(dropped() == before + 1);
  std::puts("dropped: ok");
}

void runningThenDone() {
  std::shared_ptr<DeliveryState> state;
  uint8_t seen = 255;
  auto p = post([&] { seen = state->load(); });
  state = p.state;
  p.task();
  assert(seen == kDeliveryRunning);
  assert(state->load() == kDeliveryDone);
  std::puts("running/done: ok");
}

void bodyThrowsStillDone() {
  auto p = post([] { throw std::runtime_error("drain failed"); });
  try {
    p.task();
    assert(false);
  } catch (const std::runtime_error&) {
  }
  assert(p.state->load() == kDeliveryDone);
  std::puts("throw: ok");
}

void retainedForeverStaysQueued() {
  auto p = post([] {});
  std::vector<Task> queue{std::move(p.task)};  // never run, never dropped (JS blocked)
  for (int i = 0; i < 1000; i++) assert(p.state->load() == kDeliveryQueued);
  queue.clear();
  assert(p.state->load() == kDeliveryDropped);
  std::puts("retained: ok");
}

// The destructor may run while the scheduler holds its queue mutex (clearQueues) or while
// Rust holds the host lock (an invoker that drops the closure inside invokeAsync); it must
// take neither. Destroy under a held mutex, and concurrently read the state as the host
// monitor does (TSan).
void dropUnderHeldMutexAndConcurrentRead() {
  std::mutex schedulerMutex;
  auto p = post([] {});
  std::vector<Task> queue{std::move(p.task)};
  std::thread reader([state = p.state] {
    for (int i = 0; i < 100000; i++) {
      auto v = state->load();
      assert(v == kDeliveryQueued || v == kDeliveryDropped);
    }
  });
  {
    std::lock_guard<std::mutex> lock(schedulerMutex);
    queue = {};  // like `taskQueue_ = {}` under schedulingMutex_
  }
  reader.join();
  assert(p.state->load() == kDeliveryDropped);
  std::puts("drop under mutex: ok");
}

// An invoker whose scheduler is gone drops the closure inside the call, on the posting
// thread (React Native's invokers do when their scheduler weak_ptr has expired).
void droppedInsideInvoke() {
  std::mutex hostLock;
  std::shared_ptr<DeliveryState> state;
  auto invokeAsync = [](Task&& task) { Task local = std::move(task); };  // destroyed here
  {
    std::lock_guard<std::mutex> lock(hostLock);  // Rust calls notify under its host lock
    auto p = post([] {});
    state = p.state;
    invokeAsync(std::move(p.task));
  }
  assert(state->load() == kDeliveryDropped);
  std::puts("dropped inside invoke: ok");
}

// A closure run on another thread (the JS thread) after posting: Running/Done published.
void runOnAnotherThread() {
  auto p = post([] {});
  std::thread js([task = p.task]() mutable { task(); task = nullptr; });
  p.task = nullptr;
  js.join();
  assert(p.state->load() == kDeliveryDone);
  std::puts("cross-thread run: ok");
}

}  // namespace

int main() {
  copiesDoNotFalseDrop();
  droppedUnrun();
  runningThenDone();
  bodyThrowsStillDone();
  retainedForeverStaysQueued();
  dropUnderHeldMutexAndConcurrentRead();
  droppedInsideInvoke();
  runOnAnotherThread();
  std::puts("rnrs_delivery_test: ok");
}
