//! Lab fixture for the runtime-teardown hook: `track()` creates a resource registered with the
//! adapter generation's `TeardownScope`; teardown retires it (sets its flag and counts it).
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use rnrs_core::lifecycle::{Retire, TeardownScope};
use rnrs_core::Native;

pub mod rnr_interface;
use rnr_interface as spec;

static RETIRED_TOTAL: AtomicU64 = AtomicU64::new(0);

pub struct Module {
    scope: Option<TeardownScope>,
}

impl Default for Module {
    fn default() -> Self {
        Self { scope: TeardownScope::current() }
    }
}

struct Flag(AtomicBool);

impl Retire for Flag {
    fn retire(&self) {
        if !self.0.swap(true, Ordering::SeqCst) {
            RETIRED_TOTAL.fetch_add(1, Ordering::SeqCst);
        }
    }
}

pub struct Tracked {
    flag: Arc<Flag>,
}

impl spec::TeardownProbeModule for Module {
    type TrackedImpl = Tracked;

    fn track(&self) -> Result<Native<Tracked>, String> {
        let flag = Arc::new(Flag(AtomicBool::new(false)));
        if let Some(scope) = &self.scope {
            let retire: Arc<dyn Retire> = flag.clone();
            scope.register(Arc::downgrade(&retire));
        }
        Ok(Native::new(Tracked { flag }))
    }

    fn retired_total(&self) -> Result<f64, String> {
        Ok(RETIRED_TOTAL.load(Ordering::SeqCst) as f64)
    }

    fn owned(&self) -> Result<bool, String> {
        Ok(self.scope.is_some())
    }
}

impl spec::Tracked for Tracked {
    fn retired(&self) -> Result<bool, String> {
        Ok(self.flag.0.load(Ordering::SeqCst))
    }
}
