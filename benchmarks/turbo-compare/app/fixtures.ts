// Fixture inputs, generated identically in JS (here), C++ (cxx-module/cpp/RnrsCmpCxx.cpp) and
// Rust (rnrs-module/rust/src/lib.rs).
import type { Fixtures, Nested, Point8 } from './types';

export const SIZES = [16, 1024, 65536];
const UNICODE = ['a', 'é', '中', '\u{1f600}'];

export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3; // lone high surrogate -> U+FFFD
    } else n += 3; // BMP, or a lone surrogate -> U+FFFD
  }
  return n;
}

/** 'a' + (i % 26) for `bytes` bytes. */
export function asciiString(bytes: number): string {
  let s = '';
  for (let i = 0; i < bytes; i++) s += String.fromCharCode(97 + (i % 26));
  return s;
}

/** Cycles a, é, 中, 😀 while the next one fits, then pads with 'z' to exactly `bytes` UTF-8 bytes. */
export function unicodeString(bytes: number): string {
  let s = '';
  let n = 0;
  for (let k = 0; n + utf8Length(UNICODE[k % 4]) <= bytes; k++) {
    s += UNICODE[k % 4];
    n += utf8Length(UNICODE[k % 4]);
  }
  while (n < bytes) {
    s += 'z';
    n++;
  }
  return s;
}

export function point(x: number): Point8 {
  return { a: x, b: x + 1, c: x + 2, d: x + 3, e: x + 4, f: x + 5, g: x + 6, h: x + 7 };
}
export const pointTotal = (p: Point8) => p.a + p.b + p.c + p.d + p.e + p.f + p.g + p.h;

export function nested(x: number): Nested {
  return {
    id: x,
    visible: true,
    frame: { origin: { x: x + 1, y: x + 2 }, size: { x: x + 3, y: x + 4 } },
    tint: { r: x + 5, g: x + 6, b: x + 7, a: x + 8 },
  };
}
export const nestedTotal = (v: Nested) =>
  v.id +
  (v.visible ? 1 : 0) +
  v.frame.origin.x +
  v.frame.origin.y +
  v.frame.size.x +
  v.frame.size.y +
  v.tint.r +
  v.tint.g +
  v.tint.b +
  v.tint.a;

export function makeFixtures(): Fixtures {
  const strings = [...SIZES.map(asciiString), ...SIZES.map(unicodeString)];
  const arrays: Record<number, number[]> = {};
  const arrayTotals: Record<number, number> = {};
  for (const len of [16, 256, 1024]) {
    arrays[len] = Array.from({ length: len }, (_, i) => i % 100);
    arrayTotals[len] = arrays[len].reduce((a, b) => a + b, 0);
  }
  const points64 = Array.from({ length: 64 }, (_, k) => point(k));
  return {
    strings,
    stringBytes: strings.map(utf8Length),
    point: point(1),
    pointTotal: pointTotal(point(1)),
    nested: nested(1),
    nestedTotal: nestedTotal(nested(1)),
    arrays,
    arrayTotals,
    points64,
    points64Total: points64.reduce((a, p) => a + pointTotal(p), 0),
  };
}
