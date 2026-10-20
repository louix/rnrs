// Frame writer for @rnrs/example-vello2d: encodes one frame of drawing commands into a reused
// buffer, submitted with one `renderer.submit(writer.finish())` call per frame (no call per
// primitive). Format (little-endian f32, decoded in rust/src/frame.rs):
//
//   [0] version 1   [1] n payload values   payload: opcode, operands...
//   1 clear r g b a | 2 rect x y w h r g b a | 3 circle cx cy radius r g b a
//   4 roundRect x y w h radius r g b a | 5 line x0 y0 x1 y1 width r g b a
//
// Coordinates are layout units (as React Native layout); colours are straight sRGB
// components 0..1. `finish()` returns a new ArrayBuffer holding exactly the used values (one
// copy in JS, of the used bytes only), which `submit` copies once more into Rust; the writer's
// growable working buffer is reused across frames.

export type Color = readonly [r: number, g: number, b: number, a: number];

const MAX_FLOATS = (1 << 20) / 4;
const HEADER = 2;

export class FrameWriter {
  private data: Float32Array;
  private used = HEADER;

  constructor(initialFloats = 256) {
    this.data = new Float32Array(Math.max(initialFloats, 16));
  }

  /** Starts a new frame, reusing the buffer. */
  begin(): this {
    this.used = HEADER;
    return this;
  }

  clear(c: Color): this {
    return this.push5(1, c[0], c[1], c[2], c[3]);
  }

  rect(x: number, y: number, w: number, h: number, c: Color): this {
    this.reserve(9);
    this.put(2, x, y, w, h);
    return this.color(c);
  }

  circle(cx: number, cy: number, radius: number, c: Color): this {
    this.reserve(8);
    this.put(3, cx, cy, radius);
    return this.color(c);
  }

  roundRect(x: number, y: number, w: number, h: number, radius: number, c: Color): this {
    this.reserve(10);
    this.put(4, x, y, w, h, radius);
    return this.color(c);
  }

  line(x0: number, y0: number, x1: number, y1: number, width: number, c: Color): this {
    this.reserve(10);
    this.put(5, x0, y0, x1, y1, width);
    return this.color(c);
  }

  /** Writes the header and returns a copy of the used part, to pass to `submit`. */
  finish(): ArrayBuffer {
    this.data[0] = 1;
    this.data[1] = this.used - HEADER;
    return (this.data.buffer as ArrayBuffer).slice(0, this.used * 4);
  }

  /** Payload values written so far (for tests and diagnostics). */
  get length(): number {
    return this.used - HEADER;
  }

  private push5(op: number, a: number, b: number, c: number, d: number): this {
    this.reserve(5);
    this.put(op, a, b, c, d);
    return this;
  }

  private color(c: Color): this {
    return this.put(c[0], c[1], c[2], c[3]);
  }

  private put(...values: number[]): this {
    for (const v of values) this.data[this.used++] = v;
    return this;
  }

  private reserve(n: number): void {
    const need = this.used + n;
    if (need <= this.data.length) return;
    if (need > MAX_FLOATS) throw new RangeError(`frame exceeds ${MAX_FLOATS * 4} bytes`);
    let size = this.data.length * 2;
    while (size < need) size *= 2;
    const next = new Float32Array(Math.min(size, MAX_FLOATS));
    next.set(this.data.subarray(0, this.used));
    this.data = next;
  }
}
