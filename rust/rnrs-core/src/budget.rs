use std::sync::{Arc, Mutex};

use crate::cancel::lock;

/// Bound on running work shared by every host that submits to one executor.
///
/// A host's own `max_in_flight` bounds one runtime generation. It cannot bound work that
/// outlives its generation: after teardown, non-cooperative work keeps running, keeps its
/// memory and no longer counts against the next generation's host. A budget is scoped to
/// the executor (in practice the process), so work from closed generations keeps counting
/// until it actually exits. Admission fails with `AdmitError::Saturated` when it is full.
///
/// A permit is taken at admission and returned only when the work exits (its ticket
/// drops). Cancellation and teardown never return it early.
#[derive(Clone)]
pub struct Budget(Arc<Inner>);

struct Inner {
    limit: usize,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    running: usize,
    orphaned: usize,
    peak: usize,
    rejected: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BudgetStats {
    pub limit: usize,
    /// Admitted work that has not exited, across all hosts.
    pub running: usize,
    /// Part of `running` whose host has been torn down.
    pub orphaned: usize,
    /// Highest `running` observed.
    pub peak: usize,
    /// Admissions refused because the budget was full.
    pub rejected: u64,
}

impl Budget {
    pub fn new(limit: usize) -> Self {
        Self(Arc::new(Inner { limit, state: Mutex::new(State::default()) }))
    }

    /// No shared bound; only the host's own `max_in_flight` applies.
    pub fn unlimited() -> Self {
        Self::new(usize::MAX)
    }

    pub fn stats(&self) -> BudgetStats {
        let state = lock(&self.0.state);
        BudgetStats {
            limit: self.0.limit,
            running: state.running,
            orphaned: state.orphaned,
            peak: state.peak,
            rejected: state.rejected,
        }
    }

    // The methods below are called with a host lock held. Lock order: host, then budget.

    /// On refusal returns the budget as it was at that moment (under its lock), so the
    /// error the caller reports cannot be skewed by later admissions or exits.
    pub(crate) fn try_acquire(&self) -> Result<(), BudgetStats> {
        let mut state = lock(&self.0.state);
        if state.running >= self.0.limit {
            state.rejected += 1;
            return Err(BudgetStats {
                limit: self.0.limit,
                running: state.running,
                orphaned: state.orphaned,
                peak: state.peak,
                rejected: state.rejected,
            });
        }
        state.running += 1;
        state.peak = state.peak.max(state.running);
        Ok(())
    }

    pub(crate) fn release(&self, orphaned: bool) {
        let mut state = lock(&self.0.state);
        state.running -= 1;
        if orphaned {
            state.orphaned -= 1;
        }
    }

    pub(crate) fn orphan(&self, count: usize) {
        lock(&self.0.state).orphaned += count;
    }
}
