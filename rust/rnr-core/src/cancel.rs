use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

/// Cooperative cancellation signal shared between an operation's owner and its work.
///
/// Cancelling never drops or interrupts the work; the work observes the signal.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<Inner>);

#[derive(Default)]
struct Inner {
    cancelled: AtomicBool,
    wakers: Mutex<Vec<Waker>>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Signals cancellation and wakes every waiting `cancelled()` future. Idempotent.
    pub fn cancel(&self) {
        if self.0.cancelled.swap(true, Ordering::AcqRel) {
            return;
        }
        let wakers = std::mem::take(&mut *lock(&self.0.wakers));
        for waker in wakers {
            waker.wake();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Acquire)
    }

    /// Completes once cancellation has been signalled.
    pub fn cancelled(&self) -> Cancelled<'_> {
        Cancelled(self)
    }

    /// Runs `work` until it completes or cancellation is observed, whichever is first.
    /// Returns `None` when cancelled. `work` is dropped at that point, so use this only
    /// for futures whose drop is a safe cancellation point (timers, channel receives).
    pub async fn run_until_cancelled<F: Future>(&self, work: F) -> Option<F::Output> {
        let mut work = std::pin::pin!(work);
        std::future::poll_fn(|cx| {
            if self.is_cancelled() {
                return Poll::Ready(None);
            }
            if let Poll::Ready(value) = work.as_mut().poll(cx) {
                return Poll::Ready(Some(value));
            }
            match Pin::new(&mut self.cancelled()).poll(cx) {
                Poll::Ready(()) => Poll::Ready(None),
                Poll::Pending => Poll::Pending,
            }
        })
        .await
    }
}

pub struct Cancelled<'a>(&'a CancelToken);

impl Future for Cancelled<'_> {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let inner = &self.0 .0;
        if inner.cancelled.load(Ordering::Acquire) {
            return Poll::Ready(());
        }
        let mut wakers = lock(&inner.wakers);
        // Re-check under the lock: cancel() sets the flag before taking the waker list.
        if inner.cancelled.load(Ordering::Acquire) {
            return Poll::Ready(());
        }
        if !wakers.iter().any(|w| w.will_wake(cx.waker())) {
            wakers.push(cx.waker().clone());
        }
        Poll::Pending
    }
}

/// Locks without propagating poisoning: state guarded here stays consistent per operation.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
