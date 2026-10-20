// Host tests for the shared JSI string encoder (packages/rnr-runtime/cpp/
// Utf8Encoder.h): fragment splitting (including surrogate pairs straddling fragments and
// ASCII fragments between UTF-16 ones), the U+FFFD policy, and the capacity cap.
#include "Utf8Encoder.h"

#include <cstdio>
#include <cstdlib>
#include <random>
#include <string>
#include <vector>

using rnr::Utf8Encoder;

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

// Measure, then write into exactly the measured size plus guard bytes, as RnrJsi.cpp does.
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

  if (failures) { std::printf("utf8 encoder: %d failure(s)\n", failures); return 1; }
  std::printf("utf8 encoder: ok (fixed cases, all 3-way splits, 2000 random fragmentations, cap)\n");
  return 0;
}
