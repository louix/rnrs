// Host tests for the shared JSI string encoder (packages/runtime/cpp/
// Utf8Encoder.h): fragment splitting (including surrogate pairs straddling fragments and
// ASCII fragments between UTF-16 ones), the U+FFFD policy, and the capacity cap.
#include "Utf8Encoder.h"

#include <cstdio>
#include <cstdlib>
#include <random>
#include <string>
#include <vector>

using rnrs::Utf8Encoder;

static int failures = 0;
#define CHECK(cond, ...) do { if (!(cond)) { std::printf("FAIL %s:%d: ", __FILE__, __LINE__); std::printf(__VA_ARGS__); std::printf("\n"); failures++; } } while (0)

// Independent reference: whole string at once, written without the encoder.
static std::string reference(const std::u16string& s) {
  std::string out;
  auto put = [&](uint32_t cp) {
    if (cp < 0x80) out += char(cp);
    else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
    else { out += char(0xF0 | (cp >> 18)); out += char(0x80 | ((cp >> 12) & 0x3F)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
  };
  for (size_t i = 0; i < s.size(); i++) {
    char16_t u = s[i];
    if (u >= 0xD800 && u <= 0xDBFF && i + 1 < s.size() && s[i + 1] >= 0xDC00 && s[i + 1] <= 0xDFFF) {
      put(0x10000 + ((uint32_t(u) - 0xD800) << 10) + (s[i + 1] - 0xDC00));
      i++;
    } else if (u >= 0xD800 && u <= 0xDFFF) {
      put(0xFFFD);
    } else {
      put(u);
    }
  }
  return out;
}

struct Fragment { bool ascii; std::u16string units; };

// Measure, then write into exactly the measured size plus guard bytes, as RnrsJsi.cpp does.
static std::string encode(const std::vector<Fragment>& fragments, size_t* measuredOut = nullptr) {
  auto feed = [&](Utf8Encoder& e) {
    for (auto& f : fragments) {
      if (f.ascii) {
        std::string bytes(f.units.begin(), f.units.end());
        e.fragment(true, bytes.data(), bytes.size());
      } else {
        e.fragment(false, f.units.data(), f.units.size());
      }
    }
    e.finish();
  };
  Utf8Encoder measure;
  feed(measure);
  std::vector<uint8_t> buf(measure.len + 8, 0xAA);
  Utf8Encoder write;
  write.out = buf.data();
  write.cap = measure.len;
  feed(write);
  CHECK(!write.overflow && write.len == measure.len, "second pass differs from the first");
  for (size_t i = 0; i < 8; i++) CHECK(buf[measure.len + i] == 0xAA, "guard byte %zu overwritten", i);
  if (measuredOut) *measuredOut = measure.len;
  return std::string(buf.begin(), buf.begin() + measure.len);
}

static bool allAscii(const std::u16string& s) {
  for (char16_t u : s) if (u >= 0x80) return false;
  return true;
}

// Every way of cutting `s` into two or three fragments (ASCII-typed when possible).
static void splits(const std::u16string& s, const char* label) {
  std::string expected = reference(s);
  CHECK(encode({{false, s}}) == expected, "%s: single fragment", label);
  for (size_t a = 0; a <= s.size(); a++) {
    for (size_t b = a; b <= s.size(); b++) {
      std::vector<Fragment> f;
      for (auto piece : {s.substr(0, a), s.substr(a, b - a), s.substr(b)}) f.push_back({allAscii(piece) && !piece.empty(), piece});
      CHECK(encode(f) == expected, "%s: split at %zu/%zu", label, a, b);
    }
  }
}

int main() {
  const char16_t hi = 0xD83E, lo = 0xDD80;  // U+1F980
  splits(u"", "empty");
  splits(u"plain ascii", "ascii");
  splits(u"é漢字", "bmp");
  splits(std::u16string{u'a', hi, lo, u'b'}, "pair");
  splits(std::u16string{hi, lo, hi, lo}, "two pairs");
  splits(std::u16string{hi}, "lone high");
  splits(std::u16string{lo}, "lone low");
  splits(std::u16string{hi, hi, lo}, "high high low");
  splits(std::u16string{lo, hi}, "reversed");
  splits(std::u16string{u'x', hi, u'y', lo, u'z'}, "interrupted");
  splits(std::u16string{hi, u'\0', lo}, "nul inside");
  splits(std::u16string{0x7F, 0x80, 0x7FF, 0x800, 0xFFFF, 0xDBFF, 0xDFFF}, "boundaries");

  // A high surrogate at the end of a UTF-16 fragment followed by an ASCII fragment, and a
  // pair split exactly between two UTF-16 fragments.
  CHECK(encode({{false, std::u16string{u'a', hi}}, {true, u"bc"}}) == reference(std::u16string{u'a', hi, u'b', u'c'}), "high then ascii");
  CHECK(encode({{false, std::u16string{hi}}, {false, std::u16string{lo}}}) == reference(std::u16string{hi, lo}), "pair across fragments");

  // Randomized fragmentations of longer mixed strings.
  std::mt19937 rng(12345);
  const char16_t alphabet[] = {u'a', u'Z', 0x00E9, 0x6F22, hi, lo, 0xDBFF, 0xDC00, u'\0', 0xFFFD};
  for (int round = 0; round < 2000; round++) {
    std::u16string s;
    size_t n = rng() % 64;
    for (size_t i = 0; i < n; i++) s += alphabet[rng() % (sizeof alphabet / sizeof alphabet[0])];
    std::vector<Fragment> f;
    for (size_t i = 0; i < s.size();) {
      size_t take = 1 + rng() % 7;
      auto piece = s.substr(i, take);
      f.push_back({allAscii(piece) && (rng() & 1), piece});
      i += take;
    }
    CHECK(encode(f) == reference(s), "random round %d", round);
  }

  // The cap: a destination smaller than the output is never written past; overflow is set.
  {
    std::u16string s = u"abc漢字";
    Utf8Encoder measure;
    measure.fragment(false, s.data(), s.size());
    measure.finish();
    std::vector<uint8_t> buf(measure.len + 8, 0xAA);
    Utf8Encoder write;
    write.out = buf.data();
    write.cap = measure.len - 2;
    write.fragment(false, s.data(), s.size());
    write.finish();
    CHECK(write.overflow, "overflow not reported");
    for (size_t i = measure.len - 2; i < buf.size(); i++) CHECK(buf[i] == 0xAA, "byte %zu past the cap was written", i);
  }

  // The cap across fragments: early fragments fit (unchecked fast path), a later one does
  // not; nothing past the cap is written and overflow is reported.
  for (size_t cap = 0; cap < 40; cap++) {
    std::u16string a = u"ab", b = u"漢字漢字", c = std::u16string{0xD83E, 0xDD80};
    std::vector<uint8_t> buf(64, 0xAA);
    Utf8Encoder write;
    write.out = buf.data();
    write.cap = cap;
    write.fragment(true, "ab", 2);
    write.fragment(false, b.data(), b.size());
    write.fragment(false, c.data(), 1);
    write.fragment(false, c.data() + 1, 1);
    write.finish();
    std::string expected = reference(a + b + c);
    CHECK(write.len == expected.size(), "len %zu", write.len);
    CHECK(write.overflow == (cap < expected.size()), "overflow flag at cap %zu", cap);
    for (size_t i = cap; i < buf.size(); i++) CHECK(buf[i] == 0xAA, "cap %zu: byte %zu written", cap, i);
    if (cap >= expected.size()) CHECK(std::string(buf.begin(), buf.begin() + expected.size()) == expected, "cap %zu: content", cap);
  }

  // ASCII content in UTF-16 fragments (Hermes stores e.g. join results this way): the inline
  // one-byte path, in the measure pass and in the exact-size (checked) write pass.
  for (size_t n : {size_t(1), size_t(7), size_t(16), size_t(1023), size_t(1024), size_t(1025), size_t(70001)}) {
    std::u16string s;
    for (size_t i = 0; i < n; i++) s += char16_t(i % 128);  // includes U+0000 and U+007F
    size_t measured = 0;
    CHECK(encode({{false, s}}, &measured) == reference(s) && measured == n, "utf16 ascii %zu", n);
    CHECK(encode({{false, s.substr(0, n / 2)}, {false, s.substr(n / 2)}}) == reference(s), "utf16 ascii %zu split", n);
  }
  // A pending high surrogate is not skipped by the ASCII path: within a fragment, across
  // UTF-16 fragments, at a fragment's end followed by ASCII, and before U+0000 / U+007F.
  for (auto s : {std::u16string{hi, u'a'}, std::u16string{u'a', hi, u'b', u'c', hi}, std::u16string{hi, 0x00, hi, 0x7F, hi, 0x80}}) {
    CHECK(encode({{false, s}}) == reference(s), "pending then ascii");
    splits(s, "pending then ascii");
  }
  CHECK(encode({{false, std::u16string{u'a', hi}}, {false, u"bc"}}) == reference(std::u16string{u'a', hi, u'b', u'c'}), "high then utf16 ascii");
  CHECK(encode({{false, std::u16string{u'a', hi}}, {false, u"bc"}, {false, std::u16string{lo}}}) == reference(std::u16string{u'a', hi, u'b', u'c', lo}), "high, ascii, low");

  // Mostly-ASCII strings with long runs, randomly fragmented (both fragment kinds).
  {
    const char16_t mixed[] = {u'a', u'b', u'c', u'd', u'e', u'f', u'\0', 0x7F, 0x80, 0x6F22, hi, lo, 0xDC00};
    for (int round = 0; round < 500; round++) {
      std::u16string s;
      size_t n = rng() % 600;
      for (size_t i = 0; i < n; i++) s += (rng() % 8) ? char16_t(u'a' + rng() % 26) : mixed[rng() % (sizeof mixed / sizeof mixed[0])];
      std::vector<Fragment> f;
      for (size_t i = 0; i < s.size();) {
        size_t take = 1 + rng() % 200;
        auto piece = s.substr(i, take);
        f.push_back({allAscii(piece) && (rng() & 1), piece});
        i += take;
      }
      CHECK(encode(f) == reference(s), "ascii-heavy round %d", round);
    }
  }

  // The cap on the inline ASCII path: an ASCII UTF-16 fragment longer than the capacity (as
  // when the string grew between the passes) writes exactly the bytes that fit, never past
  // them, and reports overflow; a following fragment writes nothing.
  for (size_t cap = 0; cap < 24; cap++) {
    std::u16string s = u"abcdefghijklmnopqrst", t = u"uv";
    std::vector<uint8_t> buf(64, 0xAA);
    Utf8Encoder write;
    write.out = buf.data();
    write.cap = cap;
    write.fragment(false, s.data(), s.size());
    write.fragment(false, t.data(), t.size());
    write.finish();
    CHECK(write.len == 22, "ascii cap %zu: len %zu", cap, write.len);
    CHECK(write.overflow == (cap < 22), "ascii cap %zu: overflow flag", cap);
    size_t kept = cap < 22 ? cap : 22;
    CHECK(std::string(buf.begin(), buf.begin() + kept) == std::string("abcdefghijklmnopqrstuv").substr(0, kept), "ascii cap %zu: content", cap);
    for (size_t i = kept; i < buf.size(); i++) CHECK(buf[i] == 0xAA, "ascii cap %zu: byte %zu written", cap, i);
  }

  // The string grew between the passes (measured as `before`, written as `after`): the write
  // pass stays within the measured size and reports overflow, whether the growth is ASCII or a
  // trailing high surrogate whose U+FFFD (3 bytes) no longer fits.
  for (auto [before, after] : {std::pair{std::u16string(u"abc"), std::u16string(u"abcd")},
                               std::pair{std::u16string(1000, u'x'), std::u16string(1001, u'x')},
                               std::pair{std::u16string(u"ab"), std::u16string{u'a', u'b', hi}},
                               std::pair{std::u16string{hi, u'a'}, std::u16string{hi, u'a', u'b'}}}) {
    Utf8Encoder measure;
    measure.fragment(false, before.data(), before.size());
    measure.finish();
    std::vector<uint8_t> buf(measure.len + 8, 0xAA);
    Utf8Encoder write;
    write.out = buf.data();
    write.cap = measure.len;
    write.fragment(false, after.data(), after.size());
    write.finish();
    CHECK(write.overflow && write.len == reference(after).size(), "grown %zu -> %zu: overflow/len", before.size(), after.size());
    CHECK(std::string(buf.begin(), buf.begin() + measure.len) == reference(before), "grown %zu -> %zu: prefix", before.size(), after.size());
    for (size_t i = measure.len; i < buf.size(); i++) CHECK(buf[i] == 0xAA, "grown %zu -> %zu: byte %zu written", before.size(), after.size(), i);
  }

  // The unchecked loop writing UTF-16 ASCII: a capacity with room for the fragment's worst
  // case (3n + 3), as an early fragment of a rope can have in the exact-size write pass.
  for (size_t n : {size_t(1), size_t(16), size_t(1024)}) {
    std::u16string s;
    for (size_t i = 0; i < n; i++) s += char16_t(u'a' + i % 26);
    std::vector<uint8_t> buf(3 * n + 3 + 8, 0xAA);
    Utf8Encoder write;
    write.out = buf.data();
    write.cap = 3 * n + 3;
    write.fragment(false, s.data(), s.size());
    write.finish();
    CHECK(!write.overflow && write.len == n, "unchecked utf16 ascii %zu: len", n);
    CHECK(std::string(buf.begin(), buf.begin() + n) == reference(s), "unchecked utf16 ascii %zu: content", n);
    for (size_t i = n; i < buf.size(); i++) CHECK(buf[i] == 0xAA, "unchecked utf16 ascii %zu: byte %zu written", n, i);
  }
  // An empty UTF-16 fragment between a high surrogate and what follows keeps it pending.
  CHECK(encode({{false, std::u16string{hi}}, {false, u""}, {false, std::u16string{lo}}}) == reference(std::u16string{hi, lo}), "pair around an empty fragment");
  CHECK(encode({{false, std::u16string{hi}}, {false, u""}, {true, u"a"}}) == reference(std::u16string{hi, u'a'}), "high, empty, ascii");

  // Each encoded width on the checked path, after one byte already written: caps from none
  // left to an exact fit. A code point is written whole or not at all; overflow is sticky (a
  // later ASCII unit that would fit the remaining space is not written either); every byte is
  // still counted. The last case is a lone high surrogate's U+FFFD before the ASCII unit (a
  // trailing one, flushed by finish(), is covered by the growth test above).
  for (auto unit : {std::u16string{0x00E9}, std::u16string{0x6F22}, std::u16string{hi, lo}, std::u16string{hi}}) {
    std::u16string s = u"a" + unit + u"b";
    std::string expected = reference(s);
    size_t width = expected.size() - 2;
    for (size_t cap = 0; cap <= expected.size(); cap++) {
      std::vector<uint8_t> buf(16, 0xAA);
      Utf8Encoder write;
      write.out = buf.data();
      write.cap = cap;
      write.fragment(false, s.data(), s.size());
      write.finish();
      size_t kept = cap == 0 ? 0 : cap < 1 + width ? 1 : cap < expected.size() ? 1 + width : expected.size();
      CHECK(write.len == expected.size(), "width %zu cap %zu: len %zu", width, cap, write.len);
      CHECK(write.overflow == (cap < expected.size()), "width %zu cap %zu: overflow", width, cap);
      CHECK(std::string(buf.begin(), buf.begin() + kept) == expected.substr(0, kept), "width %zu cap %zu: content", width, cap);
      for (size_t i = kept; i < buf.size(); i++) CHECK(buf[i] == 0xAA, "width %zu cap %zu: byte %zu written", width, cap, i);
    }
  }

  if (failures) { std::printf("utf8 encoder: %d failure(s)\n", failures); return 1; }
  std::printf("utf8 encoder: ok (fixed cases, all 3-way splits, 2000 random fragmentations, UTF-16 ASCII, 500 ASCII-heavy fragmentations, cap)\n");
  return 0;
}
