//! Prototype ownership and async core for Rust native modules.
//!
//! Backend adapters (JSI, browser Wasm) own the JS-facing side: they keep JS promise
//! state on the JS thread, convert outcomes there, and call [`Host::teardown`] when their
//! runtime goes away. This crate holds no JS values and never blocks on running work.
//!
//! Native multithreaded spawning requires `Send` futures, so receivers must be shareable:
//!
//! ```compile_fail
//! # use rnrs_core::*;
//! # struct Noop; impl Notify for Noop { fn notify(&self) {} }
//! # struct Pool; impl Spawn for Pool { fn spawn(&self, _: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>) {} }
//! let host: Host<f64, Noop> = Host::new(4, Noop);
//! let counter = Native::new(std::cell::Cell::new(0.0)); // !Sync receiver
//! host.start(&Pool, move |_| async move { Ok(counter.get()) });
//! ```
//!
//! Futures holding `!Send` state across an await are rejected by `start` too:
//!
//! ```compile_fail
//! # use rnrs_core::*;
//! # struct Noop; impl Notify for Noop { fn notify(&self) {} }
//! # struct Pool; impl Spawn for Pool { fn spawn(&self, _: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>) {} }
//! let host: Host<f64, Noop> = Host::new(4, Noop);
//! host.start(&Pool, |token| async move {
//!     let local = std::rc::Rc::new(1.0);
//!     token.cancelled().await;
//!     Ok(*local)
//! });
//! ```
//!
//! The same code is accepted by a browser-local executor:
//!
//! ```
//! # use rnrs_core::*;
//! # struct Noop; impl Notify for Noop { fn notify(&self) {} }
//! # struct Local; impl SpawnLocal for Local { fn spawn_local(&self, _: std::pin::Pin<Box<dyn std::future::Future<Output = ()>>>) {} }
//! let host: Host<f64, Noop> = Host::new(4, Noop);
//! let counter = Native::new(std::cell::Cell::new(0.0));
//! host.start_local(&Local, move |token| async move {
//!     let local = std::rc::Rc::new(1.0);
//!     token.cancelled().await;
//!     Ok(counter.get() + *local)
//! }).unwrap();
//! ```
//!
//! And `start` accepts a shareable receiver:
//!
//! ```
//! # use rnrs_core::*;
//! # struct Noop; impl Notify for Noop { fn notify(&self) {} }
//! # struct Pool; impl Spawn for Pool { fn spawn(&self, _: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>) {} }
//! let host: Host<f64, Noop> = Host::new(4, Noop);
//! let counter = Native::new(std::sync::Mutex::new(0.0));
//! host.start(&Pool, move |_| async move { Ok(*counter.lock().unwrap()) }).unwrap();
//! ```

pub mod bind;
mod budget;
mod cancel;
pub mod exec;
mod host;
pub mod lifecycle;
mod native;
pub mod platform;
#[cfg(feature = "diagnostics")]
pub mod diagnostics;

pub use budget::{Budget, BudgetStats};
pub use cancel::{CancelToken, Cancelled};
pub use host::{
    AdmitError, Delivery, Host, HostStats, Notify, OpError, Outcome, Spawn, SpawnLocal, TeardownReport, Ticket, Timer,
    DELIVERY_CHECK_FIRST, DELIVERY_CHECK_MAX,
};
pub use native::{live_counts, live_counts_by_name, LiveCounts, Native};
