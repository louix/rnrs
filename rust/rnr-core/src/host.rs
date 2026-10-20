use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use crate::budget::{Budget, BudgetStats};
use crate::cancel::{lock, CancelToken};

/// Wakes the JS-runtime side when the outcome queue becomes non-empty.
///
/// Called with the host lock held, so it must only schedule work (for example post a
/// task to the JS thread) and never call back into the host. It is never called after
/// `Host::teardown` returns.
pub trait Notify {
    fn notify(&self);

    /// What became of the latest wake `notify` posted, if the platform can observe it.
    /// Called with the host lock held: it must only read state (no blocking, no call back
    /// into the host). Default: not observable, so the host never posts a wake again.
    fn delivery(&self) -> Delivery {
        Delivery::Unobserved
    }
}

/// The fate of the latest posted wake (`Notify::delivery`). Only `Dropped`, and `Done` while
/// the outcome queue was not emptied, make a monitored host post again; `Queued` and
/// `Running` never do (the JS thread may just be busy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// The platform cannot tell.
    Unobserved,
    /// Posted, not started.
    Queued,
    /// The drain callback is executing.
    Running,
    /// The drain callback returned (normally or after catching an error).
    Done,
    /// The callback was destroyed without running (for example React Native 0.88's
    /// RuntimeScheduler clears its queue when another task throws).
    Dropped,
}

/// Delayed callbacks for the delivery monitor (`Host::monitor_delivery`). A backend opts in
/// by providing one; hosts without it never post a wake again.
pub trait Timer: Send + Sync {
    fn after(&self, delay: Duration, task: Box<dyn FnOnce() + Send>);
}

/// First monitor check after a wake is posted, and the first re-post backoff.
pub const DELIVERY_CHECK_FIRST: Duration = Duration::from_millis(250);
/// Upper bound of the monitor's check interval and re-post backoff.
pub const DELIVERY_CHECK_MAX: Duration = Duration::from_secs(4);

/// A multithreaded executor. Futures must be `Send`.
pub trait Spawn {
    fn spawn(&self, task: Pin<Box<dyn Future<Output = ()> + Send + 'static>>);
}

/// A single-threaded executor on the JS thread (browser). Futures may be `!Send`.
pub trait SpawnLocal {
    fn spawn_local(&self, task: Pin<Box<dyn Future<Output = ()> + 'static>>);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpError {
    /// Cancellation won the race; the work may still be running.
    Cancelled,
    /// The implementation returned an error.
    Failed(String),
    /// The executor dropped the task before it produced a result.
    Lost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmitError {
    Closed,
    /// This host's `max_in_flight` slots are in use (running work or undrained outcomes).
    Overloaded,
    /// The executor-wide [`Budget`] is full, possibly with work from closed generations.
    /// Carries the budget snapshot taken when admission was refused.
    Saturated(BudgetStats),
}

impl fmt::Display for AdmitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AdmitError::Closed => f.write_str("runtime adapter is closed"),
            AdmitError::Overloaded => f.write_str("too many operations in flight on this module"),
            AdmitError::Saturated(b) => write!(
                f,
                "executor budget exhausted: {}/{} operations running, {} of them from closed runtimes; retry after they exit",
                b.running, b.limit, b.orphaned
            ),
        }
    }
}

/// What `Host::teardown` did. `still_running` work drains independently.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TeardownReport {
    /// Pending operations cancelled (their promises are abandoned with the runtime, or
    /// rejected by the JS wrapper on explicit teardown).
    pub cancelled: usize,
    /// Terminal outcomes queued for JS and dropped unconverted.
    pub discarded_queued: usize,
    /// Work that had not exited; it keeps its memory and budget permit until it does.
    pub still_running: usize,
}

pub struct Outcome<R> {
    pub id: u64,
    pub result: Result<R, OpError>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HostStats {
    pub generation: u64,
    pub open: bool,
    /// Admitted operations without a terminal outcome.
    pub pending: usize,
    /// Admitted operations whose work has not exited.
    pub in_flight: usize,
    /// Admission slots in use, bounded by `max_in_flight`: operations whose work is still
    /// running or whose outcome has not yet been drained (an operation counts once).
    pub slots: usize,
    /// Terminal outcomes waiting for the JS thread.
    pub queued: usize,
    pub admitted: u64,
    pub delivered: u64,
    /// Results that arrived after cancellation or teardown and were dropped unconverted.
    pub discarded: u64,
    pub lost: u64,
    /// Wakes posted again because the previous one was dropped, or its drain returned
    /// without emptying the queue.
    pub redelivered: u64,
}

/// Operation registry for one JS runtime instance (one adapter generation).
///
/// Every admitted operation gets exactly one terminal outcome while the host is open:
/// completion, cancellation or loss. The winner is decided by removing the operation
/// from `pending` under the lock. After teardown no outcome is delivered and the
/// notifier is released.
pub struct Host<R, N: Notify> {
    inner: Arc<Inner<R, N>>,
}

struct Inner<R, N> {
    generation: u64,
    max_in_flight: usize,
    budget: Budget,
    state: Mutex<State<R, N>>,
    /// Mirror of `state.open`, written under the state lock, so `is_open` (checked on every
    /// call) does not take the lock. Same race as before: a call may observe "open" just
    /// before a concurrent teardown, which admission then refuses under the lock.
    open: std::sync::atomic::AtomicBool,
}

struct State<R, N> {
    open: bool,
    next_id: u64,
    pending: HashMap<u64, CancelToken>,
    in_flight: usize,
    /// Per-operation slot holds (`RUNNING` and/or `QUEUED`); an entry is the slot.
    slots: HashMap<u64, u8>,
    outcomes: VecDeque<Outcome<R>>,
    notify: Option<N>,
    /// A wake was posted and no drain has yet observed the outcome queue empty. Cleared by
    /// that drain call under this lock, so a push either sees it cleared and posts, or lands
    /// before the drain's observation and is drained by it.
    posted: bool,
    /// Schedules one delivery-monitor check after a delay (`Host::monitor_delivery`).
    monitor: Option<Arc<dyn Fn(Duration) + Send + Sync>>,
    /// A monitor check is scheduled; at most one per host.
    monitor_armed: bool,
    /// Delay before the next monitor check.
    check_after: Duration,
    /// Consecutive re-posts without the queue being emptied (backoff exponent).
    failures: u32,
    admitted: u64,
    delivered: u64,
    discarded: u64,
    lost: u64,
    redelivered: u64,
}

static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

impl<R, N: Notify> Clone for Host<R, N> {
    fn clone(&self) -> Self {
        Self { inner: Arc::clone(&self.inner) }
    }
}

impl<R, N: Notify> Host<R, N> {
    /// A host bounded only by its own `max_in_flight`.
    pub fn new(max_in_flight: usize, notify: N) -> Self {
        Self::with_budget(max_in_flight, Budget::unlimited(), notify)
    }

    /// A host whose running work also counts against a budget shared with other hosts
    /// (typically every runtime generation using the same executor).
    pub fn with_budget(max_in_flight: usize, budget: Budget, notify: N) -> Self {
        Self {
            inner: Arc::new(Inner {
                generation: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
                max_in_flight,
                budget,
                open: std::sync::atomic::AtomicBool::new(true),
                state: Mutex::new(State {
                    open: true,
                    next_id: 1,
                    pending: HashMap::new(),
                    in_flight: 0,
                    slots: HashMap::new(),
                    outcomes: VecDeque::new(),
                    notify: Some(notify),
                    posted: false,
                    monitor: None,
                    monitor_armed: false,
                    check_after: DELIVERY_CHECK_FIRST,
                    failures: 0,
                    admitted: 0,
                    delivered: 0,
                    discarded: 0,
                    lost: 0,
                    redelivered: 0,
                }),
            }),
        }
    }

    pub fn generation(&self) -> u64 {
        self.inner.generation
    }

    pub fn budget(&self) -> &Budget {
        &self.inner.budget
    }

    /// Reserves an admission slot. The returned ticket must travel with the work. The slot
    /// is released only when the work has exited (ticket dropped) and its outcome, if any,
    /// has been drained or discarded, so undrained results are bounded too.
    pub fn admit(&self) -> Result<Ticket<R, N>, AdmitError> {
        let mut state = lock(&self.inner.state);
        if !state.open {
            return Err(AdmitError::Closed);
        }
        if state.slots.len() >= self.inner.max_in_flight {
            return Err(AdmitError::Overloaded);
        }
        self.inner.budget.try_acquire().map_err(AdmitError::Saturated)?;
        let id = state.next_id;
        state.next_id += 1;
        let token = CancelToken::new();
        state.pending.insert(id, token.clone());
        state.in_flight += 1;
        state.slots.insert(id, RUNNING);
        state.admitted += 1;
        Ok(Ticket { host: self.clone(), id, token, result: None })
    }

    /// Admits and spawns work on a multithreaded executor. `work` receives the
    /// operation's cancel token and must own everything it uses (receiver, arguments).
    pub fn start<S, W, F>(&self, spawner: &S, work: W) -> Result<u64, AdmitError>
    where
        S: Spawn + ?Sized,
        W: FnOnce(CancelToken) -> F,
        F: Future<Output = Result<R, String>> + Send + 'static,
        R: Send + 'static,
        N: Send + 'static,
    {
        let ticket = self.admit()?;
        let id = ticket.id;
        let work = work(ticket.token.clone());
        spawner.spawn(Box::pin(run(ticket, work)));
        Ok(id)
    }

    /// Admits and spawns work on the JS-thread executor; no `Send` bound.
    pub fn start_local<S, W, F>(&self, spawner: &S, work: W) -> Result<u64, AdmitError>
    where
        S: SpawnLocal + ?Sized,
        W: FnOnce(CancelToken) -> F,
        F: Future<Output = Result<R, String>> + 'static,
        R: 'static,
        N: 'static,
    {
        let ticket = self.admit()?;
        let id = ticket.id;
        let work = work(ticket.token.clone());
        spawner.spawn_local(Box::pin(run(ticket, work)));
        Ok(id)
    }

    /// Requests cooperative cancellation. Returns true if cancellation won, in which case
    /// a `Cancelled` outcome is queued at once; the work keeps its memory until it exits.
    pub fn cancel(&self, id: u64) -> bool {
        let token = {
            let mut state = lock(&self.inner.state);
            let Some(token) = state.pending.remove(&id) else { return false };
            state.push(Outcome { id, result: Err(OpError::Cancelled) });
            token
        };
        token.cancel();
        true
    }

    /// Removes up to `max` queued outcomes. Call on the JS thread.
    pub fn drain(&self, max: usize) -> Vec<Outcome<R>> {
        let mut state = lock(&self.inner.state);
        let n = max.min(state.outcomes.len());
        let drained: Vec<Outcome<R>> = state.outcomes.drain(..n).collect();
        for outcome in &drained {
            state.release(outcome.id, QUEUED);
        }
        if state.outcomes.is_empty() {
            // The acknowledgement: this drain observed the queue empty, under the lock.
            state.posted = false;
            state.failures = 0;
            // A check still scheduled from this wake must not carry its grown interval
            // into the next wake (it reschedules with this value).
            state.check_after = DELIVERY_CHECK_FIRST;
        }
        drained
    }

    /// Stops admission, cancels all pending work, drops queued outcomes and releases the
    /// notifier. Running work drains independently; its results are discarded, and it
    /// keeps its budget permit until it exits. Does not block on that work, does not touch
    /// any JS runtime, and may be called from any thread. Idempotent.
    pub fn teardown(&self) -> TeardownReport {
        let (tokens, outcomes, notify, still_running) = {
            let mut state = lock(&self.inner.state);
            if !state.open {
                return TeardownReport::default();
            }
            state.open = false;
            self.inner.open.store(false, Ordering::Release);
            self.inner.budget.orphan(state.in_flight);
            let tokens: Vec<CancelToken> = state.pending.drain().map(|(_, t)| t).collect();
            let outcomes = std::mem::take(&mut state.outcomes);
            for outcome in &outcomes {
                state.release(outcome.id, QUEUED);
            }
            state.discarded += outcomes.len() as u64;
            (tokens, outcomes, state.notify.take(), state.in_flight)
        };
        let report = TeardownReport { cancelled: tokens.len(), discarded_queued: outcomes.len(), still_running };
        // Release values and the notifier outside the lock.
        drop(outcomes);
        drop(notify);
        for token in &tokens {
            token.cancel();
        }
        report
    }

    pub fn is_open(&self) -> bool {
        self.inner.open.load(Ordering::Acquire)
    }

    pub fn stats(&self) -> HostStats {
        let state = lock(&self.inner.state);
        HostStats {
            generation: self.inner.generation,
            open: state.open,
            pending: state.pending.len(),
            in_flight: state.in_flight,
            slots: state.slots.len(),
            queued: state.outcomes.len(),
            admitted: state.admitted,
            delivered: state.delivered,
            discarded: state.discarded,
            lost: state.lost,
            redelivered: state.redelivered,
        }
    }
}

impl<R: Send + 'static, N: Notify + Send + 'static> Host<R, N> {
    /// Opts this host into posting lost wakes again. While a posted wake is not
    /// acknowledged (no drain has observed the queue empty), one monitor check at a time
    /// runs on `timer`. A `Queued` or `Running` wake is left alone; a `Dropped` wake, or a
    /// `Done` drain that left outcomes queued, is posted again with backoff (250 ms doubling
    /// to 4 s). So at most one wake is outstanding, nothing is scheduled while nothing is
    /// posted, and checks stop at teardown. The monitor holds the host weakly.
    pub fn monitor_delivery(&self, timer: &'static dyn Timer) {
        let weak = Arc::downgrade(&self.inner);
        let schedule: Arc<dyn Fn(Duration) + Send + Sync> = Arc::new(move |delay| {
            let weak = weak.clone();
            timer.after(delay, Box::new(move || Self::check_delivery(&weak)));
        });
        let mut state = lock(&self.inner.state);
        state.monitor = Some(schedule);
        if state.posted {
            state.arm_monitor();
        }
    }

    fn check_delivery(weak: &Weak<Inner<R, N>>) {
        let Some(inner) = weak.upgrade() else { return };
        let mut state = lock(&inner.state);
        state.monitor_armed = false;
        if !state.open || !state.posted {
            return;
        }
        let Some(delivery) = state.notify.as_ref().map(Notify::delivery) else { return };
        match delivery {
            Delivery::Unobserved => return,
            Delivery::Queued | Delivery::Running => {
                state.check_after = (state.check_after * 2).min(DELIVERY_CHECK_MAX);
            }
            Delivery::Dropped | Delivery::Done => {
                state.failures = state.failures.saturating_add(1);
                state.redelivered += 1;
                if let Some(notify) = &state.notify {
                    notify.notify();
                }
                let exponent = (state.failures - 1).min(4);
                state.check_after = (DELIVERY_CHECK_FIRST * (1 << exponent)).min(DELIVERY_CHECK_MAX);
            }
        }
        let delay = state.check_after;
        state.arm_monitor_after(delay);
    }
}

const RUNNING: u8 = 1;
const QUEUED: u8 = 2;

impl<R, N: Notify> State<R, N> {
    /// Drops one hold; the slot is free once neither the work nor its outcome remains.
    fn release(&mut self, id: u64, hold: u8) {
        if let Some(holds) = self.slots.get_mut(&id) {
            *holds &= !hold;
            if *holds == 0 {
                self.slots.remove(&id);
            }
        }
    }

    fn push(&mut self, outcome: Outcome<R>) {
        let was_empty = self.outcomes.is_empty();
        if let Some(holds) = self.slots.get_mut(&outcome.id) {
            *holds |= QUEUED;
        }
        self.outcomes.push_back(outcome);
        self.delivered += 1;
        if was_empty {
            if let Some(notify) = &self.notify {
                notify.notify();
                self.posted = true;
                self.arm_monitor();
            }
        }
    }

    /// Schedules the first check for a fresh wake, unless a check is already scheduled.
    fn arm_monitor(&mut self) {
        if !self.monitor_armed {
            self.check_after = DELIVERY_CHECK_FIRST;
            self.arm_monitor_after(DELIVERY_CHECK_FIRST);
        }
    }

    fn arm_monitor_after(&mut self, delay: Duration) {
        if let Some(schedule) = &self.monitor {
            self.monitor_armed = true;
            schedule(delay);
        }
    }
}

// Declaring `ticket` before `work` matters: if the executor drops this future while it
// is suspended, locals drop in reverse order, so the work (receiver, arguments) is
// released before the ticket reports the loss and frees the in-flight slot.
async fn run<R, N: Notify, F: Future<Output = Result<R, String>>>(ticket: Ticket<R, N>, work: F) {
    let mut ticket = ticket;
    let work = work;
    let result = work.await;
    ticket.result = Some(result);
}

/// Proof of admission carried by running work.
pub struct Ticket<R, N: Notify> {
    host: Host<R, N>,
    id: u64,
    token: CancelToken,
    result: Option<Result<R, String>>,
}

impl<R, N: Notify> Ticket<R, N> {
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn token(&self) -> &CancelToken {
        &self.token
    }

    /// Records the work's result; it is settled when the ticket is released.
    pub fn finish(mut self, result: Result<R, String>) {
        self.result = Some(result);
    }
}

impl<R, N: Notify> Drop for Ticket<R, N> {
    fn drop(&mut self) {
        let result = self.result.take();
        let late = {
            let mut state = lock(&self.host.inner.state);
            state.in_flight -= 1;
            if result.is_none() {
                state.lost += 1;
            }
            let late = if state.pending.remove(&self.id).is_some() {
                let result = match result {
                    Some(Ok(value)) => Ok(value),
                    Some(Err(message)) => Err(OpError::Failed(message)),
                    None => Err(OpError::Lost),
                };
                state.push(Outcome { id: self.id, result });
                None
            } else {
                state.discarded += u64::from(result.is_some());
                result
            };
            // The slot stays held if this operation's outcome is still queued.
            state.release(self.id, RUNNING);
            // The work has exited: only now does it stop counting against the budget.
            self.host.inner.budget.release(!state.open);
            late
        };
        // A late result is dropped here, outside the lock, without conversion to JS.
        drop(late);
    }
}
