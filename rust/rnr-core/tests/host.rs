use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::task::{Context, Wake, Waker};
#[cfg(any(feature = "tokio", feature = "smol"))]
use std::time::Duration;

use rnr_core::*;

type BoxFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Deterministic single-threaded executor: tasks run only inside `run_until_stalled`.
#[derive(Clone, Default)]
struct Manual(Arc<ManualInner>);

#[derive(Default)]
struct ManualInner {
    ready: Mutex<VecDeque<Arc<Task>>>,
    all: Mutex<Vec<Arc<Task>>>,
}

struct Task {
    future: Mutex<Option<BoxFuture>>,
    executor: Manual,
}

impl Wake for Task {
    fn wake(self: Arc<Self>) {
        self.executor.0.ready.lock().unwrap().push_back(self.clone());
    }
}

impl Spawn for Manual {
    fn spawn(&self, future: BoxFuture) {
        let task = Arc::new(Task { future: Mutex::new(Some(future)), executor: self.clone() });
        self.0.all.lock().unwrap().push(task.clone());
        self.0.ready.lock().unwrap().push_back(task);
    }
}

impl Manual {
    fn run_until_stalled(&self) {
        loop {
            let Some(task) = self.0.ready.lock().unwrap().pop_front() else { return };
            let waker = Waker::from(task.clone());
            let mut slot = task.future.lock().unwrap();
            if let Some(future) = slot.as_mut() {
                if future.as_mut().poll(&mut Context::from_waker(&waker)).is_ready() {
                    *slot = None;
                }
            }
        }
    }

    /// Simulates executor shutdown: every unfinished task future is dropped.
    fn drop_all_tasks(&self) {
        self.0.ready.lock().unwrap().clear();
        for task in self.0.all.lock().unwrap().drain(..) {
            let future = task.future.lock().unwrap().take();
            drop(future);
        }
    }
}

#[derive(Clone, Default)]
struct Notes {
    calls: Arc<AtomicUsize>,
    released: Arc<AtomicBool>,
    probe_dropped_at_notify: Arc<Mutex<Vec<bool>>>,
    probe: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

struct Notifier(Notes);

impl Notify for Notifier {
    fn notify(&self) {
        self.0.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(flag) = &*self.0.probe.lock().unwrap() {
            self.0.probe_dropped_at_notify.lock().unwrap().push(flag.load(Ordering::SeqCst));
        }
    }
}

impl Drop for Notifier {
    fn drop(&mut self) {
        self.0.released.store(true, Ordering::SeqCst);
    }
}

/// Receiver stand-in that records its destruction.
struct Probe {
    dropped: Arc<AtomicBool>,
}

impl Drop for Probe {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}

fn probe() -> (Native<Probe>, Arc<AtomicBool>) {
    let dropped = Arc::new(AtomicBool::new(false));
    (Native::new(Probe { dropped: dropped.clone() }), dropped)
}

fn host(max: usize) -> (Host<f64, Notifier>, Notes) {
    let notes = Notes::default();
    (Host::new(max, Notifier(notes.clone())), notes)
}

fn results(host: &Host<f64, Notifier>) -> Vec<(u64, Result<f64, OpError>)> {
    host.drain(usize::MAX).into_iter().map(|o| (o.id, o.result)).collect()
}

#[test]
fn completion_is_delivered_once_and_notifies_once_per_batch() {
    let (host, notes) = host(8);
    let exec = Manual::default();
    let a = host.start(&exec, |_| async { Ok(1.5) }).unwrap();
    let b = host.start(&exec, |_| async { Err("boom".to_string()) }).unwrap();
    assert_eq!(notes.calls.load(Ordering::SeqCst), 0, "nothing settles before work runs");
    exec.run_until_stalled();
    assert_eq!(notes.calls.load(Ordering::SeqCst), 1, "notify only on empty -> non-empty");
    assert_eq!(results(&host), vec![(a, Ok(1.5)), (b, Err(OpError::Failed("boom".into())))]);
    assert!(results(&host).is_empty());
    assert!(!host.cancel(a), "cancel after completion has no effect");
    assert!(results(&host).is_empty());
    let stats = host.stats();
    assert_eq!((stats.pending, stats.in_flight, stats.delivered, stats.discarded), (0, 0, 2, 0));
}

#[test]
fn cancellation_settles_promptly_but_work_keeps_receiver_until_it_exits() {
    let (host, _) = host(8);
    let exec = Manual::default();
    let (counter, dropped) = probe();
    let release = CancelToken::new();
    let gate = release.clone();
    let worker_counter = counter.clone();
    // Non-cooperative work: ignores cancellation until released.
    let id = host
        .start(&exec, move |_token| async move {
            gate.cancelled().await;
            let _still_used = &worker_counter;
            Ok(2.0)
        })
        .unwrap();
    exec.run_until_stalled();
    drop(counter); // JS wrapper released
    assert!(host.cancel(id));
    assert_eq!(results(&host), vec![(id, Err(OpError::Cancelled))]);
    assert!(!dropped.load(Ordering::SeqCst), "receiver must survive cancellation");
    assert_eq!(host.stats().in_flight, 1, "slot held until work exits");
    release.cancel();
    exec.run_until_stalled();
    assert!(dropped.load(Ordering::SeqCst), "receiver released when work exits");
    assert!(results(&host).is_empty(), "late result discarded");
    let stats = host.stats();
    assert_eq!((stats.in_flight, stats.discarded), (0, 1));
}

#[test]
fn cooperative_work_observes_cancel_token() {
    let (host, _) = host(8);
    let exec = Manual::default();
    let id = host
        .start(&exec, |token| async move {
            match token.run_until_cancelled(std::future::pending::<()>()).await {
                Some(()) => Ok(1.0),
                None => Err("cancelled".into()),
            }
        })
        .unwrap();
    exec.run_until_stalled();
    assert_eq!(host.stats().in_flight, 1);
    host.cancel(id);
    exec.run_until_stalled();
    assert_eq!(host.stats().in_flight, 0, "woken by cancellation and exited");
    assert_eq!(results(&host), vec![(id, Err(OpError::Cancelled))]);
}

#[test]
fn admission_is_bounded_by_running_work_not_by_settlement() {
    let (host, _) = host(2);
    let exec = Manual::default();
    let a = host.start(&exec, |t| async move { t.cancelled().await; Ok(0.0) }).unwrap();
    host.start(&exec, |t| async move { t.cancelled().await; Ok(0.0) }).unwrap();
    assert_eq!(host.start(&exec, |_| async { Ok(0.0) }), Err(AdmitError::Overloaded));
    host.cancel(a);
    assert_eq!(
        host.start(&exec, |_| async { Ok(0.0) }),
        Err(AdmitError::Overloaded),
        "cancelled work still occupies its slot"
    );
    exec.run_until_stalled();
    assert_eq!(
        host.start(&exec, |_| async { Ok(0.0) }),
        Err(AdmitError::Overloaded),
        "work exited but its cancellation outcome is undrained"
    );
    assert_eq!(results(&host).len(), 1);
    assert!(host.start(&exec, |_| async { Ok(0.0) }).is_ok());
}

#[test]
fn undrained_outcomes_hold_admission_slots_until_drained() {
    let (host, _) = host(2);
    let exec = Manual::default();
    host.start(&exec, |_| async { Ok(1.0) }).unwrap();
    host.start(&exec, |_| async { Ok(2.0) }).unwrap();
    exec.run_until_stalled();
    let stats = host.stats();
    assert_eq!((stats.in_flight, stats.queued, stats.slots), (0, 2, 2), "work exited, outcomes queued");
    assert_eq!(host.start(&exec, |_| async { Ok(0.0) }), Err(AdmitError::Overloaded), "full queue blocks admission");
    assert_eq!(host.drain(1).len(), 1);
    assert!(host.start(&exec, |_| async { Ok(3.0) }).is_ok(), "one drained outcome frees one slot");
    assert_eq!(host.start(&exec, |_| async { Ok(0.0) }), Err(AdmitError::Overloaded));
    exec.run_until_stalled();
    assert_eq!(results(&host).len(), 2);
    assert_eq!(host.stats().slots, 0);
}

#[test]
fn cancelled_running_work_keeps_its_slot_after_the_outcome_is_drained() {
    let (host, _) = host(1);
    let exec = Manual::default();
    let release = CancelToken::new();
    let gate = release.clone();
    let id = host.start(&exec, move |_| async move { gate.cancelled().await; Ok(1.0) }).unwrap();
    exec.run_until_stalled();
    assert!(host.cancel(id));
    assert_eq!(results(&host), vec![(id, Err(OpError::Cancelled))]);
    let stats = host.stats();
    assert_eq!((stats.in_flight, stats.queued, stats.slots), (1, 0, 1));
    assert_eq!(host.start(&exec, |_| async { Ok(0.0) }), Err(AdmitError::Overloaded), "running work holds the slot");
    release.cancel();
    exec.run_until_stalled();
    assert_eq!(host.stats().slots, 0, "released exactly once: no double count");
    assert!(results(&host).is_empty(), "late result discarded, nothing queued");
    // The single slot is reusable, and only once.
    host.start(&exec, |_| async { Ok(2.0) }).unwrap();
    assert_eq!(host.start(&exec, |_| async { Ok(0.0) }), Err(AdmitError::Overloaded));
}

#[test]
fn teardown_releases_slots_of_dropped_outcomes() {
    let (host, _) = host(2);
    let exec = Manual::default();
    host.start(&exec, |_| async { Ok(1.0) }).unwrap();
    exec.run_until_stalled();
    assert_eq!(host.stats().slots, 1);
    host.teardown();
    assert_eq!(host.stats().slots, 0);
}

#[test]
fn teardown_cancels_discards_and_releases_notifier_without_blocking() {
    let (host, notes) = host(8);
    let exec = Manual::default();
    let (counter, dropped) = probe();
    let c = counter.clone();
    host.start(&exec, |_| async { Ok(1.0) }).unwrap();
    exec.run_until_stalled(); // completed, queued, not drained
    let running = host
        .start(&exec, move |token| async move {
            token.cancelled().await;
            let _ = &c;
            Ok(2.0)
        })
        .unwrap();
    drop(counter);
    let calls_before = notes.calls.load(Ordering::SeqCst);
    assert_eq!(host.teardown().cancelled, 1);
    assert!(notes.released.load(Ordering::SeqCst), "notifier released at teardown");
    assert!(results(&host).is_empty(), "queued outcomes dropped, not delivered");
    assert!(!host.cancel(running));
    assert_eq!(host.start(&exec, |_| async { Ok(0.0) }), Err(AdmitError::Closed));
    assert!(!dropped.load(Ordering::SeqCst), "running work still owns its receiver");
    exec.run_until_stalled();
    assert!(dropped.load(Ordering::SeqCst));
    assert_eq!(notes.calls.load(Ordering::SeqCst), calls_before, "no notify after teardown");
    let stats = host.stats();
    assert_eq!((stats.open, stats.in_flight, stats.discarded), (false, 0, 2));
}

#[test]
fn dropped_task_reports_loss_after_releasing_its_receiver() {
    let (host, notes) = host(8);
    let exec = Manual::default();
    let (counter, dropped) = probe();
    *notes.probe.lock().unwrap() = Some(dropped.clone());
    let id = host
        .start(&exec, move |token| async move {
            token.cancelled().await;
            let _ = &counter;
            Ok(1.0)
        })
        .unwrap();
    exec.run_until_stalled();
    exec.drop_all_tasks();
    assert_eq!(results(&host), vec![(id, Err(OpError::Lost))]);
    assert_eq!(*notes.probe_dropped_at_notify.lock().unwrap(), vec![true]);
    assert_eq!(host.stats().in_flight, 0);
}

#[test]
fn completion_cancel_race_has_exactly_one_terminal_outcome() {
    let (host, _) = host(4);
    let mut cancels_won = 0;
    for _ in 0..2_000 {
        let ticket = host.admit().unwrap();
        let id = ticket.id();
        let barrier = Arc::new(Barrier::new(2));
        let b = barrier.clone();
        let worker = std::thread::spawn(move || {
            b.wait();
            ticket.finish(Ok(7.0));
        });
        barrier.wait();
        let cancelled = host.cancel(id);
        worker.join().unwrap();
        let outcomes = results(&host);
        assert_eq!(outcomes.len(), 1, "exactly one outcome for {id}");
        match &outcomes[0].1 {
            Err(OpError::Cancelled) => {
                assert!(cancelled);
                cancels_won += 1;
            }
            Ok(7.0) => assert!(!cancelled),
            other => panic!("unexpected {other:?}"),
        }
    }
    let stats = host.stats();
    assert_eq!(stats.delivered, 2_000);
    assert_eq!(stats.discarded, cancels_won);
    assert_eq!(stats.in_flight, 0);
}

#[test]
fn generations_are_distinct_and_independent() {
    let (old, _) = host(4);
    let exec = Manual::default();
    old.start(&exec, |_| async { Ok(1.0) }).unwrap();
    old.teardown();
    let (new, _) = host(4);
    assert_ne!(old.generation(), new.generation());
    exec.run_until_stalled(); // the old generation's work finishes late
    assert!(results(&new).is_empty());
    assert_eq!(old.stats().discarded, 1);
}

#[cfg(feature = "tokio")]
#[test]
fn tokio_external_runtime_runs_timers_and_survives_teardown() {
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_time().build().unwrap();
    let spawner = exec::TokioSpawner::external(runtime.handle().clone());
    let (host, notes) = host(8);
    let id = host
        .start(&spawner, |_| async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            Ok(3.0)
        })
        .unwrap();
    wait_until(|| notes.calls.load(Ordering::SeqCst) == 1);
    assert_eq!(results(&host), vec![(id, Ok(3.0))]);

    host.start(&spawner, |token| async move {
        token.run_until_cancelled(tokio::time::sleep(Duration::from_secs(30))).await;
        Ok(0.0)
    })
    .unwrap();
    assert_eq!(host.teardown().cancelled, 1);
    wait_until(|| host.stats().in_flight == 0);
    drop(spawner);
    drop(host);
    // The application's runtime is untouched by adapter teardown and spawner drops.
    assert_eq!(runtime.block_on(async { tokio::time::sleep(Duration::from_millis(1)).await; 5 }), 5);
}

#[cfg(feature = "tokio")]
#[test]
fn tokio_owned_runtime_shutdown_reports_lost_tasks() {
    let spawner = exec::TokioSpawner::owned(1).unwrap();
    let (host, notes) = host(8);
    let id = host
        .start(&spawner, |_| async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(1.0)
        })
        .unwrap();
    std::thread::sleep(Duration::from_millis(20));
    drop(spawner); // last owner: shutdown_background, does not block
    wait_until(|| notes.calls.load(Ordering::SeqCst) == 1);
    assert_eq!(results(&host), vec![(id, Err(OpError::Lost))]);
}

#[cfg(feature = "smol")]
#[test]
fn smol_application_executor() {
    let executor = Arc::new(async_executor::Executor::new());
    let stop = CancelToken::new();
    let driver = {
        let (executor, stop) = (executor.clone(), stop.clone());
        std::thread::spawn(move || futures_lite::future::block_on(executor.run(stop.cancelled())))
    };
    let spawner = exec::SmolSpawner(executor);
    let (host, notes) = host(8);
    let id = host.start(&spawner, |_| async { Ok(4.0) }).unwrap();
    wait_until(|| notes.calls.load(Ordering::SeqCst) == 1);
    assert_eq!(results(&host), vec![(id, Ok(4.0))]);
    host.teardown();
    stop.cancel();
    driver.join().unwrap();
}

#[cfg(any(feature = "tokio", feature = "smol"))]
fn wait_until(mut condition: impl FnMut() -> bool) {
    for _ in 0..2_000 {
        if condition() {
            return;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    panic!("condition not reached");
}

fn budget_host(max: usize, budget: &Budget) -> (Host<f64, Notifier>, Notes) {
    let notes = Notes::default();
    (Host::with_budget(max, budget.clone(), Notifier(notes.clone())), notes)
}

/// Non-cooperative work: ignores its own cancel token and exits only when `gate` fires.
fn stubborn(gate: &CancelToken, receiver: Native<Probe>) -> impl FnOnce(CancelToken) -> Pin<Box<dyn Future<Output = Result<f64, String>> + Send>> {
    let gate = gate.clone();
    move |_token| {
        Box::pin(async move {
            gate.cancelled().await;
            let _still_used = &receiver;
            Ok(1.0)
        })
    }
}

#[test]
fn teardown_reports_cancelled_discarded_and_still_running_work() {
    let (host, _) = host(8);
    let exec = Manual::default();
    let gate = CancelToken::new();
    host.start(&exec, |_| async { Ok(1.0) }).unwrap();
    exec.run_until_stalled(); // one queued outcome
    host.start(&exec, |t| async move { t.cancelled().await; Ok(2.0) }).unwrap();
    host.start(&exec, stubborn(&gate, probe().0)).unwrap();
    exec.run_until_stalled();
    let report = host.teardown();
    assert_eq!(report, TeardownReport { cancelled: 2, discarded_queued: 1, still_running: 2 });
    assert_eq!(host.teardown(), TeardownReport::default(), "idempotent");
}

#[test]
fn shared_budget_counts_closed_generations_until_their_work_exits() {
    let budget = Budget::new(3);
    let exec = Manual::default();
    let gate = CancelToken::new();
    let (old, _) = budget_host(8, &budget);
    let (counter, dropped) = probe();
    old.start(&exec, stubborn(&gate, counter.clone())).unwrap();
    let cancelled_id = old.start(&exec, stubborn(&gate, counter)).unwrap();
    exec.run_until_stalled();
    assert!(old.cancel(cancelled_id), "cancellation wins the race");
    assert_eq!(budget.stats().running, 2, "cancellation does not return the permit");

    // Reload: the old generation is torn down while its work keeps running.
    let report = old.teardown();
    assert_eq!(report.still_running, 2);
    let stats = budget.stats();
    assert_eq!((stats.running, stats.orphaned), (2, 2));

    let (new, _) = budget_host(8, &budget);
    new.start(&exec, |t| async move { t.cancelled().await; Ok(0.0) }).unwrap();
    let before = new.stats();
    let refused = new.start(&exec, |_| async { Ok(0.0) }).unwrap_err();
    let AdmitError::Saturated(snapshot) = refused else { panic!("expected Saturated, got {refused:?}") };
    assert_eq!((snapshot.limit, snapshot.running, snapshot.orphaned, snapshot.rejected), (3, 3, 2, 1), "snapshot at refusal");
    assert_eq!(
        refused.to_string(),
        "executor budget exhausted: 3/3 operations running, 2 of them from closed runtimes; retry after they exit"
    );
    let after = new.stats();
    assert_eq!((after.slots, after.pending, after.admitted), (before.slots, before.pending, before.admitted), "rejection reserves nothing");
    assert_eq!(budget.stats().rejected, 1);
    assert!(!dropped.load(Ordering::SeqCst), "orphaned work still owns its receiver");

    gate.cancel(); // the non-cooperative work finally exits
    exec.run_until_stalled();
    assert!(dropped.load(Ordering::SeqCst));
    let stats = budget.stats();
    assert_eq!((stats.running, stats.orphaned, stats.peak), (1, 0, 3));
    assert!(new.start(&exec, |_| async { Ok(0.0) }).is_ok(), "permits returned once work exited");
}

#[test]
fn repeated_reloads_with_non_cooperative_work_stay_within_the_budget() {
    const LIMIT: usize = 6;
    let budget = Budget::new(LIMIT);
    let exec = Manual::default();
    let mut gates = Vec::new();
    let mut probes = Vec::new();
    let (mut admitted, mut saturated) = (0, 0);
    for _generation in 0..10 {
        let (host, _) = budget_host(4, &budget);
        let gate = CancelToken::new();
        for _ in 0..4 {
            let (counter, dropped) = probe();
            probes.push(dropped);
            match host.start(&exec, stubborn(&gate, counter)) {
                Ok(_) => admitted += 1,
                Err(AdmitError::Saturated(_)) => saturated += 1,
                Err(other) => panic!("unexpected {other:?}"),
            }
        }
        exec.run_until_stalled();
        assert!(budget.stats().running <= LIMIT);
        host.teardown();
        gates.push(gate);
    }
    assert_eq!((admitted, saturated), (LIMIT, 40 - LIMIT));
    let stats = budget.stats();
    assert_eq!((stats.running, stats.orphaned, stats.peak), (LIMIT, LIMIT, LIMIT));
    for gate in &gates {
        gate.cancel();
    }
    exec.run_until_stalled();
    let stats = budget.stats();
    assert_eq!((stats.running, stats.orphaned), (0, 0));
    assert!(probes.iter().all(|d| d.load(Ordering::SeqCst)), "every receiver released");
}

#[test]
fn teardown_from_another_thread_races_completions_without_late_notify() {
    // Models RN invalidation: teardown runs on a background thread while workers finish.
    let mut both_orders = (0, 0);
    for _ in 0..300 {
        let (host, notes) = host(64);
        let mut first: Vec<_> = (0..32).map(|_| host.admit().unwrap()).collect();
        let second = first.split_off(16);
        let barrier = Arc::new(Barrier::new(3));
        let spawn = |batch: Vec<Ticket<f64, Notifier>>| {
            let b = barrier.clone();
            std::thread::spawn(move || {
                b.wait();
                for ticket in batch {
                    ticket.finish(Ok(1.0));
                }
            })
        };
        let threads = [spawn(first), spawn(second)];
        barrier.wait();
        let report = host.teardown();
        let calls_at_teardown = notes.calls.load(Ordering::SeqCst);
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(notes.calls.load(Ordering::SeqCst), calls_at_teardown, "notify after teardown returned");
        assert!(notes.released.load(Ordering::SeqCst));
        assert_eq!(report.cancelled + report.discarded_queued, 32, "each operation is either cancelled or its queued outcome dropped");
        let stats = host.stats();
        assert_eq!((stats.in_flight, stats.queued, stats.slots, stats.pending), (0, 0, 0, 0));
        assert_eq!(stats.discarded, 32, "late and queued results all dropped unconverted");
        assert!(results(&host).is_empty(), "nothing reaches the closed runtime");
        both_orders.0 += usize::from(report.cancelled > 0);
        both_orders.1 += usize::from(report.discarded_queued > 0);
    }
    assert!(both_orders.0 > 0 && both_orders.1 > 0, "race exercised both orders: {both_orders:?}");
}
