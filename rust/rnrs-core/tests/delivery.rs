// Host::monitor_delivery: a posted wake that the platform dropped (React Native 0.88's
// scheduler clears its queue when a task throws) is posted again; a wake that is merely
// queued or running is never posted again; nothing is scheduled while nothing is posted;
// checks stop at teardown. Time is simulated: the fake timer records checks and the test
// runs them.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rnrs_core::*;

/// Records scheduled checks; `fire` runs the oldest one.
#[derive(Default)]
struct FakeTimer {
    pending: Mutex<Vec<(Duration, Box<dyn FnOnce() + Send>)>>,
}

impl Timer for FakeTimer {
    fn after(&self, delay: Duration, task: Box<dyn FnOnce() + Send>) {
        self.pending.lock().unwrap().push((delay, task));
    }
}

impl FakeTimer {
    fn leaked() -> &'static FakeTimer {
        Box::leak(Box::default())
    }
    fn delays(&self) -> Vec<Duration> {
        self.pending.lock().unwrap().iter().map(|(d, _)| *d).collect()
    }
    /// Runs the oldest scheduled check; returns its delay.
    fn fire(&self) -> Option<Duration> {
        let next = {
            let mut pending = self.pending.lock().unwrap();
            if pending.is_empty() {
                None
            } else {
                Some(pending.remove(0))
            }
        };
        next.map(|(delay, task)| {
            task();
            delay
        })
    }
}

/// A platform wake whose fate the test sets; every notify starts a new post (Queued).
#[derive(Clone)]
struct Wake {
    posts: Arc<AtomicUsize>,
    state: Arc<Mutex<Delivery>>,
}

impl Wake {
    fn new() -> Self {
        Self { posts: Arc::default(), state: Arc::new(Mutex::new(Delivery::Unobserved)) }
    }
    fn set(&self, delivery: Delivery) {
        *self.state.lock().unwrap() = delivery;
    }
    fn posts(&self) -> usize {
        self.posts.load(Ordering::SeqCst)
    }
}

impl Notify for Wake {
    fn notify(&self) {
        self.posts.fetch_add(1, Ordering::SeqCst);
        *self.state.lock().unwrap() = Delivery::Queued;
    }
    fn delivery(&self) -> Delivery {
        *self.state.lock().unwrap()
    }
}

fn monitored() -> (Host<u32, Wake>, Wake, &'static FakeTimer) {
    let wake = Wake::new();
    let host = Host::new(16, wake.clone());
    let timer = FakeTimer::leaked();
    host.monitor_delivery(timer);
    (host, wake, timer)
}

/// Completes one operation, queueing its outcome (the empty → non-empty transition posts).
fn complete(host: &Host<u32, Wake>, value: u32) {
    host.admit().expect("admitted").finish(Ok(value));
}

/// What the JS-thread drain callback does: drain until empty.
fn drain_all(host: &Host<u32, Wake>, wake: &Wake) -> usize {
    wake.set(Delivery::Running);
    let mut total = 0;
    loop {
        let n = host.drain(16).len();
        total += n;
        if n == 0 {
            break;
        }
    }
    wake.set(Delivery::Done);
    total
}

const FIRST: Duration = DELIVERY_CHECK_FIRST;

#[test]
fn nothing_is_scheduled_while_idle() {
    let (host, wake, timer) = monitored();
    assert!(timer.delays().is_empty());
    complete(&host, 1);
    assert_eq!(wake.posts(), 1);
    assert_eq!(timer.delays(), vec![FIRST]);
    assert_eq!(drain_all(&host, &wake), 1);
    // The check finds the wake acknowledged and does not schedule another.
    assert_eq!(timer.fire(), Some(FIRST));
    assert!(timer.delays().is_empty());
    assert_eq!(wake.posts(), 1);
    assert_eq!(host.stats().redelivered, 0);
}

#[test]
fn a_queued_wake_is_never_posted_again_and_one_check_is_pending() {
    let (host, wake, timer) = monitored();
    complete(&host, 1);
    complete(&host, 2); // queue not empty: no second post
    assert_eq!(wake.posts(), 1);
    let mut delays = Vec::new();
    for _ in 0..10 {
        assert_eq!(timer.delays().len(), 1, "at most one check per host");
        delays.push(timer.fire().unwrap());
    }
    assert_eq!(wake.posts(), 1, "a slow (queued) drain is not posted again");
    assert_eq!(delays[..5], [FIRST, FIRST * 2, FIRST * 4, FIRST * 8, DELIVERY_CHECK_MAX]);
    assert!(delays[5..].iter().all(|d| *d == DELIVERY_CHECK_MAX));
    assert_eq!(drain_all(&host, &wake), 2);
}

#[test]
fn an_acknowledged_wake_resets_the_interval_for_the_next_one() {
    let (host, wake, timer) = monitored();
    complete(&host, 1);
    for _ in 0..5 {
        timer.fire(); // slow JS: the interval grows to the cap
    }
    assert_eq!(timer.delays(), vec![DELIVERY_CHECK_MAX]);
    assert_eq!(drain_all(&host, &wake), 1);
    // A new wake before the stale check fires: it reuses that check (one per host), and
    // the next interval starts from the beginning, not from the cap.
    complete(&host, 2);
    assert_eq!(wake.posts(), 2);
    assert_eq!(timer.delays().len(), 1);
    timer.fire();
    assert_eq!(timer.delays(), vec![FIRST * 2]);
}

#[test]
fn a_running_drain_is_never_posted_again() {
    let (host, wake, timer) = monitored();
    complete(&host, 1);
    wake.set(Delivery::Running);
    timer.fire();
    timer.fire();
    assert_eq!(wake.posts(), 1);
    assert_eq!(host.stats().redelivered, 0);
}

#[test]
fn a_dropped_wake_is_posted_again_with_backoff_until_drained() {
    let (host, wake, timer) = monitored();
    complete(&host, 7);
    let mut delays = Vec::new();
    for i in 0..7 {
        wake.set(Delivery::Dropped);
        timer.fire();
        assert_eq!(wake.posts(), 2 + i, "one new post per observed drop");
        assert_eq!(timer.delays().len(), 1);
        delays.push(timer.delays()[0]);
    }
    assert_eq!(delays, [FIRST, FIRST * 2, FIRST * 4, FIRST * 8, DELIVERY_CHECK_MAX, DELIVERY_CHECK_MAX, DELIVERY_CHECK_MAX]);
    assert_eq!(host.stats().redelivered, 7);
    // The re-posted wake runs: the outcome is delivered and the monitor stops.
    assert_eq!(drain_all(&host, &wake), 1);
    timer.fire();
    assert!(timer.delays().is_empty());
    // Backoff starts over for the next loss.
    complete(&host, 8);
    wake.set(Delivery::Dropped);
    timer.fire();
    assert_eq!(timer.delays(), vec![FIRST]);
}

#[test]
fn a_drain_that_returned_without_emptying_the_queue_is_retried() {
    let (host, wake, timer) = monitored();
    complete(&host, 1);
    // The callback ran but failed before draining (for example an exception in the drain).
    wake.set(Delivery::Running);
    wake.set(Delivery::Done);
    timer.fire();
    assert_eq!(wake.posts(), 2);
    assert_eq!(drain_all(&host, &wake), 1);
}

#[test]
fn a_push_during_a_drain_is_not_stranded() {
    let (host, wake, timer) = monitored();
    complete(&host, 1);
    wake.set(Delivery::Running);
    // The drain empties the queue (acknowledges); a worker then pushes before the callback
    // returns: that push sees the queue empty and posts a fresh wake.
    assert_eq!(host.drain(16).len(), 1);
    complete(&host, 2);
    assert_eq!(wake.posts(), 2);
    assert_eq!(wake.delivery(), Delivery::Queued);
    // The new post is dropped: the monitor posts again, and the outcome is delivered.
    wake.set(Delivery::Dropped);
    while host.stats().queued > 0 && timer.fire().is_some() {
        if wake.delivery() == Delivery::Queued {
            drain_all(&host, &wake);
        }
    }
    assert_eq!(host.stats().queued, 0);
    assert_eq!(wake.posts(), 3);
}

#[test]
fn a_partial_drain_keeps_the_wake_posted() {
    let (host, wake, timer) = monitored();
    for i in 0..3 {
        complete(&host, i);
    }
    wake.set(Delivery::Running);
    assert_eq!(host.drain(2).len(), 2);
    // The callback stopped early (exception) with one outcome left: retried.
    wake.set(Delivery::Done);
    timer.fire();
    assert_eq!(wake.posts(), 2);
    assert_eq!(drain_all(&host, &wake), 1);
}

#[test]
fn checks_stop_at_teardown_in_every_state() {
    for delivery in [Delivery::Queued, Delivery::Running, Delivery::Dropped, Delivery::Done] {
        let (host, wake, timer) = monitored();
        complete(&host, 1);
        wake.set(delivery);
        host.teardown();
        timer.fire();
        assert!(timer.delays().is_empty(), "{delivery:?}: no check after teardown");
        assert_eq!(wake.posts(), 1, "{delivery:?}: no post after teardown");
    }
}

#[test]
fn a_dropped_host_ends_its_checks() {
    let (host, wake, timer) = monitored();
    complete(&host, 1);
    wake.set(Delivery::Dropped);
    drop(host);
    timer.fire();
    assert!(timer.delays().is_empty());
    assert_eq!(wake.posts(), 1);
}

#[test]
fn unobserved_platforms_are_never_reposted() {
    let wake = Wake::new();
    let host = Host::new(16, wake.clone());
    let timer = FakeTimer::leaked();
    host.monitor_delivery(timer);
    complete(&host, 1);
    wake.set(Delivery::Unobserved);
    timer.fire();
    assert!(timer.delays().is_empty());
    assert_eq!(wake.posts(), 1);
}

#[test]
fn hosts_without_a_monitor_schedule_nothing() {
    let wake = Wake::new();
    let host: Host<u32, Wake> = Host::new(16, wake.clone());
    complete(&host, 1);
    wake.set(Delivery::Dropped);
    assert_eq!(wake.posts(), 1);
    assert_eq!(host.stats().redelivered, 0);
}

#[test]
fn enabling_the_monitor_while_a_wake_is_posted_arms_it() {
    let wake = Wake::new();
    let host = Host::new(16, wake.clone());
    complete(&host, 1);
    let timer = FakeTimer::leaked();
    host.monitor_delivery(timer);
    assert_eq!(timer.delays(), vec![FIRST]);
}
