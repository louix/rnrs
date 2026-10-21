//! Lab-only fixture for the Worklets proof of concept (docs/research/worklets-poc-plan.md).
//! Ordinary author Rust: every method is short and bounded, and all state is `Send + Sync`
//! (atomics, or a mutex held for one addition), so the same calls may arrive from the React
//! Native runtime and from worklet runtimes concurrently. Nothing here knows about worklets.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use rnrs_core::{CancelToken, Native};

pub mod rnr_interface;
use rnr_interface as spec;

/// The module instance (one per React Native runtime). The pointer slot is last-write-wins:
/// each coordinate is one atomic, so a reader may see `x` and `y` from different writes.
#[derive(Default)]
pub struct Module {
    pointer_x: AtomicU64,
    pointer_y: AtomicU64,
    pointer_writes: AtomicU64,
}

pub struct Accumulator {
    value: Mutex<f64>,
    calls: AtomicU64,
}

impl Accumulator {
    pub fn new(initial: f64) -> Self {
        Self { value: Mutex::new(initial), calls: AtomicU64::new(0) }
    }
}

impl spec::Accumulator for Accumulator {
    fn add(&self, delta: f64) -> Result<f64, String> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        let mut value = self.value.lock().unwrap_or_else(|e| e.into_inner());
        *value += delta;
        Ok(*value)
    }

    fn value(&self) -> Result<f64, String> {
        Ok(*self.value.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn calls(&self) -> Result<f64, String> {
        Ok(self.calls.load(Ordering::Relaxed) as f64)
    }
}

impl spec::WorkletsProbeModule for Module {
    type AccumulatorImpl = Accumulator;

    fn scale(&self, x: f64, k: f64) -> Result<f64, String> {
        Ok(x * k)
    }

    fn is_positive(&self, x: f64) -> Result<bool, String> {
        Ok(x > 0.0)
    }

    fn set_pointer(&self, x: f64, y: f64) -> Result<(), String> {
        self.pointer_x.store(x.to_bits(), Ordering::Relaxed);
        self.pointer_y.store(y.to_bits(), Ordering::Relaxed);
        self.pointer_writes.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    fn pointer_x(&self) -> Result<f64, String> {
        Ok(f64::from_bits(self.pointer_x.load(Ordering::Relaxed)))
    }

    fn pointer_y(&self) -> Result<f64, String> {
        Ok(f64::from_bits(self.pointer_y.load(Ordering::Relaxed)))
    }

    fn pointer_writes(&self) -> Result<f64, String> {
        Ok(self.pointer_writes.load(Ordering::Relaxed) as f64)
    }

    fn create_accumulator(&self, initial: f64) -> Result<Native<Accumulator>, String> {
        Ok(Native::new(Accumulator::new(initial)))
    }

    async fn scale_later(&self, x: f64, k: f64, _cancel: CancelToken) -> Result<f64, String> {
        Ok(x * k)
    }

    fn describe(&self, x: f64) -> Result<String, String> {
        Ok(format!("x = {x}"))
    }

    fn point(&self, x: f64, y: f64) -> Result<spec::Point, String> {
        Ok(spec::Point { x, y })
    }

    fn pair(&self, x: f64, y: f64) -> Result<Vec<f64>, String> {
        Ok(vec![x, y])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use spec::{Accumulator as _, WorkletsProbeModule as _};

    #[test]
    fn scalar_methods_and_latest_value_slot() {
        let m = Module::default();
        assert_eq!(m.scale(1.5, 4.0), Ok(6.0));
        assert_eq!(m.is_positive(-0.0), Ok(false));
        m.set_pointer(1.0, 2.0).unwrap();
        m.set_pointer(3.0, -4.5).unwrap();
        assert_eq!((m.pointer_x(), m.pointer_y(), m.pointer_writes()), (Ok(3.0), Ok(-4.5), Ok(2.0)));
    }

    #[test]
    fn accumulator_is_consistent_under_concurrent_adds() {
        let acc = std::sync::Arc::new(Accumulator::new(0.0));
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let acc = acc.clone();
                std::thread::spawn(move || (0..10_000).for_each(|_| drop(acc.add(1.0))))
            })
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        assert_eq!((acc.value(), acc.calls()), (Ok(40_000.0), Ok(40_000.0)));
    }
}
