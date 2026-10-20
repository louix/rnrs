//! Implementation of the BLAKE3 spec (../blake3.spec.ts) over the `blake3` crate. Plain
//! Rust: no JS, JSI or platform code.
use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, MutexGuard};
use std::task::{Context, Poll};

use rnr_core::{CancelToken, Native};

pub mod rnr_interface;
use rnr_interface as spec;

const CHUNK: usize = 64 * 1024;
const MAX_XOF: f64 = 1_048_576.0;

#[derive(Default)]
pub struct Blake3;

/// Incremental state with a busy gate. While an `updateLater` runs, every other operation on
/// the same hasher (sync or async) fails with [`BUSY`] instead of interleaving with it. The
/// async update hashes into a private copy of the state and replaces the committed state in
/// one step only after all its input is hashed, so the committed state always reflects whole
/// updates, never a prefix.
pub struct Hasher(Mutex<State>);

struct State {
    hasher: blake3::Hasher,
    busy: bool,
}

pub const BUSY: &str = "hasher is busy: an updateLater on it has not finished";

impl Hasher {
    fn new(inner: blake3::Hasher) -> Native<Hasher> {
        Native::new(Hasher(Mutex::new(State { hasher: inner, busy: false })))
    }
    fn lock(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// The committed state, unless an `updateLater` holds the hasher.
    fn idle(&self) -> Result<MutexGuard<'_, State>, String> {
        let state = self.lock();
        if state.busy {
            return Err(BUSY.into());
        }
        Ok(state)
    }
}

/// Holds the busy flag for one `updateLater`; clears it however the update ends (success,
/// error, cancellation, or the future being dropped).
struct BusyGuard<'a>(&'a Hasher);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.lock().busy = false;
    }
}

fn key(bytes: &[u8]) -> Result<[u8; 32], String> {
    bytes.try_into().map_err(|_| format!("key must be exactly 32 bytes, got {}", bytes.len()))
}

/// Yields once to the executor, so long hashes let other tasks (and cancellation) run.
struct YieldNow(bool);

impl Future for YieldNow {
    type Output = ();
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.0 {
            return Poll::Ready(());
        }
        self.0 = true;
        cx.waker().wake_by_ref();
        Poll::Pending
    }
}

/// Feeds `data` in chunks into a hasher owned by this operation, checking `cancel` between
/// them.
async fn update_chunked(hasher: &mut blake3::Hasher, data: &[u8], cancel: &CancelToken) -> Result<(), String> {
    for chunk in data.chunks(CHUNK) {
        if cancel.is_cancelled() {
            return Err("cancelled".into());
        }
        hasher.update(chunk);
        YieldNow(false).await;
    }
    Ok(())
}

impl spec::Hasher for Hasher {
    fn update(&self, data: Vec<u8>) -> Result<(), String> {
        self.idle()?.hasher.update(&data);
        Ok(())
    }

    /// Takes the busy gate when the operation starts running, hashes into a copy of the
    /// committed state, and commits the copy only if all of `data` was hashed. An error or
    /// cancellation observed before the commit leaves the committed state unchanged.
    /// Cancellation that arrives after the commit (the promise may still reject with
    /// AbortError) does not roll the update back.
    async fn update_later(&self, data: Vec<u8>, cancel: CancelToken) -> Result<(), String> {
        let (mut staged, _busy) = {
            let mut state = self.idle()?;
            state.busy = true;
            (state.hasher.clone(), BusyGuard(self))
        };
        update_chunked(&mut staged, &data, &cancel).await?;
        let mut state = self.lock();
        if cancel.is_cancelled() {
            return Err("cancelled".into());
        }
        state.hasher = staged;
        Ok(())
    }

    fn finalize(&self) -> Result<Vec<u8>, String> {
        Ok(self.idle()?.hasher.finalize().as_bytes().to_vec())
    }

    fn finalize_xof(&self, length: f64) -> Result<Vec<u8>, String> {
        if !(0.0..=MAX_XOF).contains(&length) || length.fract() != 0.0 {
            return Err(format!("length must be an integer from 0 to {MAX_XOF}"));
        }
        let mut out = vec![0u8; length as usize];
        self.idle()?.hasher.finalize_xof().fill(&mut out);
        Ok(out)
    }

    fn reset(&self) -> Result<(), String> {
        self.idle()?.hasher.reset();
        Ok(())
    }
}

impl spec::Blake3Module for Blake3 {
    type HasherImpl = Hasher;

    fn hash(&self, data: Vec<u8>) -> Result<Vec<u8>, String> {
        Ok(blake3::hash(&data).as_bytes().to_vec())
    }

    fn hash_hex(&self, data: Vec<u8>) -> Result<String, String> {
        Ok(blake3::hash(&data).to_hex().to_string())
    }

    fn keyed_hash(&self, key_bytes: Vec<u8>, data: Vec<u8>) -> Result<Vec<u8>, String> {
        Ok(blake3::keyed_hash(&key(&key_bytes)?, &data).as_bytes().to_vec())
    }

    fn derive_key(&self, context: String, material: Vec<u8>) -> Result<Vec<u8>, String> {
        Ok(blake3::derive_key(&context, &material).to_vec())
    }

    fn hasher(&self) -> Result<Native<Hasher>, String> {
        Ok(Hasher::new(blake3::Hasher::new()))
    }

    fn keyed_hasher(&self, key_bytes: Vec<u8>) -> Result<Native<Hasher>, String> {
        Ok(Hasher::new(blake3::Hasher::new_keyed(&key(&key_bytes)?)))
    }

    fn deriving_hasher(&self, context: String) -> Result<Native<Hasher>, String> {
        Ok(Hasher::new(blake3::Hasher::new_derive_key(&context)))
    }

    async fn hash_later(&self, data: Vec<u8>, cancel: CancelToken) -> Result<Vec<u8>, String> {
        let mut hasher = blake3::Hasher::new();
        update_chunked(&mut hasher, &data, &cancel).await?;
        Ok(hasher.finalize().as_bytes().to_vec())
    }
}

#[cfg(test)]
mod tests {
    //! Deterministic interleavings: futures are polled by hand, one step (one 64 KiB chunk)
    //! at a time, with no executor.
    use super::*;
    use spec::Hasher as _;
    use std::task::Waker;

    fn poll<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
        future.poll(&mut Context::from_waker(Waker::noop()))
    }

    fn digest_of(parts: &[&[u8]]) -> Vec<u8> {
        let mut h = blake3::Hasher::new();
        parts.iter().for_each(|p| { h.update(p); });
        h.finalize().as_bytes().to_vec()
    }

    fn data(len: usize, seed: u8) -> Vec<u8> {
        (0..len).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
    }

    #[test]
    fn conflicting_operations_are_busy_while_an_update_later_runs() {
        let h = Hasher::new(blake3::Hasher::new());
        h.update(b"head".to_vec()).unwrap();
        let big = data(5 * CHUNK, 1);
        let mut first = Box::pin(h.update_later(big.clone(), CancelToken::new()));
        assert!(poll(first.as_mut()).is_pending()); // gate taken, first chunk hashed
        // Every conflicting operation fails, including a second updateLater.
        assert_eq!(h.update(b"x".to_vec()), Err(BUSY.into()));
        assert_eq!(h.finalize(), Err(BUSY.into()));
        assert_eq!(h.finalize_xof(8.0), Err(BUSY.into()));
        assert_eq!(h.reset(), Err(BUSY.into()));
        let mut second = Box::pin(h.update_later(data(CHUNK, 2), CancelToken::new()));
        assert_eq!(poll(second.as_mut()), Poll::Ready(Err(BUSY.into())));
        while poll(first.as_mut()).is_pending() {
            assert_eq!(h.update(b"x".to_vec()), Err(BUSY.into()));
        }
        drop(first);
        // The committed state is exactly head + big; the gate is free again.
        assert_eq!(h.finalize().unwrap(), digest_of(&[b"head", &big]));
        h.update(b"tail".to_vec()).unwrap();
        assert_eq!(h.finalize().unwrap(), digest_of(&[b"head", &big, b"tail"]));
    }

    #[test]
    fn cancellation_or_drop_before_commit_leaves_the_state_unchanged() {
        let h = Hasher::new(blake3::Hasher::new());
        h.update(b"committed".to_vec()).unwrap();
        let before = h.finalize().unwrap();
        // Cancelled after two chunks: no prefix is committed, and the gate is released.
        let cancel = CancelToken::new();
        let mut op = Box::pin(h.update_later(data(4 * CHUNK, 3), cancel.clone()));
        assert!(poll(op.as_mut()).is_pending());
        assert!(poll(op.as_mut()).is_pending());
        cancel.cancel();
        assert_eq!(poll(op.as_mut()), Poll::Ready(Err("cancelled".into())));
        drop(op);
        assert_eq!(h.finalize().unwrap(), before);
        // Dropped mid-way (for example by executor shutdown): same.
        let mut op = Box::pin(h.update_later(data(4 * CHUNK, 4), CancelToken::new()));
        assert!(poll(op.as_mut()).is_pending());
        drop(op);
        assert_eq!(h.finalize().unwrap(), before);
        // Cancelled after the last chunk but before the commit step: not committed.
        let cancel = CancelToken::new();
        let mut op = Box::pin(h.update_later(data(CHUNK, 5), cancel.clone()));
        assert!(poll(op.as_mut()).is_pending()); // the only chunk is hashed
        cancel.cancel();
        assert_eq!(poll(op.as_mut()), Poll::Ready(Err("cancelled".into())));
        drop(op);
        assert_eq!(h.finalize().unwrap(), before);
    }

    #[test]
    fn successive_update_laters_and_empty_input_commit_whole_updates() {
        let h = Hasher::new(blake3::Hasher::new_keyed(&[7; 32]));
        let (a, b) = (data(3 * CHUNK + 5, 6), data(CHUNK - 1, 7));
        for part in [&a, &Vec::new(), &b] {
            let mut op = Box::pin(h.update_later(part.clone(), CancelToken::new()));
            let out = loop {
                if let Poll::Ready(out) = poll(op.as_mut()) { break out; }
            };
            assert_eq!(out, Ok(()));
        }
        let mut expected = blake3::Hasher::new_keyed(&[7; 32]);
        expected.update(&a).update(&b);
        assert_eq!(h.finalize().unwrap(), expected.finalize().as_bytes().to_vec());
    }
}
