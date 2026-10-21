//! Executor adapters. Each adapter runs futures inside the runtime its libraries need.

#[cfg(feature = "tokio")]
pub use self::tokio_adapter::TokioSpawner;

#[cfg(feature = "tokio")]
mod tokio_adapter {
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Arc;

    use crate::host::Spawn;

    /// Spawns onto a Tokio runtime, so Tokio timers and I/O work inside operations.
    ///
    /// `external` borrows an application-owned runtime through its handle and never shuts
    /// it down; that runtime must have its time driver enabled (`enable_time`/`enable_all`)
    /// if the spawner is used as a host's delivery-monitor `Timer`, or the monitor's sleep
    /// panics and that host's monitor stops. `owned` creates a runtime owned by the bindings; it is shut down without
    /// blocking (`shutdown_background`) when the last spawner clone is dropped. Tasks
    /// dropped by shutdown report `OpError::Lost` through their tickets.
    #[derive(Clone)]
    pub struct TokioSpawner {
        handle: tokio::runtime::Handle,
        _owned: Option<Arc<Owned>>,
    }

    struct Owned(Option<tokio::runtime::Runtime>);

    impl Drop for Owned {
        fn drop(&mut self) {
            if let Some(runtime) = self.0.take() {
                runtime.shutdown_background();
            }
        }
    }

    impl TokioSpawner {
        pub fn external(handle: tokio::runtime::Handle) -> Self {
            Self { handle, _owned: None }
        }

        pub fn owned(worker_threads: usize) -> std::io::Result<Self> {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(worker_threads)
                .thread_name("rnrs-tokio")
                .enable_all()
                .build()?;
            Ok(Self { handle: runtime.handle().clone(), _owned: Some(Arc::new(Owned(Some(runtime)))) })
        }

        pub fn handle(&self) -> &tokio::runtime::Handle {
            &self.handle
        }
    }

    impl Spawn for TokioSpawner {
        fn spawn(&self, task: Pin<Box<dyn Future<Output = ()> + Send + 'static>>) {
            drop(self.handle.spawn(task));
        }
    }

    /// The delivery monitor's timer (`Host::monitor_delivery`). An `external` runtime must
    /// have its time driver enabled; `owned` runtimes do (`enable_all`).
    impl crate::host::Timer for TokioSpawner {
        fn after(&self, delay: std::time::Duration, task: Box<dyn FnOnce() + Send>) {
            drop(self.handle.spawn(async move {
                tokio::time::sleep(delay).await;
                task();
            }));
        }
    }
}

#[cfg(feature = "smol")]
pub use self::smol_adapter::SmolSpawner;

#[cfg(feature = "smol")]
mod smol_adapter {
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Arc;

    use crate::host::Spawn;

    /// Spawns onto an application-owned smol (`async-executor`) executor. The application
    /// drives the executor on its own threads; the bindings never stop it.
    #[derive(Clone)]
    pub struct SmolSpawner(pub Arc<async_executor::Executor<'static>>);

    impl Spawn for SmolSpawner {
        fn spawn(&self, task: Pin<Box<dyn Future<Output = ()> + Send + 'static>>) {
            self.0.spawn(task).detach();
        }
    }
}
