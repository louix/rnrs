//! Lab diagnostics: a bounded ring of submit and present events with monotonic timestamps
//! (docs/research/js-contention-plan.md). Off unless the renderer is created with
//! `timingRecords > 0`; disabled, it records and allocates nothing.
//!
//! Records carry a sequence number, so a consumer only computes intervals between consecutive
//! sequence numbers: a gap (records overwritten before a drain) is visible as a jump and in
//! the dropped count, and no interval is ever claimed across it.
use std::collections::VecDeque;
use std::sync::Mutex;

/// Upper bound for `timingRecords` (24 bytes each: 2 MiB).
pub const MAX_RECORDS: usize = 1 << 16;
const RECORD_BYTES: usize = 24;
const HEADER_BYTES: usize = 40;
const MAGIC: u32 = 0x544e_5252; // "RRNT" little-endian
const VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum Kind {
    /// `submit` accepted the frame (JS thread).
    Submit = 1,
    /// The present call for the frame returned (render thread). Not display refresh.
    Present = 2,
    /// The present call returned any error: skipped (timeout, occluded), revoked, surface
    /// lost, device lost or failed. The error kinds are not distinguished here.
    PresentUnsuccessful = 3,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Record {
    t_ns: u64,
    seq: u32,
    kind: Kind,
    frame: u32,
    attachment: u32,
}

struct Ring {
    capacity: usize,
    records: VecDeque<Record>,
    next_seq: u32,
    dropped: u64,
    high_water: usize,
}

/// `CLOCK_MONOTONIC` in ns (on Android the clock of `SystemClock.uptimeMillis` and of input
/// event times).
#[cfg(not(target_arch = "wasm32"))]
pub fn monotonic_ns() -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: valid pointer to a timespec; CLOCK_MONOTONIC is always available.
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    (ts.tv_sec as u64) * 1_000_000_000 + ts.tv_nsec as u64
}

#[derive(Default)]
pub struct EventRing {
    ring: Option<Mutex<Ring>>,
}

impl EventRing {
    /// `capacity` 0 disables recording. Larger than [`MAX_RECORDS`] is an error.
    pub fn new(capacity: usize) -> Result<Self, String> {
        if capacity > MAX_RECORDS {
            return Err(format!("timingRecords must be at most {MAX_RECORDS}"));
        }
        Ok(Self {
            ring: (capacity > 0).then(|| {
                Mutex::new(Ring { capacity, records: VecDeque::with_capacity(capacity), next_seq: 0, dropped: 0, high_water: 0 })
            }),
        })
    }

    pub fn record(&self, kind: Kind, frame: u32, attachment: u32) {
        let Some(ring) = &self.ring else { return };
        let t_ns = monotonic_ns();
        let mut r = ring.lock().unwrap_or_else(|e| e.into_inner());
        let seq = r.next_seq;
        r.next_seq = r.next_seq.wrapping_add(1);
        if r.records.len() == r.capacity {
            r.records.pop_front();
            r.dropped += 1;
        }
        r.records.push_back(Record { t_ns, seq, kind, frame, attachment });
        r.high_water = r.high_water.max(r.records.len());
    }

    /// Removes and returns the recorded events. Layout (little-endian):
    /// header `[magic u32, version u32, count u32, highWater u32, dropped u64, nowNs u64,
    /// capacity u32, pad u32]`, then `count` records `[tNs u64, seq u32, frame u32,
    /// attachment u32, kind u16, pad u16]`. Disabled: an empty buffer.
    pub fn drain(&self) -> Vec<u8> {
        let Some(ring) = &self.ring else { return Vec::new() };
        let (records, high_water, dropped, capacity) = {
            let mut r = ring.lock().unwrap_or_else(|e| e.into_inner());
            let records: Vec<Record> = r.records.drain(..).collect();
            (records, r.high_water, r.dropped, r.capacity)
        };
        let now = monotonic_ns();
        let mut out = Vec::with_capacity(HEADER_BYTES + records.len() * RECORD_BYTES);
        out.extend_from_slice(&MAGIC.to_le_bytes());
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&(records.len() as u32).to_le_bytes());
        out.extend_from_slice(&(high_water as u32).to_le_bytes());
        out.extend_from_slice(&dropped.to_le_bytes());
        out.extend_from_slice(&now.to_le_bytes());
        out.extend_from_slice(&(capacity as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        for rec in records {
            out.extend_from_slice(&rec.t_ns.to_le_bytes());
            out.extend_from_slice(&rec.seq.to_le_bytes());
            out.extend_from_slice(&rec.frame.to_le_bytes());
            out.extend_from_slice(&rec.attachment.to_le_bytes());
            out.extend_from_slice(&(rec.kind as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u32_at(b: &[u8], i: usize) -> u32 {
        u32::from_le_bytes(b[i..i + 4].try_into().unwrap())
    }
    fn u64_at(b: &[u8], i: usize) -> u64 {
        u64::from_le_bytes(b[i..i + 8].try_into().unwrap())
    }

    #[test]
    fn disabled_records_nothing() {
        let t = EventRing::new(0).unwrap();
        t.record(Kind::Submit, 1, 1);
        assert!(t.drain().is_empty());
        assert!(EventRing::new(MAX_RECORDS + 1).is_err());
    }

    #[test]
    fn drains_in_order_with_header_and_counts_overwrites() {
        let t = EventRing::new(4).unwrap();
        for f in 1..=6 {
            t.record(Kind::Submit, f, 7);
        }
        let b = t.drain();
        assert_eq!(u32_at(&b, 0), MAGIC);
        assert_eq!(u32_at(&b, 8), 4, "count");
        assert_eq!(u32_at(&b, 12), 4, "high water");
        assert_eq!(u64_at(&b, 16), 2, "dropped");
        let now = u64_at(&b, 24);
        let seqs: Vec<u32> = (0..4).map(|i| u32_at(&b, HEADER_BYTES + i * RECORD_BYTES + 8)).collect();
        assert_eq!(seqs, [2, 3, 4, 5], "the two oldest were overwritten: the sequence jump shows it");
        let frames: Vec<u32> = (0..4).map(|i| u32_at(&b, HEADER_BYTES + i * RECORD_BYTES + 12)).collect();
        assert_eq!(frames, [3, 4, 5, 6]);
        let times: Vec<u64> = (0..4).map(|i| u64_at(&b, HEADER_BYTES + i * RECORD_BYTES)).collect();
        assert!(times.windows(2).all(|w| w[0] <= w[1]) && times[3] <= now, "monotonic and before the drain's now");
        assert_eq!(u32_at(&t.drain(), 8), 0, "drained records are not returned twice");
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    pub(crate) fn browser_now() -> f64;
}
#[cfg(target_arch = "wasm32")]
pub fn monotonic_ns() -> u64 { (browser_now() * 1_000_000.0) as u64 }
