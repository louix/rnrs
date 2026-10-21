// Geometry check for the triangle fixture's screenshots (shared by the Android and iOS runners):
// the orange region must be the triangle the shader draws, not any orange UI. In clip space the
// triangle is (0, 0.6), (-0.6, -0.6), (0.6, -0.6): its bounding box is 60% of the surface's
// width and 60% of its height (in physical pixels, which the screenshots use), the apex is at
// the top centre, each row's width grows linearly from the apex to the base, and it fills half
// of its bounding box. Only the largest connected orange region is measured, so orange-tinted
// UI (text, a status bar icon) elsewhere on screen neither passes nor disturbs the check.

/** Orange hue: strong red, red well above green, little blue (tolerant of a dimmed or
 *  warm-tinted display). */
export const isOrange = (r, g, b) => r >= 120 && r > 1.6 * g && b < 0.3 * r;

/** `image`: {width, height, channels, pixels} (RGB or RGBA rows); `surface`: {width, height}
 *  in physical pixels (the triangle's stats). Returns {ok, ...measurements}. */
export function triangleShape(image, surface) {
  const { width, height, channels, pixels } = image;
  // The orange mask, then its largest 4-connected component.
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const i = p * channels;
    mask[p] = isOrange(pixels[i], pixels[i + 1], pixels[i + 2]) ? 1 : 0;
  }
  const label = new Int32Array(width * height);
  const stack = new Int32Array(width * height);
  let best = 0,
    bestSize = 0,
    next = 0;
  for (let p = 0; p < width * height; p++) {
    if (!mask[p] || label[p]) continue;
    next++;
    let size = 0,
      top = 0;
    stack[top++] = p;
    label[p] = next;
    while (top) {
      const q = stack[--top];
      size++;
      const x = q % width;
      for (const n of [q - width, q + width, x > 0 ? q - 1 : -1, x < width - 1 ? q + 1 : -1])
        if (n >= 0 && n < width * height && mask[n] && !label[n]) {
          label[n] = next;
          stack[top++] = n;
        }
    }
    if (size > bestSize) [best, bestSize] = [next, size];
  }
  const orange = (x, y) => label[y * width + x] === best && best !== 0;
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1,
    count = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (orange(x, y)) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (!count) return { ok: false, count, reason: 'no orange pixels' };
  const bw = maxX - minX + 1,
    bh = maxY - minY + 1;
  const near = (v, want, tol) => Math.abs(v - want) <= tol * want;
  // Row widths at 1/4, 1/2 and 3/4 of the height, relative to the base width.
  const rowWidth = (y) => {
    let n = 0;
    for (let x = minX; x <= maxX; x++) if (orange(x, y)) n++;
    return n;
  };
  const profile = [0.25, 0.5, 0.75].map((t) => ({
    t,
    width: rowWidth(minY + Math.round(t * (bh - 1))) / bw,
  }));
  // The apex row's orange pixels are centred in the box.
  let apexSum = 0,
    apexN = 0;
  for (let x = minX; x <= maxX; x++)
    if (orange(x, minY + 2)) {
      apexSum += x;
      apexN++;
    }
  const apexOffset = apexN ? Math.abs(apexSum / apexN - (minX + maxX) / 2) / bw : 1;
  const fill = count / (bw * bh);
  const checks = {
    boxWidth: near(bw, 0.6 * surface.width, 0.03),
    boxHeight: near(bh, 0.6 * surface.height, 0.03),
    profile: profile.every((p) => Math.abs(p.width - p.t) <= 0.05),
    apexCentred: apexOffset <= 0.02,
    fill: Math.abs(fill - 0.5) <= 0.03,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    box: { x: minX, y: minY, width: bw, height: bh },
    expected: { width: Math.round(0.6 * surface.width), height: Math.round(0.6 * surface.height) },
    profile,
    apexOffset,
    fill,
    count,
  };
}
