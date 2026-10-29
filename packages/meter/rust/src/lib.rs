//! Pass Native<T> handles to Rust methods and return new objects.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use rnrs_core::{CancelToken, Native};

pub mod rnrs_interface;
use rnrs_interface as spec;

/// Per-runtime module state: a call counter.
#[derive(Default)]
pub struct Meter {
    calls: AtomicU64,
}

impl Meter {
    fn count(&self) {
        self.calls.fetch_add(1, Ordering::Relaxed);
    }
}

pub struct Reading(Mutex<f64>);

impl Reading {
    fn new(value: f64) -> Native<Reading> {
        Native::new(Reading(Mutex::new(value)))
    }
    fn read(&self) -> f64 {
        *self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl spec::Gauge for Reading {
    fn set(&self, value: f64) -> Result<(), String> {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = value;
        Ok(())
    }

    fn get(&self) -> Result<f64, String> {
        Ok(self.read())
    }

    fn is_above(&self, threshold: f64) -> Result<bool, String> {
        Ok(self.read() > threshold)
    }

    fn max_with(&self, other: Native<Self>) -> Result<Native<Self>, String> {
        Ok(Reading::new(self.read().max(other.read())))
    }
}

fn delay(ms: f64) -> Result<Duration, String> {
    if ms.is_finite() && (0.0..=10_000.0).contains(&ms) {
        Ok(Duration::from_secs_f64(ms / 1000.0))
    } else {
        Err("ms must be between 0 and 10000".into())
    }
}

impl spec::MeterModule for Meter {
    type GaugeImpl = Reading;

    fn hypot(&self, a: f64, b: f64) -> Result<f64, String> {
        self.count();
        Ok(a.hypot(b))
    }

    fn is_negative_zero(&self, x: f64) -> Result<bool, String> {
        self.count();
        Ok(x == 0.0 && x.is_sign_negative())
    }

    fn calls(&self) -> Result<f64, String> {
        Ok(self.calls.load(Ordering::Relaxed) as f64)
    }

    fn reset(&self) -> Result<(), String> {
        self.calls.store(0, Ordering::Relaxed);
        Ok(())
    }

    fn gauge(&self, initial: f64) -> Result<Native<Reading>, String> {
        self.count();
        Ok(Reading::new(initial))
    }

    fn combine(&self, a: Native<Reading>, b: Native<Reading>) -> Result<Native<Reading>, String> {
        self.count();
        Ok(Reading::new(a.read() + b.read()))
    }

    fn validate_settle_after(&self, _value: &f64, ms: &f64) -> Result<(), String> {
        delay(*ms).map(drop)
    }

    async fn settle_after(&self, value: f64, ms: f64, cancel: CancelToken) -> Result<f64, String> {
        self.count();
        match cancel.run_until_cancelled(sleep(delay(ms)?)).await {
            Some(()) => Ok(value),
            None => Err("cancelled".into()),
        }
    }

    async fn gauge_later(&self, initial: f64, ms: f64, _cancel: CancelToken) -> Result<Native<Reading>, String> {
        sleep(delay(ms)?).await;
        Ok(Reading::new(initial))
    }

    async fn check_later(&self, value: f64, _cancel: CancelToken) -> Result<(), String> {
        sleep(Duration::from_millis(1)).await;
        if value < 0.0 {
            Err(format!("negative reading: {value}"))
        } else {
            Ok(())
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
    use spec::{Gauge as _, MeterModule as _};

    #[tokio::test(start_paused = true)]
    async fn module_methods() {
        let meter = Meter::default();
        assert_eq!(meter.hypot(3.0, 4.0), Ok(5.0));
        assert_eq!(meter.is_negative_zero(-0.0), Ok(true));
        let a = meter.gauge(2.0).unwrap();
        let b = meter.gauge(5.0).unwrap();
        assert_eq!(meter.combine(a.clone(), b.clone()).unwrap().get(), Ok(7.0));
        assert_eq!(a.max_with(b).unwrap().get(), Ok(5.0));
        assert_eq!(meter.calls(), Ok(5.0));
        assert_eq!(meter.check_later(-1.0, CancelToken::new()).await, Err("negative reading: -1".into()));
        assert_eq!(meter.settle_after(9.0, 5.0, CancelToken::new()).await, Ok(9.0));
    }
}
