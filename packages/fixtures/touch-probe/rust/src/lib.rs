//! Lab fixture: a GPU-free consumer of rnrs-surface touch input (touch-probe.spec.ts).
//!
//! A probe owns one [`Surface`] with touch enabled and no renderer. Nothing drains in the
//! background: [`Probe::drain`] (JS's `drain()`) moves the queued records on the calling
//! thread and applies them to a bounded consumer model that checks the queue contract
//! (docs/surface.md, "Touch input"). The model holds at most [`MAX_POINTERS`] pointers and
//! [`RECENT`] recent records. Teardown of the creating runtime, `close()` and `Drop` close the
//! surface; the probe keeps its model until it is dropped.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};

use rnrs_core::lifecycle::{Retire, TeardownScope};
use rnrs_core::Native;
use rnrs_surface::touch::{ResetReason, TouchEvent, TouchPhase, TouchRecord, MAX_POINTERS};
use rnrs_surface::Surface;

pub mod rnr_interface;
#[cfg(target_arch = "wasm32")]
mod web;
use rnr_interface as spec;

/// Recent records kept for `drain()`'s `recent`.
pub const RECENT: usize = 32;

/// One instance per JS runtime (adapter generation).
pub struct Module {
    scope: Option<TeardownScope>,
}

impl Default for Module {
    fn default() -> Self {
        Self { scope: TeardownScope::current() }
    }
}

impl spec::TouchProbeModule for Module {
    type ProbeImpl = Probe;

    fn create(&self) -> Result<Native<Probe>, String> {
        let surface = Surface::new()?;
        surface.enable_touch();
        #[cfg(target_arch = "wasm32")]
        let web = match web::Hold::new(&surface) {
            Ok(hold) => hold,
            Err(error) => { surface.close(); return Err(error); }
        };
        let core = Arc::new(Core {
            surface,
            #[cfg(target_arch = "wasm32")]
            web,
        });
        if let Some(scope) = &self.scope {
            let retire: Arc<dyn Retire> = core.clone();
            scope.register(Arc::downgrade(&retire));
        }
        Ok(Native::new(Probe { core, model: Mutex::new(Model::default()) }))
    }
}

/// What teardown, `close()` and `Drop` close.
struct Core {
    surface: Surface,
    /// Browser: the never-drawing producer that makes the surface attachable.
    #[cfg(target_arch = "wasm32")]
    web: web::Hold,
}

impl Core {
    fn close(&self) {
        self.surface.close();
        #[cfg(target_arch = "wasm32")]
        self.web.close();
    }
}

impl Retire for Core {
    fn retire(&self) {
        self.close();
    }
}

pub struct Probe {
    core: Arc<Core>,
    model: Mutex<Model>,
}

impl Drop for Probe {
    fn drop(&mut self) {
        self.core.close();
    }
}

impl Probe {
    fn model(&self) -> MutexGuard<'_, Model> {
        self.model.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl spec::Probe for Probe {
    fn surface_key(&self) -> Result<f64, String> {
        Ok(self.core.surface.key() as f64)
    }

    fn drain(&self) -> Result<spec::ProbeStats, String> {
        let mut model = self.model();
        model.drains += 1;
        // A drain moves at most QUEUE_CAPACITY records; nothing refills it while we hold no
        // lock but the platform view, so a few rounds empty it.
        for _ in 0..4 {
            let mut buf = std::mem::take(&mut model.buf);
            self.core.surface.drain_touch(&mut buf);
            let empty = buf.is_empty();
            for record in &buf {
                model.apply(record);
            }
            model.buf = buf;
            if empty {
                break;
            }
        }
        let snap = self.core.surface.snapshot();
        let (counters, producer_down) = self.core.surface.touch_counters();
        let n = |v: u64| v as f64;
        Ok(spec::ProbeStats {
            state: if snap.closed { "closed" } else if snap.attachment != 0 { "attached" } else { "detached" }.into(),
            attachment: n(snap.attachment),
            surface_width: snap.extent.width.into(),
            surface_height: snap.extent.height.into(),
            scale: snap.extent.scale.into(),
            drains: n(model.drains),
            records: n(model.records),
            downs: n(model.downs),
            moves: n(model.moves),
            ups: n(model.ups),
            cancels: n(model.cancels),
            resets_overflow: n(model.resets[0]),
            resets_detached: n(model.resets[1]),
            resets_closed: n(model.resets[2]),
            down: model.down.iter().map(pointer).collect(),
            max_down: model.max_down as f64,
            max_id: n(model.max_id),
            contradictions: n(model.contradictions),
            last_contradiction: model.last_contradiction.clone(),
            recent: model.recent.iter().copied().map(record).collect(),
            accepted: n(counters.accepted),
            coalesced: n(counters.coalesced),
            refused_stale: n(counters.refused_stale),
            refused_capacity: n(counters.refused_capacity),
            dropped: n(counters.dropped),
            overflows: n(counters.overflows),
            producer_down: producer_down as f64,
        })
    }

    fn close(&self) -> Result<(), String> {
        self.core.close();
        Ok(())
    }
}

fn phase_name(phase: TouchPhase) -> &'static str {
    match phase {
        TouchPhase::Down => "down",
        TouchPhase::Move => "move",
        TouchPhase::Up => "up",
        TouchPhase::Cancel => "cancel",
    }
}

fn pointer(e: &TouchEvent) -> spec::ProbePointer {
    spec::ProbePointer {
        id: e.id as f64,
        attachment: e.attachment as f64,
        phase: phase_name(e.phase).into(),
        x_px: e.x_px.into(),
        y_px: e.y_px.into(),
        width: e.extent.width.into(),
        height: e.extent.height.into(),
        scale: e.extent.scale.into(),
        time_ms: e.time_ms as f64,
    }
}

fn record(r: TouchRecord) -> spec::ProbeRecord {
    match r {
        TouchRecord::Event(e) => spec::ProbeRecord {
            kind: phase_name(e.phase).into(),
            reason: String::new(),
            id: e.id as f64,
            attachment: e.attachment as f64,
            x_px: e.x_px.into(),
            y_px: e.y_px.into(),
            width: e.extent.width.into(),
            height: e.extent.height.into(),
            scale: e.extent.scale.into(),
            time_ms: e.time_ms as f64,
        },
        TouchRecord::Reset { attachment, reason } => spec::ProbeRecord {
            kind: "reset".into(),
            reason: match reason {
                ResetReason::Overflow => "overflow",
                ResetReason::Detached => "detached",
                ResetReason::Closed => "closed",
            }
            .into(),
            id: 0.0,
            attachment: attachment as f64,
            x_px: 0.0,
            y_px: 0.0,
            width: 0.0,
            height: 0.0,
            scale: 0.0,
            time_ms: 0.0,
        },
    }
}

/// The consumer model: what a renderer would believe after applying every drained record.
#[derive(Default)]
struct Model {
    buf: Vec<TouchRecord>,
    drains: u64,
    records: u64,
    downs: u64,
    moves: u64,
    ups: u64,
    cancels: u64,
    /// Overflow, detached, closed.
    resets: [u64; 3],
    /// Pointers down, latest event each; at most MAX_POINTERS.
    down: Vec<TouchEvent>,
    max_down: usize,
    max_id: u64,
    last_attachment: u64,
    contradictions: u64,
    last_contradiction: Option<String>,
    recent: VecDeque<TouchRecord>,
}

impl Model {
    fn contradict(&mut self, what: String) {
        self.contradictions += 1;
        self.last_contradiction = Some(what);
    }

    fn apply(&mut self, r: &TouchRecord) {
        self.records += 1;
        if self.recent.len() == RECENT {
            self.recent.pop_front();
        }
        self.recent.push_back(*r);
        let e = match *r {
            TouchRecord::Reset { reason, .. } => {
                self.resets[match reason {
                    ResetReason::Overflow => 0,
                    ResetReason::Detached => 1,
                    ResetReason::Closed => 2,
                }] += 1;
                self.down.clear();
                return;
            }
            TouchRecord::Event(e) => e,
        };
        if e.attachment < self.last_attachment {
            self.contradict(format!("id {}: attachment {} after {}", e.id, e.attachment, self.last_attachment));
        }
        self.last_attachment = self.last_attachment.max(e.attachment);
        let found = self.down.iter().position(|p| p.id == e.id);
        match e.phase {
            TouchPhase::Down => {
                self.downs += 1;
                if e.id <= self.max_id {
                    self.contradict(format!("down for id {} after id {}", e.id, self.max_id));
                }
                self.max_id = self.max_id.max(e.id);
                if let Some(old) = self.down.iter().find(|p| p.attachment != e.attachment) {
                    let what = format!("down id {} in attachment {} while id {} of attachment {} is down", e.id, e.attachment, old.id, old.attachment);
                    self.contradict(what);
                }
                if found.is_some() {
                    return;
                }
                if self.down.len() >= MAX_POINTERS {
                    self.contradict(format!("down id {}: more than {MAX_POINTERS} down", e.id));
                    return;
                }
                self.down.push(e);
                self.max_down = self.max_down.max(self.down.len());
            }
            TouchPhase::Move | TouchPhase::Up | TouchPhase::Cancel => {
                match e.phase {
                    TouchPhase::Move => self.moves += 1,
                    TouchPhase::Up => self.ups += 1,
                    _ => self.cancels += 1,
                }
                let Some(i) = found else {
                    self.contradict(format!("{} for id {} not down", phase_name(e.phase), e.id));
                    return;
                };
                if self.down[i].attachment != e.attachment {
                    let what = format!("{} for id {} of attachment {} in attachment {}", phase_name(e.phase), e.id, self.down[i].attachment, e.attachment);
                    self.contradict(what);
                }
                if e.phase == TouchPhase::Move {
                    self.down[i] = e;
                } else {
                    self.down.remove(i);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
