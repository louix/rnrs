//! The BLAKE3 module through generated glue, against the official test vectors
//! (fixtures/blake3/test_vectors.json, BLAKE3 1.8.2).
use bind_tests::harness::{Harness, Settled};
use bind_tests::modules::rnr_blake3 as blake3_glue;
use bind_tests::V;

const NONE: V = V::Undefined;
const VECTORS: &str = include_str!("../../../fixtures/blake3/test_vectors.json");

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn input(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

/// Minimal reader for the vectors file: (input_len, hash, keyed_hash, derive_key).
fn cases() -> Vec<(usize, String, String, String)> {
    let field = |chunk: &str, name: &str| -> String {
        let at = chunk.find(&format!("\"{name}\"")).unwrap();
        let rest = &chunk[at + name.len() + 2..];
        let start = rest.find(|c: char| c.is_ascii_alphanumeric()).unwrap();
        rest[start..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect()
    };
    VECTORS.split("\"input_len\"").skip(1).map(|chunk| {
        let chunk = format!("\"input_len\"{chunk}");
        (field(&chunk, "input_len").parse().unwrap(), field(&chunk, "hash"), field(&chunk, "keyed_hash"), field(&chunk, "derive_key"))
    }).collect()
}

const KEY: &[u8; 32] = b"whats the Elvish word for friend";
const CONTEXT: &str = "BLAKE3 2019-12-27 16:29:52 test vectors context";

#[test]
fn official_vectors_one_shot_keyed_derive_and_xof() {
    let h = Harness::new(&blake3_glue::MODULE, 8);
    let mut env = h.env();
    let cases = cases();
    assert_eq!(cases.len(), 35);
    for (len, hash, keyed, derive) in cases {
        let data = V::buf(&input(len));
        assert_eq!(hex(&h.call(&mut env, "hash", NONE, vec![data.clone()]).unwrap().bytes()), hash[..64], "hash {len}");
        assert_eq!(h.call(&mut env, "hashHex", NONE, vec![data.clone()]).unwrap().string(), hash[..64]);
        assert_eq!(hex(&h.call(&mut env, "keyedHash", NONE, vec![V::buf(KEY), data.clone()]).unwrap().bytes()), keyed[..64], "keyed {len}");
        assert_eq!(hex(&h.call(&mut env, "deriveKey", NONE, vec![V::str(CONTEXT), data.clone()]).unwrap().bytes()), derive[..64], "derive {len}");
        // Extended output and incremental updates in uneven pieces.
        for (ctor, args, expected) in [("hasher", vec![], &hash), ("keyedHasher", vec![V::buf(KEY)], &keyed), ("derivingHasher", vec![V::str(CONTEXT)], &derive)] {
            let hasher = h.call(&mut env, ctor, NONE, args).unwrap();
            let bytes = input(len);
            for piece in bytes.chunks(1000).flat_map(|c| c.chunks(333)) {
                h.call(&mut env, "Hasher.update", hasher.clone(), vec![V::buf(piece)]).unwrap();
            }
            assert_eq!(hex(&h.call(&mut env, "Hasher.finalizeXof", hasher.clone(), vec![V::Num(131.0)]).unwrap().bytes()), *expected, "{ctor} xof {len}");
            assert_eq!(hex(&h.call(&mut env, "Hasher.finalize", hasher, vec![]).unwrap().bytes()), expected[..64]);
        }
    }
}

#[test]
fn key_and_length_validation() {
    let h = Harness::new(&blake3_glue::MODULE, 8);
    let mut env = h.env();
    for len in [0, 31, 33] {
        assert_eq!(h.call(&mut env, "keyedHash", NONE, vec![V::buf(&vec![0; len]), V::buf(&[])]).unwrap_err(),
            format!("Error: key must be exactly 32 bytes, got {len}"));
        assert_eq!(h.call(&mut env, "keyedHasher", NONE, vec![V::buf(&vec![0; len])]).unwrap_err(),
            format!("Error: key must be exactly 32 bytes, got {len}"));
    }
    let hasher = h.call(&mut env, "hasher", NONE, vec![]).unwrap();
    for bad in [-1.0, 1.5, 1_048_577.0, f64::NAN] {
        assert!(h.call(&mut env, "Hasher.finalizeXof", hasher.clone(), vec![V::Num(bad)]).unwrap_err().starts_with("Error: length must be"));
    }
    assert!(h.call(&mut env, "Hasher.finalizeXof", hasher.clone(), vec![V::Num(0.0)]).unwrap().bytes().is_empty());
    assert!(h.call(&mut env, "hash", NONE, vec![V::arr(vec![])]).unwrap_err().contains("data must be an ArrayBuffer"));
    // reset() returns to the empty-input digest.
    h.call(&mut env, "Hasher.update", hasher.clone(), vec![V::buf(b"abc")]).unwrap();
    h.call(&mut env, "Hasher.reset", hasher.clone(), vec![]).unwrap();
    let empty = h.call(&mut env, "hash", NONE, vec![V::buf(&[])]).unwrap().bytes();
    assert_eq!(h.call(&mut env, "Hasher.finalize", hasher, vec![]).unwrap().bytes(), empty);
}

#[test]
fn async_hashing_retains_the_hasher_and_observes_cancellation() {
    let h = Harness::new(&blake3_glue::MODULE, 8);
    let mut env = h.env();
    let big = input(1 << 20);
    let expected = blake3::hash(&big);
    let id = h.call(&mut env, "hashLater", NONE, vec![V::buf(&big)]).unwrap().num();
    let hasher = h.call(&mut env, "hasher", NONE, vec![]).unwrap();
    h.call(&mut env, "Hasher.updateLater", hasher.clone(), vec![V::buf(&big)]).unwrap();
    bind_tests::dispose(&hasher); // the operation keeps the hasher alive
    let mut settled = h.settle(&mut env, 2);
    settled.sort_by_key(|s| s.0);
    assert_eq!((settled[0].0 as f64, settled[0].2.bytes()), (id, expected.as_bytes().to_vec()));
    assert_eq!(settled[1].1, Settled::Ok(String::new()));
    // Cancellation between chunks.
    let huge = V::buf(&input(16 << 20));
    let id = h.call(&mut env, "hashLater", NONE, vec![huge]).unwrap().num();
    assert!(h.adapter.cancel(id as u64));
    let out = h.settle(&mut env, 1);
    assert_eq!(out[0].1, Settled::Cancelled);
}

#[test]
fn concurrent_update_laters_through_the_glue_commit_whole_updates_only() {
    let h = Harness::new(&blake3_glue::MODULE, 8);
    let mut env = h.env();
    let (a, b) = (input(4 << 20), vec![7u8; 1 << 20]);
    let hasher = h.call(&mut env, "hasher", NONE, vec![]).unwrap();
    h.call(&mut env, "Hasher.update", hasher.clone(), vec![V::buf(b"head")]).unwrap();
    let ia = h.call(&mut env, "Hasher.updateLater", hasher.clone(), vec![V::buf(&a)]).unwrap().num() as u64;
    let ib = h.call(&mut env, "Hasher.updateLater", hasher.clone(), vec![V::buf(&b)]).unwrap().num() as u64;
    let settled = h.settle(&mut env, 2);
    let ok: Vec<u64> = settled.iter().filter(|s| s.1 == Settled::Ok(String::new())).map(|s| s.0).collect();
    assert_eq!(ok.len(), 1, "{settled:?}");
    let failed = settled.iter().find(|s| s.0 != ok[0]).unwrap();
    assert_eq!(failed.1, Settled::Failed(rnr_blake3::BUSY.into()));
    let winner = if ok[0] == ia { &a } else { assert_eq!(ok[0], ib); &b };
    let mut expected = blake3::Hasher::new();
    expected.update(b"head").update(winner);
    assert_eq!(h.call(&mut env, "Hasher.finalize", hasher.clone(), vec![]).unwrap().bytes(), expected.finalize().as_bytes().to_vec());
    // A sync update right after an updateLater is either ordered before it (the operation
    // had not started) or fails busy; both leave whole updates. (Exact interleavings are
    // covered deterministically by the crate's own tests.)
    let big = input(32 << 20);
    h.call(&mut env, "Hasher.updateLater", hasher.clone(), vec![V::buf(&big)]).unwrap();
    let sync = h.call(&mut env, "Hasher.update", hasher.clone(), vec![V::buf(b"x")]);
    assert_eq!(h.settle(&mut env, 1)[0].1, Settled::Ok(String::new()));
    match sync {
        Ok(_) => { expected.update(b"x"); }
        Err(e) => assert_eq!(e, format!("Error: {}", rnr_blake3::BUSY)),
    }
    expected.update(&big);
    assert_eq!(h.call(&mut env, "Hasher.finalize", hasher, vec![]).unwrap().bytes(), expected.finalize().as_bytes().to_vec());
}
