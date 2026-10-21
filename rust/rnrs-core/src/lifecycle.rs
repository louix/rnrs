//! Runtime-teardown hook for module-owned resources (docs/surface.md, "Teardown hook").
//!
//! Some modules own resources that must stop when their JS runtime generation is torn down
//! (React Native reload, invalidation) even if JS or native references to them survive: a
//! renderer's thread and GPU device, for example. Such a module captures the
//! [`TeardownScope`] of its adapter generation while its instance is created, and registers
//! each resource as a `Weak<dyn Retire>`. When the adapter is torn down (explicitly, or by
//! being dropped), after admission has stopped, every live registered resource is retired.
//!
//! # The `Retire` contract
//! [`Retire::retire`] may run on any thread (the RN invalidation thread, the JS thread, a
//! finalizer or UI thread) and must be idempotent and non-blocking: set flags, close, notify.
//! It must not touch JSI, wait for the GPU, join threads, or take locks that a caller of the
//! scope could hold. A panic in it aborts the process (`panic = "abort"`, as everywhere in the
//! bundle).
//!
//! # Concurrency
//! Registration and retirement are serialized by the scope lock, so a resource registered
//! concurrently with teardown is retired exactly once: either by `retire_all` or, if
//! registration comes after it, immediately by `register`. `retire_all` drains under the lock
//! and calls `retire` (and drops any last strong reference it upgraded) only after unlocking.
//!
//! # Ownership
//! [`TeardownScope::current`] is set by the framework only while the adapter creates the
//! module instance (`Adapter::new`), saved and restored around that call, so nested creation
//! sees its own scope. Elsewhere (host tests, a module created outside an adapter) it is
//! `None`; a module must then treat its resources as unowned and say so in its diagnostics.
use std::cell::RefCell;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use crate::bind::MaybeSendSync;

/// A resource retired on runtime teardown. See the module docs for the contract.
pub trait Retire: MaybeSendSync {
    fn retire(&self);
}

#[derive(Default)]
struct ScopeState {
    closed: bool,
    entries: Vec<Weak<dyn Retire>>,
    retired: u64,
}

/// The teardown scope of one adapter generation. Clones share it.
#[derive(Clone, Default)]
pub struct TeardownScope {
    state: Arc<Mutex<ScopeState>>,
}

thread_local! {
    static CURRENT: RefCell<Option<TeardownScope>> = const { RefCell::new(None) };
}

/// Restores the previous current scope when dropped (also on unwinding, for host tests).
pub(crate) struct CurrentGuard {
    previous: Option<TeardownScope>,
}

impl Drop for CurrentGuard {
    fn drop(&mut self) {
        let previous = self.previous.take();
        CURRENT.with(|c| *c.borrow_mut() = previous);
    }
}

impl TeardownScope {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, ScopeState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The scope of the adapter generation whose module instance is being created on this
    /// thread, or None outside module creation.
    pub fn current() -> Option<TeardownScope> {
        CURRENT.with(|c| c.borrow().clone())
    }

    /// Makes `self` current until the guard is dropped (which restores the previous one).
    pub(crate) fn enter(&self) -> CurrentGuard {
        let previous = CURRENT.with(|c| c.borrow_mut().replace(self.clone()));
        CurrentGuard { previous }
    }

    /// Registers `resource`; retires it at once (after unlocking) if the scope is already
    /// closed. Never call this while holding a lock that `retire` takes.
    pub fn register(&self, resource: Weak<dyn Retire>) {
        let retire_now = {
            let mut s = self.lock();
            if s.closed {
                true
            } else {
                s.entries.retain(|w| w.strong_count() > 0);
                s.entries.push(resource.clone());
                false
            }
        };
        if retire_now {
            if let Some(r) = resource.upgrade() {
                self.lock().retired += 1;
                r.retire();
            }
        }
    }

    pub fn is_closed(&self) -> bool {
        self.lock().closed
    }

    /// Live registered resources (diagnostics and tests).
    pub fn live(&self) -> usize {
        self.lock().entries.iter().filter(|w| w.strong_count() > 0).count()
    }

    /// Resources actually retired so far (diagnostics and tests): entries already gone when
    /// teardown reached them are not counted.
    pub fn retired(&self) -> u64 {
        self.lock().retired
    }

    /// Closes the scope and retires every live registered resource. Idempotent. Calls
    /// `retire` and drops upgraded references only after releasing the scope lock.
    pub fn retire_all(&self) {
        let entries = {
            let mut s = self.lock();
            if s.closed {
                return;
            }
            s.closed = true;
            std::mem::take(&mut s.entries)
        };
        for entry in entries {
            if let Some(resource) = entry.upgrade() {
                self.lock().retired += 1;
                resource.retire();
                // `resource` may be the last strong reference: dropped here, unlocked.
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;

    struct Counted(AtomicUsize);
    impl Retire for Counted {
        fn retire(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    fn counted() -> Arc<Counted> {
        Arc::new(Counted(AtomicUsize::new(0)))
    }
    fn weak(r: &Arc<Counted>) -> Weak<dyn Retire> {
        let r: Arc<dyn Retire> = r.clone();
        Arc::downgrade(&r)
    }

    #[test]
    fn retires_retained_resources_once_and_after_close_immediately() {
        let scope = TeardownScope::new();
        let held = counted(); // a reference that survives teardown (JS or native holder)
        scope.register(weak(&held));
        let dropped = counted();
        scope.register(weak(&dropped));
        drop(dropped);
        assert_eq!(scope.live(), 1);
        scope.retire_all();
        scope.retire_all();
        assert_eq!(held.0.load(Ordering::SeqCst), 1);
        let late = counted();
        scope.register(weak(&late));
        assert_eq!(late.0.load(Ordering::SeqCst), 1, "registered after close: retired at once");
        assert_eq!(scope.retired(), 2);
    }

    #[test]
    fn current_is_saved_and_restored_around_nested_creation() {
        assert!(TeardownScope::current().is_none());
        let outer = TeardownScope::new();
        let inner = TeardownScope::new();
        {
            let _g = outer.enter();
            assert!(Arc::ptr_eq(&TeardownScope::current().unwrap().state, &outer.state));
            {
                let _g = inner.enter();
                assert!(Arc::ptr_eq(&TeardownScope::current().unwrap().state, &inner.state));
            }
            assert!(Arc::ptr_eq(&TeardownScope::current().unwrap().state, &outer.state), "outer restored");
        }
        assert!(TeardownScope::current().is_none());
    }

    /// A resource whose retire drops the last strong reference to another registered
    /// resource, and a "finalizer" dropping one concurrently: no deadlock, each retired once.
    #[test]
    fn reentrant_drop_and_finalizer_during_teardown() {
        struct Dropper(Mutex<Option<Arc<Counted>>>, AtomicUsize);
        impl Retire for Dropper {
            fn retire(&self) {
                self.1.fetch_add(1, Ordering::SeqCst);
                drop(self.0.lock().unwrap().take());
            }
        }
        let scope = TeardownScope::new();
        let victim = counted();
        let victim_weak = weak(&victim);
        let dropper = Arc::new(Dropper(Mutex::new(Some(victim)), AtomicUsize::new(0)));
        let d: Arc<dyn Retire> = dropper.clone();
        scope.register(Arc::downgrade(&d));
        drop(d);
        scope.register(victim_weak.clone());
        let finalizer_held = counted();
        scope.register(weak(&finalizer_held));
        let finalizer = std::thread::spawn(move || drop(finalizer_held));
        scope.retire_all();
        finalizer.join().unwrap();
        assert_eq!(dropper.1.load(Ordering::SeqCst), 1);
        assert!(victim_weak.upgrade().is_none());
    }

    /// Registration racing teardown: every resource is retired exactly once.
    #[test]
    fn concurrent_register_and_teardown_retire_each_exactly_once() {
        for _ in 0..100 {
            let scope = TeardownScope::new();
            let resources: Vec<_> = (0..8).map(|_| counted()).collect();
            let barrier = Arc::new(Barrier::new(3));
            let spawn_registrar = |part: Vec<Arc<Counted>>| {
                let (scope, barrier) = (scope.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    for r in &part {
                        scope.register(weak(r));
                    }
                })
            };
            let a = spawn_registrar(resources[..4].to_vec());
            let b = spawn_registrar(resources[4..].to_vec());
            barrier.wait();
            scope.retire_all();
            a.join().unwrap();
            b.join().unwrap();
            for r in &resources {
                assert_eq!(r.0.load(Ordering::SeqCst), 1);
            }
        }
    }
}
