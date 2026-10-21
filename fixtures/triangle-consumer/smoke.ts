// The triangle consumer's one behaviour besides showing the triangle: a slow background-colour
// cycle (one set_state per second), so a device run can tell redraws on change from continuous
// drawing (the renderer returns Next::Wait).
import type { Triangle } from '@rnrs/labs-webgpu-triangle';

const BACKGROUNDS: [number, number, number][] = [
  [0, 0, 0],
  [0, 0.25, 0.5],
  [0.2, 0.2, 0.2],
];

/** Cycles the background once per second; returns a stop function. */
export function cycleBackground(triangle: Triangle): () => void {
  let i = 0;
  const timer = setInterval(() => {
    i = (i + 1) % BACKGROUNDS.length;
    const [r, g, b] = BACKGROUNDS[i];
    triangle.setBackground(r, g, b);
  }, 1000);
  return () => clearInterval(timer);
}
