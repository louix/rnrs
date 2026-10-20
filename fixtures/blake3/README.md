# BLAKE3 test vectors

`test_vectors.json` is the official file from the BLAKE3 reference repository, tag `1.8.2`:
https://raw.githubusercontent.com/BLAKE3-team/BLAKE3/1.8.2/test_vectors/test_vectors.json
(sha256 `dcb91ea8accc77e6d6e632af7cdc1a99a9f3ae78cf648da595c7d064db32f624`). BLAKE3 is
dual-licensed CC0 1.0 / Apache 2.0.

Each case's input is `input_len` bytes where byte `i` is `i % 251`. `hash`, `keyed_hash`
(key: the 32 ASCII bytes of `key`) and `derive_key` (context: `context_string`) give 131
bytes of extended output; the default digest is the first 32.
