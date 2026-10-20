//! Engine-independent touch input of one surface (docs/surface.md, "Touch input").
//!
//! The platform view pushes pointer transitions on the UI thread
//! ([`crate::platform::touch`]); the renderer drains them on its own thread
//! ([`crate::Surface::drain_touch`]). Nothing here calls JS.
//!
//! # Contract
//! - **Opt-in twice.** The renderer calls [`crate::Surface::enable_touch`], and the app sets the
//!   view's `touchInput="rust"` prop. Without both, every push is refused and the view does not
//!   consume the touch.
//! - **Epoch = attachment.** Events are accepted only for the surface's current attachment
//!   number. Attach starts an epoch with no pointers; detach and close end it with a
//!   [`TouchRecord::Reset`]. An event named with any other attachment is refused, so input meant
//!   for an old window never reaches a new one.
//! - **Reset** means: cancel every pointer the consumer has seen `Down` for and not yet
//!   `Up`/`Cancel`, whatever its epoch (`attachment` names the epoch that ended or overflowed).
//!   Records drained before it stay valid; nothing after it refers to those pointers again.
//!   Since a reset covers every earlier pointer, replacing queued records by a reset (overflow,
//!   or a detach on a full queue) never loses an end. Detach queues its reset even when no
//!   further frame is rendered; the consumer must drain and apply it before its next update.
//! - **Stable ids.** Each accepted down gets a new id from a per-surface counter starting at 1
//!   (never reused, below 2^53). Platform pointer ids (Android pointer ids, iOS view slots), which
//!   the platform reuses, map to it only while that pointer is down. At [`MAX_STABLE_ID`] new downs are refused (fail closed).
//! - **Bounds.** At most [`MAX_POINTERS`] pointers are tracked; a further down is refused and
//!   that pointer's later events are ignored. The queue holds at most [`QUEUE_CAPACITY`] records,
//!   so one drain returns at most that many.
//! - **Coalescing.** A move replaces the queued move of the same pointer if no transition
//!   (down, up, cancel, reset) has been queued since it. Within such a run of moves each record
//!   is the latest *snapshot* of its pointer; the order of moves between different pointers in
//!   a run is not meaningful. Transitions are never reordered or merged.
//! - **Overflow.** A push that finds the queue full replaces the whole queue with one
//!   `Reset { reason: Overflow }`: every pointer down at that moment is canceled, and its
//!   remaining events are dropped until its up or cancel. New downs then start normally. So a
//!   touch can never stay down: either its up/cancel is queued, or a reset covering it is.
//! - **Positions** are component-local physical pixels with the attachment's scale and size
//!   captured at push time (a later resize does not change queued events).
//! - **Time** is the platform's event time in milliseconds of system uptime (monotonic):
//!   Android `SystemClock.uptimeMillis` (excludes deep sleep), iOS `UITouch.timestamp`. It is
//!   not comparable with wall-clock or `Instant` time. The browser path documents its own clock
//!   (docs/surface.md).
//! - **Locking.** A push takes this queue's mutex, then (separately, after releasing it) the
//!   surface-state mutex to fetch the renderer's waker. Each is taken alone. The UI thread can
//!   wait for them only while another holder runs a short critical section: a push, the
//!   renderer moving at most [`QUEUE_CAPACITY`] records out, or the renderer's state snapshot
//!   or lease, attach, resize, detach or close bookkeeping. It never waits for rendering or GPU
//!   work and calls no JS, but it is not lock-free or wait-free.
use std::collections::VecDeque;

use crate::Extent;

/// Records queued per surface at most (and so returned by one drain at most).
pub const QUEUE_CAPACITY: usize = 128;
/// Pointers tracked per surface at most.
pub const MAX_POINTERS: usize = 10;
/// Stable ids stay below this (exact JS numbers); at the limit downs are refused.
pub const MAX_STABLE_ID: u64 = 1 << 53;

/// A pointer transition from the platform (`platform::touch`'s `phase`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// First or additional pointer down.
    Down,
    Move,
    Up,
    /// The platform canceled this pointer.
    Cancel,
    /// The platform canceled the whole gesture (Android `ACTION_CANCEL`, opt-out mid-gesture).
    /// The pointer id is ignored.
    CancelAll,
}

impl Phase {
    /// The platform's integer code (the Kotlin view's constants).
    pub fn from_code(code: i32) -> Option<Self> {
        Some(match code {
            0 => Self::Down,
            1 => Self::Move,
            2 => Self::Up,
            3 => Self::Cancel,
            4 => Self::CancelAll,
            _ => return None,
        })
    }
}

/// What happened to a pointer, as delivered to the renderer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TouchPhase {
    Down,
    Move,
    Up,
    Cancel,
}

/// One pointer event of attachment `attachment`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TouchEvent {
    pub attachment: u64,
    /// Stable for the pointer's lifetime from down to up/cancel; never reused on this surface.
    pub id: u64,
    pub phase: TouchPhase,
    /// Component-local physical pixels (origin top-left, y down).
    pub x_px: f32,
    pub y_px: f32,
    /// The attachment's size and scale (physical pixels per layout unit) when this was pushed.
    pub extent: Extent,
    /// Platform uptime in milliseconds (monotonic; see the module docs).
    pub time_ms: i64,
}

impl TouchEvent {
    /// Position in layout units (logical pixels): physical pixels divided by the scale.
    pub fn logical(&self) -> (f32, f32) {
        let scale = if self.extent.scale > 0.0 { self.extent.scale } else { 1.0 };
        (self.x_px / scale, self.y_px / scale)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResetReason {
    /// The queue was full.
    Overflow,
    /// The attachment ended (detach: background, unmount, key change, zero size).
    Detached,
    /// The surface was closed.
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TouchRecord {
    Event(TouchEvent),
    /// Cancel every pointer still down for the consumer (any epoch).
    Reset { attachment: u64, reason: ResetReason },
}

/// Per-surface counters (since creation).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TouchCounters {
    pub accepted: u64,
    /// Moves merged into a queued move.
    pub coalesced: u64,
    /// Pushes refused: input not enabled, closed, or not the current attachment.
    pub refused_stale: u64,
    /// Downs refused at [`MAX_POINTERS`] or [`MAX_STABLE_ID`].
    pub refused_capacity: u64,
    /// Events of pointers that are unknown or were canceled by a reset (dropped).
    pub dropped: u64,
    pub overflows: u64,
    pub resets: u64,
}

#[derive(Clone, Copy, Debug)]
struct Pointer {
    platform_id: i32,
    id: u64,
    /// Canceled by an overflow reset: further events are dropped until up/cancel.
    lost: bool,
}

/// The per-surface state behind its mutex.
#[derive(Debug)]
pub(crate) struct TouchQueue {
    enabled: bool,
    closed: bool,
    epoch: u64,
    extent: Extent,
    pointers: Vec<Pointer>,
    queue: VecDeque<TouchRecord>,
    /// Index into `queue` where the trailing run of moves starts (coalescing window).
    moves_from: usize,
    next_id: u64,
    pub(crate) counters: TouchCounters,
}

impl Default for TouchQueue {
    fn default() -> Self {
        Self {
            enabled: false,
            closed: false,
            epoch: 0,
            extent: Extent::default(),
            pointers: Vec::with_capacity(MAX_POINTERS),
            queue: VecDeque::with_capacity(QUEUE_CAPACITY),
            moves_from: 0,
            next_id: 1,
            counters: TouchCounters::default(),
        }
    }
}

impl TouchQueue {
    pub(crate) fn enable(&mut self) {
        if !self.closed {
            self.enabled = true;
        }
    }

    /// A new attachment: ends any previous epoch (a reset if it still had one), then starts
    /// `attachment` with no pointers.
    pub(crate) fn begin(&mut self, attachment: u64, extent: Extent) {
        self.end(self.epoch, ResetReason::Detached);
        self.epoch = attachment;
        self.extent = extent;
    }

    pub(crate) fn resize(&mut self, attachment: u64, extent: Extent) {
        if self.epoch == attachment && attachment != 0 {
            self.extent = extent;
        }
    }

    /// Ends epoch `attachment` if current: queues a reset for it (queued records stay), forgets
    /// its pointers, and refuses further pushes until the next [`Self::begin`]. True if a reset
    /// was queued.
    pub(crate) fn end(&mut self, attachment: u64, reason: ResetReason) -> bool {
        if attachment == 0 || self.epoch != attachment {
            return false;
        }
        self.epoch = 0;
        self.pointers.clear();
        if self.queue.len() >= QUEUE_CAPACITY {
            self.queue.clear(); // the reset below covers everything dropped
            self.counters.overflows += 1;
        }
        self.push_transition(TouchRecord::Reset { attachment, reason });
        self.counters.resets += 1;
        true
    }

    pub(crate) fn close(&mut self) -> bool {
        self.closed = true;
        self.enabled = false;
        self.end(self.epoch, ResetReason::Closed)
    }

    fn push_transition(&mut self, record: TouchRecord) {
        self.queue.push_back(record);
        self.moves_from = self.queue.len();
    }

    /// Makes room for one record: on a full queue, replaces it with an overflow reset and marks
    /// every pointer lost. True if it did.
    fn reserve(&mut self) -> bool {
        if self.queue.len() < QUEUE_CAPACITY {
            return false;
        }
        self.queue.clear(); // the reset covers everything dropped
        self.counters.overflows += 1;
        self.counters.resets += 1;
        for p in &mut self.pointers {
            p.lost = true;
        }
        self.push_transition(TouchRecord::Reset { attachment: self.epoch, reason: ResetReason::Overflow });
        true
    }

    fn event(&self, id: u64, phase: TouchPhase, x_px: f32, y_px: f32, time_ms: i64) -> TouchEvent {
        TouchEvent { attachment: self.epoch, id, phase, x_px, y_px, extent: self.extent, time_ms }
    }

    /// Accepts or refuses one platform transition. True means accepted (for a down: the
    /// surface takes this pointer).
    pub(crate) fn push(&mut self, attachment: u64, phase: Phase, platform_id: i32, x_px: f32, y_px: f32, time_ms: i64) -> bool {
        if !self.enabled || self.closed || self.epoch == 0 || attachment != self.epoch {
            self.counters.refused_stale += 1;
            return false;
        }
        let (x_px, y_px) = (if x_px.is_finite() { x_px } else { 0.0 }, if y_px.is_finite() { y_px } else { 0.0 });
        let found = self.pointers.iter().position(|p| p.platform_id == platform_id);
        match phase {
            Phase::Down => {
                if let Some(i) = found {
                    // A second down without an up (not expected from the platform views): end the old one.
                    self.finish(i, TouchPhase::Cancel, x_px, y_px, time_ms);
                }
                if self.pointers.len() >= MAX_POINTERS || self.next_id >= MAX_STABLE_ID {
                    self.counters.refused_capacity += 1;
                    return false;
                }
                self.reserve();
                let id = self.next_id;
                self.next_id += 1;
                self.pointers.push(Pointer { platform_id, id, lost: false });
                let event = self.event(id, TouchPhase::Down, x_px, y_px, time_ms);
                self.push_transition(TouchRecord::Event(event));
                self.counters.accepted += 1;
                true
            }
            Phase::Move => {
                let Some(p) = found.map(|i| self.pointers[i]).filter(|p| !p.lost) else {
                    self.counters.dropped += 1;
                    return false;
                };
                let event = self.event(p.id, TouchPhase::Move, x_px, y_px, time_ms);
                let start = self.moves_from.min(self.queue.len());
                let queued = self.queue.range_mut(start..).find(|r| matches!(r, TouchRecord::Event(e) if e.id == p.id));
                if let Some(slot) = queued {
                    *slot = TouchRecord::Event(event);
                    self.counters.coalesced += 1;
                    return true;
                }
                if self.reserve() {
                    self.counters.dropped += 1; // this pointer was just canceled by the reset
                    return false;
                }
                self.queue.push_back(TouchRecord::Event(event));
                self.counters.accepted += 1;
                true
            }
            Phase::Up | Phase::Cancel => {
                let Some(i) = found else {
                    self.counters.dropped += 1;
                    return false;
                };
                let end = if phase == Phase::Up { TouchPhase::Up } else { TouchPhase::Cancel };
                self.finish(i, end, x_px, y_px, time_ms)
            }
            Phase::CancelAll => {
                while !self.pointers.is_empty() {
                    let last = self.pointers.len() - 1;
                    self.finish(last, TouchPhase::Cancel, x_px, y_px, time_ms);
                }
                true
            }
        }
    }

    /// Removes pointer `i`, queueing its up/cancel unless a reset covers it.
    fn finish(&mut self, i: usize, phase: TouchPhase, x_px: f32, y_px: f32, time_ms: i64) -> bool {
        let p = self.pointers.remove(i);
        if p.lost || self.reserve() {
            // Canceled by an earlier overflow reset, or by the one reserve() just queued.
            self.counters.dropped += 1;
            return false;
        }
        let event = self.event(p.id, phase, x_px, y_px, time_ms);
        self.push_transition(TouchRecord::Event(event));
        self.counters.accepted += 1;
        true
    }

    /// Moves every queued record into `out` (cleared first), at most [`QUEUE_CAPACITY`].
    pub(crate) fn drain(&mut self, out: &mut Vec<TouchRecord>) {
        out.clear();
        out.extend(self.queue.drain(..));
        self.moves_from = 0;
    }

    pub(crate) fn active(&self) -> usize {
        self.pointers.iter().filter(|p| !p.lost).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    const E: Extent = Extent { width: 1440, height: 1000, scale: 3.5 };

    fn queue(attachment: u64) -> TouchQueue {
        let mut q = TouchQueue::default();
        q.enable();
        q.begin(attachment, E);
        q
    }

    fn drain(q: &mut TouchQueue) -> Vec<TouchRecord> {
        let mut out = Vec::new();
        q.drain(&mut out);
        out
    }

    fn ev(r: &TouchRecord) -> (u64, TouchPhase, f32) {
        match r {
            TouchRecord::Event(e) => (e.id, e.phase, e.x_px),
            other => panic!("expected an event, got {other:?}"),
        }
    }

    /// Fills the queue exactly to capacity with transitions of platform pointer 1 (which cannot
    /// coalesce); returns the last time used.
    fn fill(q: &mut TouchQueue) -> i64 {
        let mut t = 0;
        while q.queue.len() < QUEUE_CAPACITY {
            t += 1;
            let phase = if q.pointers.iter().any(|p| p.platform_id == 1) { Phase::Up } else { Phase::Down };
            assert!(q.push(1, phase, 1, 0.0, 0.0, t));
        }
        t
    }

    /// The consumer's view: which ids are down. Panics on an event that contradicts it.
    #[derive(Default)]
    struct Consumer {
        down: HashSet<u64>,
        seen: HashSet<u64>,
        resets: u64,
    }
    impl Consumer {
        fn apply(&mut self, records: &[TouchRecord]) {
            for r in records {
                match r {
                    TouchRecord::Reset { .. } => {
                        self.down.clear();
                        self.resets += 1;
                    }
                    TouchRecord::Event(e) => match e.phase {
                        TouchPhase::Down => {
                            assert!(self.seen.insert(e.id), "id {} reused", e.id);
                            self.down.insert(e.id);
                        }
                        TouchPhase::Move => assert!(self.down.contains(&e.id), "move of {} not down", e.id),
                        TouchPhase::Up | TouchPhase::Cancel => assert!(self.down.remove(&e.id), "end of {} not down", e.id),
                    },
                }
            }
        }
    }

    #[test]
    fn refused_until_enabled_and_attached() {
        let mut q = TouchQueue::default();
        q.begin(7, E);
        assert!(!q.push(7, Phase::Down, 0, 1.0, 1.0, 1), "not enabled");
        q.enable();
        assert!(!q.push(6, Phase::Down, 0, 1.0, 1.0, 1), "another attachment");
        assert!(q.push(7, Phase::Down, 0, 1.0, 1.0, 1));
        assert_eq!(q.counters.refused_stale, 2);
        let mut detached = TouchQueue::default();
        detached.enable();
        assert!(!detached.push(0, Phase::Down, 0, 1.0, 1.0, 1), "no attachment");
    }

    #[test]
    fn down_move_up_with_stable_ids_units_and_per_event_extent() {
        let mut q = queue(3);
        assert!(q.push(3, Phase::Down, 0, 35.0, 70.0, 100));
        q.resize(3, Extent { scale: 2.0, ..E });
        assert!(q.push(3, Phase::Move, 0, 40.0, 70.0, 116));
        assert!(q.push(3, Phase::Up, 0, 40.0, 70.0, 120));
        assert!(q.push(3, Phase::Down, 0, 1.0, 1.0, 200), "Android reuses pointer id 0");
        let r = drain(&mut q);
        assert_eq!(r.len(), 4);
        let TouchRecord::Event(down) = r[0] else { panic!() };
        let TouchRecord::Event(moved) = r[1] else { panic!() };
        assert_eq!((down.id, down.attachment, down.time_ms), (1, 3, 100));
        assert_eq!(down.logical(), (10.0, 20.0));
        assert_eq!(moved.logical(), (20.0, 35.0), "the scale when pushed");
        assert_eq!(ev(&r[2]), (1, TouchPhase::Up, 40.0));
        assert_eq!(ev(&r[3]).0, 2, "a new id for the reused platform id");
    }

    #[test]
    fn moves_coalesce_only_within_the_trailing_run_of_moves() {
        let mut q = queue(1);
        q.push(1, Phase::Down, 0, 0.0, 0.0, 0);
        q.push(1, Phase::Down, 1, 0.0, 0.0, 0);
        for x in 1..=5 {
            q.push(1, Phase::Move, 0, x as f32, 0.0, x);
            q.push(1, Phase::Move, 1, 10.0 * x as f32, 0.0, x);
        }
        q.push(1, Phase::Up, 0, 5.0, 0.0, 6);
        q.push(1, Phase::Move, 1, 60.0, 0.0, 7);
        q.push(1, Phase::Move, 1, 70.0, 0.0, 8);
        let r: Vec<_> = drain(&mut q).iter().map(ev).collect();
        assert_eq!(r, vec![
            (1, TouchPhase::Down, 0.0),
            (2, TouchPhase::Down, 0.0),
            (1, TouchPhase::Move, 5.0),
            (2, TouchPhase::Move, 50.0),
            (1, TouchPhase::Up, 5.0),
            (2, TouchPhase::Move, 70.0), // not merged across the up
        ]);
        assert_eq!(q.counters.coalesced, 9);
        q.push(1, Phase::Move, 1, 80.0, 0.0, 9);
        assert_eq!(drain(&mut q).iter().map(ev).collect::<Vec<_>>(), vec![(2, TouchPhase::Move, 80.0)], "drained moves are not rewritten");
    }

    #[test]
    fn overflow_resets_cancels_held_pointers_until_their_end_and_accepts_new_downs() {
        let mut q = queue(1);
        let mut consumer = Consumer::default();
        assert!(q.push(1, Phase::Down, 0, 0.0, 0.0, 0));
        consumer.apply(&drain(&mut q));
        // Fill the queue with transitions of another pointer (no coalescing possible).
        let t = fill(&mut q);
        assert!(!q.push(1, Phase::Move, 0, 9.0, 0.0, t + 1), "the move that overflowed is dropped");
        assert_eq!(q.counters.overflows, 1);
        assert!(!q.push(1, Phase::Move, 0, 9.0, 0.0, t + 2), "pointer 0 was canceled by the reset");
        assert!(q.push(1, Phase::Down, 2, 0.0, 0.0, t + 3), "a new pointer starts normally");
        assert!(!q.push(1, Phase::Up, 0, 0.0, 0.0, t + 4), "its up is dropped: the reset ended it");
        assert!(q.push(1, Phase::Down, 0, 0.0, 0.0, t + 5), "the platform id is free again");
        let r = drain(&mut q);
        assert!(matches!(r[0], TouchRecord::Reset { attachment: 1, reason: ResetReason::Overflow }));
        consumer.apply(&r);
        assert_eq!(consumer.down.len(), 2, "pointer 0 (old) gone; pointer 2 and the new 0 down");
        assert_eq!(q.active(), 2);
    }

    #[test]
    fn an_end_that_overflows_is_covered_by_the_reset() {
        let mut q = queue(1);
        q.push(1, Phase::Down, 0, 0.0, 0.0, 0);
        let t = fill(&mut q);
        assert!(!q.push(1, Phase::Up, 0, 0.0, 0.0, t + 1));
        let r = drain(&mut q);
        assert_eq!(r.len(), 1);
        let mut consumer = Consumer::default();
        consumer.apply(&r);
        assert_eq!(q.active(), 0);
    }

    #[test]
    fn detach_resets_after_queued_records_and_a_new_epoch_starts_clean() {
        let mut q = queue(1);
        let mut consumer = Consumer::default();
        q.push(1, Phase::Down, 0, 0.0, 0.0, 0);
        consumer.apply(&drain(&mut q));
        q.push(1, Phase::Down, 1, 0.0, 0.0, 1);
        q.push(1, Phase::Up, 1, 0.0, 0.0, 2);
        assert!(q.end(1, ResetReason::Detached));
        assert!(!q.end(1, ResetReason::Detached), "once");
        assert!(!q.push(1, Phase::Move, 0, 0.0, 0.0, 3), "old epoch refused");
        q.begin(2, E);
        assert!(!q.push(1, Phase::Move, 0, 0.0, 0.0, 4), "old attachment number refused");
        assert!(!q.push(2, Phase::Move, 0, 0.0, 0.0, 5), "a pointer of the old window is unknown in the new epoch");
        assert!(!q.push(2, Phase::Up, 0, 0.0, 0.0, 6));
        assert!(q.push(2, Phase::Down, 0, 0.0, 0.0, 7));
        let r = drain(&mut q);
        assert_eq!(ev(&r[0]).1, TouchPhase::Down);
        assert_eq!(ev(&r[1]).1, TouchPhase::Up);
        assert!(matches!(r[2], TouchRecord::Reset { attachment: 1, reason: ResetReason::Detached }));
        let TouchRecord::Event(new) = r[3] else { panic!() };
        assert_eq!((new.attachment, new.id), (2, 3));
        consumer.apply(&r);
        assert_eq!(consumer.down, HashSet::from([3]));
    }

    #[test]
    fn detach_on_a_full_queue_still_resets() {
        let mut q = queue(1);
        q.push(1, Phase::Down, 0, 0.0, 0.0, 0);
        fill(&mut q);
        assert!(q.end(1, ResetReason::Detached));
        let r = drain(&mut q);
        assert!(matches!(r[..], [TouchRecord::Reset { reason: ResetReason::Detached, .. }]));
    }

    #[test]
    fn close_resets_and_refuses_for_good() {
        let mut q = queue(1);
        q.push(1, Phase::Down, 0, 0.0, 0.0, 0);
        assert!(q.close());
        q.enable();
        q.begin(2, E);
        assert!(!q.push(2, Phase::Down, 0, 0.0, 0.0, 1));
        assert!(matches!(drain(&mut q).last(), Some(TouchRecord::Reset { reason: ResetReason::Closed, .. })));
    }

    #[test]
    fn pointer_capacity_and_id_exhaustion_fail_closed() {
        let mut q = queue(1);
        for i in 0..MAX_POINTERS as i32 {
            assert!(q.push(1, Phase::Down, i, 0.0, 0.0, 0));
        }
        assert!(!q.push(1, Phase::Down, 99, 0.0, 0.0, 0));
        assert!(!q.push(1, Phase::Move, 99, 0.0, 0.0, 0) && !q.push(1, Phase::Up, 99, 0.0, 0.0, 0), "the refused pointer is ignored");
        assert!(q.push(1, Phase::CancelAll, -1, 0.0, 0.0, 1));
        assert_eq!(q.active(), 0);
        let mut consumer = Consumer::default();
        consumer.apply(&drain(&mut q));
        assert!(consumer.down.is_empty());
        q.next_id = MAX_STABLE_ID - 1;
        assert!(q.push(1, Phase::Down, 0, 0.0, 0.0, 2));
        assert!(!q.push(1, Phase::Down, 1, 0.0, 0.0, 3), "ids exhausted");
        assert!(q.push(1, Phase::Up, 0, 0.0, 0.0, 4), "existing pointers still end");
        assert_eq!(q.counters.refused_capacity, 2);
    }

    /// A long pseudo-random stream with random drains, epochs and overflows: the consumer never
    /// sees a contradiction, a drain never exceeds the capacity, and after the platform ends
    /// the gesture nothing stays down.
    #[test]
    fn random_streams_never_leave_a_touch_down() {
        let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut rand = move |n: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % n
        };
        let mut q = queue(1);
        let mut attachment = 1;
        let mut consumer = Consumer::default();
        let mut platform_down: Vec<i32> = Vec::new();
        let mut out = Vec::new();
        for step in 0..200_000 {
            match rand(100) {
                0..=9 if platform_down.len() < 12 => {
                    let id = (0..12).find(|i| !platform_down.contains(i)).unwrap();
                    q.push(attachment, Phase::Down, id, 0.0, 0.0, step);
                    platform_down.push(id);
                }
                10..=17 if !platform_down.is_empty() => {
                    let id = platform_down.remove(rand(platform_down.len() as u64) as usize);
                    q.push(attachment, if rand(4) == 0 { Phase::Cancel } else { Phase::Up }, id, 0.0, 0.0, step);
                }
                18 => {
                    q.push(attachment, Phase::CancelAll, -1, 0.0, 0.0, step);
                    platform_down.clear();
                }
                19 => {
                    q.end(attachment, ResetReason::Detached);
                    attachment += 1;
                    q.begin(attachment, E);
                    // The platform gesture continues against the new attachment.
                }
                20..=24 => {
                    q.drain(&mut out);
                    assert!(out.len() <= QUEUE_CAPACITY);
                    consumer.apply(&out);
                }
                _ => {
                    for &id in &platform_down {
                        q.push(attachment, Phase::Move, id, step as f32, 0.0, step);
                    }
                }
            }
        }
        q.push(attachment, Phase::CancelAll, -1, 0.0, 0.0, 0);
        q.drain(&mut out);
        consumer.apply(&out);
        assert!(consumer.down.is_empty());
        assert!(q.counters.overflows > 0 && consumer.resets > 0, "the stream exercised overflow: {:?}", q.counters);
    }
}
