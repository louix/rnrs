//! Adapter harness for tests: a module adapter on a real Tokio runtime, called through the
//! mock environment like a backend would.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use rnrs_core::bind::{Adapter, BindError, ModuleDef, Spawner, Val};
use rnrs_core::exec::TokioSpawner;
use rnrs_core::{Budget, Notify};

use crate::{MockEnv, V};

#[derive(Clone, Default)]
pub struct Wakes(pub Arc<AtomicUsize>);

impl Notify for Wakes {
    fn notify(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn spawner() -> &'static Spawner {
    static SPAWNER: OnceLock<TokioSpawner> = OnceLock::new();
    SPAWNER.get_or_init(|| TokioSpawner::owned(2).unwrap())
}

pub struct Harness {
    pub adapter: std::rc::Rc<Adapter<Wakes>>,
    pub wakes: Wakes,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Settled {
    Ok(String),
    Cancelled,
    Failed(String),
    Lost,
    /// A declared error (`Throws<T, E>`); the converted `E` is the outcome's value.
    Domain,
}

impl Harness {
    pub fn new(def: &'static ModuleDef, max_in_flight: usize) -> Self {
        Self::with_budget(def, max_in_flight, Budget::unlimited())
    }

    pub fn with_budget(def: &'static ModuleDef, max_in_flight: usize, budget: Budget) -> Self {
        let wakes = Wakes::default();
        let adapter = std::rc::Rc::new(Adapter::new(def, max_in_flight, budget, spawner(), wakes.clone()).unwrap());
        Self { adapter, wakes }
    }

    pub fn env(&self) -> MockEnv {
        MockEnv::new(self.adapter.generation())
    }

    pub fn index(&self, name: &str) -> u32 {
        self.adapter.def().methods.iter().position(|m| m.name == name).unwrap_or_else(|| panic!("no method {name}")) as u32
    }

    /// Calls `name` with `this` and `args`; returns the JS result or the error (with the
    /// mock's pending exception message for `Thrown`, and `domain: <value>` for a declared error).
    pub fn call(&self, env: &mut MockEnv, name: &str, this: V, args: Vec<V>) -> Result<V, String> {
        let this = env.put(this);
        let args: Vec<Val> = args.into_iter().map(|v| env.put(v)).collect();
        match self.adapter.call(env, self.index(name), this, &args) {
            Ok(v) => Ok(env.take(v)),
            Err(BindError::Thrown) => Err(format!("thrown: {}", env.thrown.take().unwrap_or_default())),
            Err(BindError::Js { kind, message }) => Err(format!("{kind:?}: {message}")),
            Err(BindError::Domain { value }) => Err(format!("domain: {:?}", env.take(value))),
        }
    }

    /// Waits for `count` outcomes and converts them with the mock env.
    pub fn settle(&self, env: &mut MockEnv, count: usize) -> Vec<(u64, Settled, V)> {
        let start = Instant::now();
        let mut out = Vec::new();
        while out.len() < count {
            assert!(start.elapsed() < Duration::from_secs(5), "timed out waiting for outcomes");
            self.adapter.drain(env, 64, |env, id, status, value, message| {
                let v = env.take(value);
                let settled = match status {
                    0 => Settled::Ok(String::new()),
                    1 => Settled::Cancelled,
                    2 => Settled::Failed(message.to_string()),
                    3 => Settled::Lost,
                    4 => Settled::Domain,
                    other => panic!("unknown settlement status {other}"),
                };
                out.push((id, settled, v));
            });
            std::thread::sleep(Duration::from_millis(2));
        }
        out
    }
}
