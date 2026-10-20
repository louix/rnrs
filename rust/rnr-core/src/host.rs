use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::budget::{Budget, BudgetStats};
use crate::cancel::{lock, CancelToken};

/// Wakes the JS-runtime side when the outcome queue becomes non-empty.
///
/// Called with the host lock held, so it must only schedule work (for example post a
/// task to the JS thread) and never call back into the host. It is never called after
/// `Host::teardown` returns.
pub trait Notify {
    fn notify(&self);
}

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
    admitted: u64,
    delivered: u64,
    discarded: u64,
    lost: u64,
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
                    admitted: 0,
                    delivered: 0,
                    discarded: 0,
                    lost: 0,
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
        }
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
            }
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
