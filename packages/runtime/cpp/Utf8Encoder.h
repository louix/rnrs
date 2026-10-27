#pragma once
// UTF-16 (or ASCII) string fragments to UTF-8 with the documented policy: each UTF-16 code
// unit of an unpaired surrogate becomes U+FFFD. Surrogate pairs may straddle fragment
// boundaries (engines deliver ropes in pieces). With `out` null it only counts bytes; with
// `out` set it writes at most `cap` bytes and records `overflow` instead of writing past
// them. The capacity is checked once per fragment against the fragment's worst case; only a
// fragment that might not fit takes the per-write checked loop. The measure pass always takes
// the plain loop; a UTF-16 fragment written into the exact measured size usually does not fit
// its worst case and takes the checked one. No JSI dependency (host-tested in
// native/tests/utf8_encoder_test.cpp).
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace rnrs {
// Internal linkage, as when this lived inside RnrsJsi.cpp's anonymous namespace: include it
// only from .cpp files (each gets its own copy). The refactor that moved it here (d9857c1) made
// non-ASCII conversion ~11% slower on the device as a whole; restoring internal linkage was
// not measured in isolation (results/rnrs-opt/bisect-attribution.md).
namespace {

struct Utf8Encoder {
  uint8_t* out = nullptr;
  size_t cap = 0;          // writable bytes at `out` (only used when `out` is set)
  size_t len = 0;          // bytes produced so far (counted even past `cap`)
  bool overflow = false;   // a write would have exceeded `cap` (nothing was written past it)
  bool pending = false;    // a high surrogate waiting for its low half
  char16_t high = 0;

  void fragment(bool ascii, const void* data, size_t num) {
    if (ascii) {
      flushPending();
      if (!num) return;
      if (out) {
        if (fits(num)) std::memcpy(out + len, data, num);
        else overflow = true;
      }
      len += num;
      return;
    }
    // Worst case: 3 bytes per UTF-16 unit (a pair: 4 for 2 units) plus a resolved pending
    // high surrogate (3).
    size_t worst = num > (SIZE_MAX - 3) / 3 ? SIZE_MAX : num * 3 + 3;
    auto units = static_cast<const char16_t*>(data);
    if (!out || fits(worst)) utf16<false>(units, num);
    else utf16<true>(units, num);
  }
  void finish() { flushPending(); }

 private:
  bool fits(size_t n) const { return !overflow && cap >= len && n <= cap - len; }

  // Bytes are stored directly (no staging array and variable-length memcpy: in the release
  // build that kept `put` out of line, with a stack-protector check and a memcpy call per
  // code unit).
  template <bool Checked>
  void put(uint32_t cp) {
    size_t n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (out) {
      if (!Checked || fits(n)) {
        uint8_t* d = out + len;
        switch (n) {
          case 1: d[0] = static_cast<uint8_t>(cp); break;
          case 2: d[0] = 0xC0 | (cp >> 6); d[1] = 0x80 | (cp & 0x3F); break;
          case 3: d[0] = 0xE0 | (cp >> 12); d[1] = 0x80 | ((cp >> 6) & 0x3F); d[2] = 0x80 | (cp & 0x3F); break;
          default: d[0] = 0xF0 | (cp >> 18); d[1] = 0x80 | ((cp >> 12) & 0x3F); d[2] = 0x80 | ((cp >> 6) & 0x3F); d[3] = 0x80 | (cp & 0x3F); break;
        }
      } else {
        overflow = true;
      }
    }
    len += n;
  }
  void flushPending() {
    if (pending) { put<true>(0xFFFD); pending = false; }
  }
  template <bool Checked>
  void utf16(const char16_t* units, size_t num) {
    for (size_t i = 0; i < num; i++) {
      char16_t u = units[i];
      // ASCII (also ASCII content in UTF-16 storage, e.g. Hermes join results): one byte,
      // stored here rather than through `put`, which the release build may keep out of line
      // (the exact-size write pass usually takes the checked loop). Not after a pending high
      // surrogate, which first becomes U+FFFD below.
      if (u < 0x80 && !pending) {
        if (out) {
          if (!Checked || fits(1)) out[len] = static_cast<uint8_t>(u);
          else overflow = true;
        }
        len++;
        continue;
      }
      if (pending) {
        pending = false;
        if (u >= 0xDC00 && u <= 0xDFFF) {
          put<Checked>(0x10000 + ((static_cast<uint32_t>(high) - 0xD800) << 10) + (u - 0xDC00));
          continue;
        }
        put<Checked>(0xFFFD);
      }
      if (u >= 0xD800 && u <= 0xDBFF) { pending = true; high = u; }
      else if (u >= 0xDC00 && u <= 0xDFFF) put<Checked>(0xFFFD);
      else put<Checked>(u);
    }
  }
};

}  // namespace
}  // namespace rnrs
