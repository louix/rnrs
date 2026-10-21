//! The module author's implementation of the Counter spec (packages/counter/counter.spec.ts).
//! It is ordinary Rust: the generated traits in `rnr_interface`, `&self` methods with interior
//! mutability and standard futures. Timers come from the library the target needs (Tokio
//! natively, browser timers on Wasm). No JS, JSI or platform code.
use std::sync::Mutex;
use std::time::Duration;

use rnrs_core::{CancelToken, Native};

pub mod rnr_interface;
use rnr_interface as spec;

/// The module instance (one per JS runtime).
#[derive(Default)]
pub struct Module;

impl spec::CounterModule for Module {
    type CounterImpl = BasicCounter;

    fn create(&self, initial: f64) -> Result<Native<BasicCounter>, String> {
        Ok(Native::new(BasicCounter::new(initial)))
    }
}

pub struct BasicCounter {
    value: Mutex<f64>,
}

pub const MAX_DELAY_MS: f64 = 60_000.0;

/// Numbers arrive as f64; the implementation validates the range it accepts.
pub fn validate_delay(ms: f64) -> Result<Duration, String> {
    if ms.is_finite() && (0.0..=MAX_DELAY_MS).contains(&ms) {
        Ok(Duration::from_secs_f64(ms / 1000.0))
    } else {
        Err(format!("delayMs must be a finite number between 0 and {MAX_DELAY_MS}"))
    }
}

impl BasicCounter {
    pub fn new(initial: f64) -> Self {
        Self { value: Mutex::new(initial) }
    }

    fn apply(&self, delta: f64) -> f64 {
        let mut value = self.value.lock().unwrap_or_else(|e| e.into_inner());
        *value += delta;
        *value
    }
}

impl spec::Counter for BasicCounter {
    fn increment(&self) -> Result<f64, String> {
        Ok(self.apply(1.0))
    }

    fn add(&self, delta: f64) -> Result<f64, String> {
        Ok(self.apply(delta))
    }

    fn value(&self) -> Result<f64, String> {
        Ok(*self.value.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// Invalid delays are rejected before the operation is admitted.
    fn validate_add_later(&self, _delta: &f64, delay_ms: &f64, _uncancellable: &bool) -> Result<(), String> {
        validate_delay(*delay_ms).map(drop)
    }

    /// Waits, then adds. Cooperative unless `uncancellable`: if cancelled while waiting it
    /// stops without changing the value. The uncancellable form models a non-cooperative
    /// library call that always applies its side effect.
    async fn add_later(&self, delta: f64, delay_ms: f64, uncancellable: bool, cancel: CancelToken) -> Result<f64, String> {
        let delay = validate_delay(delay_ms)?;
        if uncancellable {
            sleep(delay).await;
            return Ok(self.apply(delta));
        }
        match cancel.run_until_cancelled(sleep(delay)).await {
            Some(()) => Ok(self.apply(delta)),
            None => Err("cancelled".into()),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
async fn sleep(delay: Duration) {
    tokio::time::sleep(delay).await
}

#[cfg(target_arch = "wasm32")]
async fn sleep(delay: Duration) {
    gloo_timers::future::sleep(delay).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use spec::{Counter as _, CounterModule as _};

    #[test]
    fn numeric_semantics_are_f64() {
        let counter = Module.create(1.5).unwrap();
        assert_eq!(counter.increment(), Ok(2.5));
        assert_eq!(counter.add(-0.25), Ok(2.25));
        assert!(BasicCounter::new(f64::NAN).increment().unwrap().is_nan());
        assert!(BasicCounter::new(-0.0).add(-0.0).unwrap().is_sign_negative());
        assert!(validate_delay(f64::NAN).is_err());
        assert!(validate_delay(-1.0).is_err());
        assert!(validate_delay(MAX_DELAY_MS + 1.0).is_err());
        assert_eq!(validate_delay(1.5), Ok(Duration::from_micros(1500)));
        assert!(counter.validate_add_later(&1.0, &-1.0, &false).unwrap_err().contains("delayMs"));
    }

    #[tokio::test(start_paused = true)]
    async fn add_later_is_cooperative() {
        let counter = BasicCounter::new(0.0);
        let token = CancelToken::new();
        assert_eq!(counter.add_later(2.0, 5.0, false, token.clone()).await, Ok(2.0));
        token.cancel();
        assert!(counter.add_later(2.0, 5000.0, false, token.clone()).await.is_err());
        assert_eq!(counter.add_later(1.0, 5.0, true, token).await, Ok(3.0));
        assert_eq!(counter.value(), Ok(3.0));
    }
}
