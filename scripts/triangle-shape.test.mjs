// The device runners' triangle geometry check (scripts/consumer/triangle-shape.mjs) on synthetic
// screenshots: the shader's triangle passes, orange UI does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triangleShape } from './consumer/triangle-shape.mjs';

const ORANGE = [158, 80, 0],
  BACKGROUND = [96, 65, 31];

/** A screen with the surface at (ox, oy), drawing the triangle at clip-space scale `k` (0.6 in
 *  the fixture), plus `extra` rectangles [x, y, w, h, colour]. */
function screen({
  width = 400,
  height = 800,
  surface = { x: 0, y: 40, width: 400, height: 700 },
  k = 0.6,
  extra = [],
}) {
  const pixels = new Uint8Array(width * height * 3);
  const set = (x, y, c) => pixels.set(c, (y * width + x) * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, BACKGROUND);
  for (let y = 0; y < surface.height; y++)
    for (let x = 0; x < surface.width; x++) {
      // Pixel centre in clip space (y up).
      const cx = ((x + 0.5) / surface.width) * 2 - 1,
        cy = 1 - ((y + 0.5) / surface.height) * 2;
      const inside = cy <= k && cy >= -k && Math.abs(cx) <= (k - cy) / 2;
      if (k > 0 && inside) set(surface.x + x, surface.y + y, ORANGE);
    }
  for (const [x0, y0, w, h, c] of extra)
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, c);
  return {
    image: { width, height, channels: 3, pixels },
    surface: { width: surface.width, height: surface.height },
  };
}

test("the shader's triangle passes, with orange-tinted text elsewhere on screen", () => {
  const specks = [...Array(12)].map((_, i) => [10 + i * 8, 760, 4, 12, ORANGE]); // label glyphs
  const { image, surface } = screen({ extra: specks });
  const r = triangleShape(image, surface);
  assert.ok(r.ok, JSON.stringify(r.checks));
  assert.ok(
    Math.abs(r.box.width - 240) <= 3 && Math.abs(r.box.height - 420) <= 3,
    JSON.stringify(r.box),
  );
});

test('orange UI does not pass: a rectangle, a wrong-size triangle, or a larger orange panel', () => {
  const rect = screen({ k: 0, extra: [[80, 200, 240, 420, ORANGE]] });
  assert.equal(triangleShape(rect.image, rect.surface).ok, false, 'a rectangle the triangle size');
  const small = screen({ k: 0.3 });
  assert.equal(triangleShape(small.image, small.surface).ok, false, 'a triangle of another size');
  const panel = screen({ extra: [[0, 650, 400, 150, ORANGE]] }); // 60k pixels, the triangle ~50k
  const r = triangleShape(panel.image, panel.surface);
  assert.equal(r.ok, false, 'the largest orange region is a panel, not the triangle');
  const none = screen({ k: 0 });
  assert.equal(triangleShape(none.image, none.surface).ok, false);
});
