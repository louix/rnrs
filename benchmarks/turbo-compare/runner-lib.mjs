// Shared by the device runners and the summarizer (benchmarks/turbo-compare).
import { randomInt } from 'node:crypto';

export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Reassembles `RNRSCMP2 <runId> <i>/<n> <length>:<fnv1a> <chunk>|` lines (any prefix) into
 *  reports and verifies the whole report's length and hash. A mismatch (a transport that altered
 *  the text) yields an error record, never a silently repaired report. */
export function collector(runId) {
  const parts = new Map();
  return {
    /** Returns a completed report (or a transport error record), or null. */
    line(text) {
      const m = text.match(/RNRSCMP2 (\S+) (\d+)\/(\d+) (\d+):([0-9a-f]{8}) (.*)\|$/);
      if (!m || m[1] !== runId) return null;
      const [, , i, n, length, hash, chunk] = m;
      // A report starts again at chunk 1; earlier partial chunks (another report) are dropped.
      if (i === '1') parts.clear();
      parts.set(Number(i), chunk);
      if (parts.size !== Number(n)) return null;
      const whole = Array.from({ length: Number(n) }, (_, k) => parts.get(k + 1)).join('');
      parts.clear();
      if (whole.length !== Number(length) || fnv1a(whole) !== hash)
        return {
          type: 'error',
          runId,
          message: `transport integrity: got ${whole.length}:${fnv1a(whole)}, sent ${length}:${hash}`,
        };
      return JSON.parse(whole);
    },
  };
}

/** Independent 31-bit seeds from the OS CSPRNG. */
export const newSeed = () => randomInt(1, 2 ** 31);

export function quantile(sorted, q) {
  // Nearest rank.
  if (!sorted.length) return NaN;
  const k = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[k];
}

export function describe(values) {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    n: s.length,
    median: median(s),
    p10: quantile(s, 0.1),
    p90: quantile(s, 0.9),
    min: s[0],
    max: s.at(-1),
  };
}

export function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
