//! The configure sequence for layer-backed windows (iOS `CAMetalLayer`; docs/research/
//! ios-surface-c1-design.md, "Bounded acquire"). wgpu's Metal `configure` writes the layer's
//! properties on the calling render thread, which has no run loop, and turns the layer's
//! drawable timeout off (`allowsNextDrawableTimeout = NO`: `nextDrawable` may then block
//! forever). The sequence encloses the configure in an explicit Core Animation transaction,
//! restores the documented timeout, always commits, and reads the property back; the result
//! decides whether acquires may be admitted.
//!
//! The steps are behind [`LayerTransaction`] so the order is host-tested with a fake; the iOS
//! implementation (libobjc) lives with the iOS window. The commit is in a guard's `Drop`, so it
//! runs on every return path; under the bundle's `panic = "abort"` there is no unwinding, and
//! nothing relies on the guard running during a panic.

/// One explicit transaction on one layer, called on the configuring thread.
pub trait LayerTransaction {
    /// `[CATransaction begin]`.
    fn begin(&mut self);
    /// `[CATransaction setDisableActions:YES]`: no implicit animations for this thread's
    /// writes (a layer without a delegate animates property changes by default).
    fn disable_actions(&mut self);
    /// `layer.allowsNextDrawableTimeout = YES`.
    fn allow_drawable_timeout(&mut self);
    /// `[CATransaction commit]`.
    fn commit(&mut self);
    /// Reads `layer.allowsNextDrawableTimeout` back.
    fn drawable_timeout_allowed(&mut self) -> bool;
}

/// What a configure produced, and whether acquires may be admitted afterwards: only when the
/// read-back timeout is enabled. A failed configure leaves the window unusable anyway.
pub struct Configured<R, E> {
    pub result: Result<R, E>,
    pub acquire_allowed: bool,
}

struct CommitOnDrop<'a, T: LayerTransaction + ?Sized>(&'a mut T);

impl<T: LayerTransaction + ?Sized> Drop for CommitOnDrop<'_, T> {
    fn drop(&mut self) {
        self.0.commit();
    }
}

/// begin → disable actions → `configure` → restore the timeout → commit (always, also when
/// `configure` failed) → read back. The transaction holds only this thread's writes.
pub fn configure_in_transaction<T: LayerTransaction + ?Sized, R, E>(tx: &mut T, configure: impl FnOnce() -> Result<R, E>) -> Configured<R, E> {
    tx.begin();
    tx.disable_actions();
    let result = {
        let guard = CommitOnDrop(&mut *tx);
        let result = configure();
        guard.0.allow_drawable_timeout();
        drop(guard);
        result
    };
    let acquire_allowed = tx.drawable_timeout_allowed();
    if acquire_allowed {
        log::info!("rnr-surface: configure read-back allowsNextDrawableTimeout=YES (configure {})", if result.is_ok() { "ok" } else { "failed" });
    } else {
        log::error!("rnr-surface: allowsNextDrawableTimeout read back NO after configure; acquires are refused for this window");
    }
    Configured { result, acquire_allowed }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records the calls; the read-back returns `readback`.
    struct Fake {
        calls: Vec<&'static str>,
        readback: bool,
    }
    impl LayerTransaction for Fake {
        fn begin(&mut self) {
            self.calls.push("begin");
        }
        fn disable_actions(&mut self) {
            self.calls.push("no-actions");
        }
        fn allow_drawable_timeout(&mut self) {
            self.calls.push("allow");
        }
        fn commit(&mut self) {
            self.calls.push("commit");
        }
        fn drawable_timeout_allowed(&mut self) -> bool {
            self.calls.push("read");
            self.readback
        }
    }

    #[test]
    fn configure_runs_inside_the_transaction_and_restores_the_timeout() {
        let mut tx = Fake { calls: vec![], readback: true };
        let mut inside = false;
        let c = configure_in_transaction(&mut tx, || {
            inside = true;
            Ok::<_, ()>(7)
        });
        assert!(inside);
        assert_eq!(tx.calls, ["begin", "no-actions", "allow", "commit", "read"]);
        assert_eq!((c.result, c.acquire_allowed), (Ok(7), true));
    }

    #[test]
    fn a_failed_configure_still_commits_and_reads_back() {
        let mut tx = Fake { calls: vec![], readback: true };
        let c = configure_in_transaction(&mut tx, || Err::<(), _>("configure failed"));
        assert_eq!(tx.calls, ["begin", "no-actions", "allow", "commit", "read"], "no implicit transaction left open");
        assert_eq!(c.result, Err("configure failed"));
    }

    #[test]
    fn a_readback_of_no_refuses_acquires() {
        let mut tx = Fake { calls: vec![], readback: false };
        let c = configure_in_transaction(&mut tx, || Ok::<_, ()>(()));
        assert!(c.result.is_ok());
        assert!(!c.acquire_allowed);
    }
}
