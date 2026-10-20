// Paddle/ball game simulation: all game state lives here, in TypeScript. Pure and
// deterministic (seeded): no React Native, timers or rendering. The renderer only receives the
// frame `drawFrame` writes. Units are layout units (dp) with y pointing down.

/** Simulation step: fixed, independent of the display rate. */
export const STEP_S = 1 / 120;
/** Most steps run for one display tick; time beyond that is dropped (no runaway catch-up). */
export const MAX_STEPS_PER_TICK = 4;
/** A display tick longer than this (a stall, a pause) contributes at most this much time. */
export const MAX_TICK_S = 0.1;

export interface Ball { x: number; y: number; vx: number; vy: number; r: number }
export interface Paddle { x: number; y: number; w: number; h: number; speed: number }
export interface Brick { x: number; y: number; w: number; h: number; alive: boolean }

export interface Game {
  width: number;
  height: number;
  paddle: Paddle;
  ball: Ball;
  bricks: Brick[];
  score: number;
  lives: number;
  level: number;
  /** Simulation steps run so far. */
  tick: number;
  /** "serve": the ball waits on the paddle until `serveAt`. */
  phase: 'serve' | 'play' | 'over';
  serveAt: number;
  rng: number;
}

export interface Input {
  /** Desired paddle centre (layout units), or null to hold. */
  targetX: number | null;
}

/** mulberry32: a small seeded PRNG; returns [0, 1) and the next state. */
export function random(state: number): [number, number] {
  let t = (state + 0x6d2b79f5) | 0;
  let r = Math.imul(t ^ (t >>> 15), 1 | t);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  return [((r ^ (r >>> 14)) >>> 0) / 4294967296, t];
}

const BALL_SPEED = 420; // dp/s
const SERVE_TICKS = Math.round(0.6 / STEP_S);

function bricksFor(width: number, level: number): Brick[] {
  const cols = 7;
  const rows = Math.min(3 + level, 6);
  const gap = 4;
  const margin = 12;
  const w = (width - 2 * margin - gap * (cols - 1)) / cols;
  const bricks: Brick[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) bricks.push({x: margin + c * (w + gap), y: 60 + r * (16 + gap), w, h: 16, alive: true});
  }
  return bricks;
}

function serve(g: Game): void {
  g.phase = 'serve';
  g.serveAt = g.tick + SERVE_TICKS;
  g.ball.x = g.paddle.x;
  g.ball.y = g.paddle.y - g.paddle.h / 2 - g.ball.r - 1;
  g.ball.vx = 0;
  g.ball.vy = 0;
}

export function createGame(width: number, height: number, seed: number): Game {
  const paddle: Paddle = {x: width / 2, y: height - 40, w: Math.max(60, width * 0.22), h: 12, speed: 900};
  const g: Game = {
    width, height, paddle, ball: {x: 0, y: 0, vx: 0, vy: 0, r: 7}, bricks: bricksFor(width, 0),
    score: 0, lives: 3, level: 0, tick: 0, phase: 'serve', serveAt: 0, rng: seed | 0,
  };
  serve(g);
  return g;
}

/** Keeps the game consistent with a new view size (rotation, re-layout), in place. */
export function resize(g: Game, width: number, height: number): void {
  if (width === g.width && height === g.height) return;
  const sx = width / g.width;
  g.width = width;
  g.height = height;
  g.paddle.y = height - 40;
  g.paddle.w = Math.max(60, width * 0.22);
  g.paddle.x = Math.min(Math.max(g.paddle.x * sx, g.paddle.w / 2), width - g.paddle.w / 2);
  const alive = g.bricks.map(b => b.alive);
  g.bricks = bricksFor(width, g.level).map((b, i) => ({...b, alive: alive[i] ?? true}));
  if (g.phase === 'serve') {
    // A served ball sits on the paddle: follow the paddle's new position.
    g.ball.x = g.paddle.x;
    g.ball.y = g.paddle.y - g.paddle.h / 2 - g.ball.r - 1;
  } else {
    g.ball.x = Math.min(Math.max(g.ball.x * sx, g.ball.r), width - g.ball.r);
    g.ball.y = Math.min(Math.max(g.ball.y, g.ball.r), height - g.ball.r);
  }
}

/** One fixed simulation step. */
export function step(g: Game, input: Input): void {
  g.tick++;
  if (g.phase === 'over') return;
  const p = g.paddle;
  if (input.targetX !== null && Number.isFinite(input.targetX)) {
    const target = Math.min(Math.max(input.targetX, p.w / 2), g.width - p.w / 2);
    const max = p.speed * STEP_S;
    p.x += Math.max(-max, Math.min(max, target - p.x));
  }
  const b = g.ball;
  if (g.phase === 'serve') {
    b.x = p.x;
    if (g.tick < g.serveAt) return;
    const [u, next] = random(g.rng);
    g.rng = next;
    const angle = (-Math.PI / 2) + (u - 0.5) * (Math.PI / 3); // up, ±30°
    b.vx = Math.cos(angle) * BALL_SPEED;
    b.vy = Math.sin(angle) * BALL_SPEED;
    g.phase = 'play';
  }
  b.x += b.vx * STEP_S;
  b.y += b.vy * STEP_S;
  // Walls.
  if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx); }
  if (b.x > g.width - b.r) { b.x = g.width - b.r; b.vx = -Math.abs(b.vx); }
  if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy); }
  // Paddle: reflect upwards, angle from the hit offset (−60°..60° from vertical).
  if (b.vy > 0 && b.y + b.r >= p.y - p.h / 2 && b.y - b.r <= p.y + p.h / 2 && Math.abs(b.x - p.x) <= p.w / 2 + b.r) {
    const offset = Math.max(-1, Math.min(1, (b.x - p.x) / (p.w / 2)));
    const angle = offset * (Math.PI / 3);
    const speed = Math.hypot(b.vx, b.vy);
    b.vx = Math.sin(angle) * speed;
    b.vy = -Math.cos(angle) * speed;
    b.y = p.y - p.h / 2 - b.r;
  }
  // Bricks: at most one per step; reflect along the axis of least penetration.
  for (const k of g.bricks) {
    if (!k.alive) continue;
    const cx = Math.max(k.x, Math.min(b.x, k.x + k.w));
    const cy = Math.max(k.y, Math.min(b.y, k.y + k.h));
    if ((b.x - cx) ** 2 + (b.y - cy) ** 2 > b.r * b.r) continue;
    k.alive = false;
    g.score += 10;
    const overlapX = Math.min(b.x + b.r - k.x, k.x + k.w - (b.x - b.r));
    const overlapY = Math.min(b.y + b.r - k.y, k.y + k.h - (b.y - b.r));
    // Reflect away from the brick's centre (not a blind sign flip).
    if (overlapX < overlapY) b.vx = b.x < k.x + k.w / 2 ? -Math.abs(b.vx) : Math.abs(b.vx);
    else b.vy = b.y < k.y + k.h / 2 ? -Math.abs(b.vy) : Math.abs(b.vy);
    break;
  }
  if (g.bricks.every(k => !k.alive)) {
    g.level++;
    g.bricks = bricksFor(g.width, g.level);
    serve(g);
    return;
  }
  // Missed: lose a life.
  if (b.y - b.r > g.height) {
    g.lives--;
    if (g.lives <= 0) g.phase = 'over';
    else serve(g);
  }
}

/** Fixed-timestep clock driven by display ticks, with bounded catch-up. */
export class Clock {
  private last: number | null = null;
  private accumulator = 0;
  /** Simulation time dropped by the per-tick limits (stalls, catch-up beyond the cap). */
  droppedS = 0;
  maxStepsInATick = 0;

  /** Steps to run for a display tick at `nowMs`. The first tick after `reset` runs none. */
  advance(nowMs: number): number {
    if (this.last === null) {
      this.last = nowMs;
      return 0;
    }
    let dt = (nowMs - this.last) / 1000;
    this.last = nowMs;
    if (!(dt > 0)) return 0;
    if (dt > MAX_TICK_S) {
      this.droppedS += dt - MAX_TICK_S;
      dt = MAX_TICK_S;
    }
    this.accumulator += dt;
    let steps = Math.floor(this.accumulator / STEP_S + 1e-9);
    if (steps > MAX_STEPS_PER_TICK) {
      // Everything beyond the capped steps is dropped, including the fractional remainder.
      this.droppedS += this.accumulator - MAX_STEPS_PER_TICK * STEP_S;
      steps = MAX_STEPS_PER_TICK;
      this.accumulator = 0;
    } else {
      this.accumulator -= steps * STEP_S;
    }
    this.maxStepsInATick = Math.max(this.maxStepsInATick, steps);
    return steps;
  }

  /** Forget the previous tick and the accumulated time (pause, background, detach). */
  reset(): void {
    this.last = null;
    this.accumulator = 0;
  }
}

/** The subset of @rnrs/example-vello2d's FrameWriter the game needs (kept structural, so this
 *  module stays free of imports and runs under plain Node in tests). */
export interface FrameSink {
  begin(): unknown;
  clear(c: readonly [number, number, number, number]): unknown;
  rect(x: number, y: number, w: number, h: number, c: readonly [number, number, number, number]): unknown;
  roundRect(x: number, y: number, w: number, h: number, r: number, c: readonly [number, number, number, number]): unknown;
  circle(cx: number, cy: number, r: number, c: readonly [number, number, number, number]): unknown;
}

const BRICK_COLORS: readonly (readonly [number, number, number, number])[] = [
  [0.93, 0.35, 0.35, 1], [0.95, 0.6, 0.25, 1], [0.95, 0.85, 0.3, 1], [0.4, 0.8, 0.45, 1], [0.35, 0.6, 0.95, 1], [0.65, 0.45, 0.9, 1],
];

/** Writes one whole frame (one batched submit per display tick). */
export function drawFrame(out: FrameSink, g: Game): void {
  out.begin();
  out.clear([0.06, 0.07, 0.12, 1]);
  const rowOf = (k: Brick) => Math.round((k.y - 60) / 20);
  for (const k of g.bricks) if (k.alive) out.rect(k.x, k.y, k.w, k.h, BRICK_COLORS[rowOf(k) % BRICK_COLORS.length]);
  const p = g.paddle;
  out.roundRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, p.h / 2, [0.9, 0.9, 0.95, 1]);
  out.circle(g.ball.x, g.ball.y, g.ball.r, g.phase === 'over' ? [0.5, 0.5, 0.5, 1] : [1, 0.85, 0.2, 1]);
}

/** A deterministic "player" for scripted runs: tracks the ball with a seeded offset. */
export function autopilot(g: Game, offsetSeed: number): Input {
  const wobble = Math.sin((g.tick + offsetSeed) / 90) * g.paddle.w * 0.35;
  return {targetX: g.ball.x + wobble};
}


/** Fresh lifecycle observations, injected (the app reads AppState and renderer.stats()). */
export interface LifecycleProbe {
  appActive(): boolean;
  rendererAttached(): boolean;
  /** For the transition record: the game's tick and the renderer's framesSubmitted. */
  gameTick(): number;
  framesSubmitted(): number;
}

export interface Transition {
  /** "start": the first time the game may run (the startup attach), not a resume. */
  kind: 'start' | 'pause' | 'resume';
  reason: string;
  tick: number;
  framesSubmitted: number;
}

/** Whether the game may run, decided from fresh observations only. The app calls `check` at
 *  the top of every display tick and in its AppState/poll handlers, so steps run only on
 *  ticks where the app was observed active and the renderer observed attached at that moment.
 *  The game starts paused. Every transition resets the clock (no catch-up) and is recorded with
 *  the game tick and the renderer's submitted-frame count, so "nothing ran while paused" is
 *  checkable. Observation is still sampling: a detach that happens between two checks within one
 *  tick is not seen before that tick's steps. */
export class Lifecycle {
  running = false;
  started = false;
  resumes = 0;
  pauses = 0;
  /** Bounded history (most recent 50). */
  transitions: Transition[] = [];
  private probe: LifecycleProbe;
  private clock: Clock;

  constructor(probe: LifecycleProbe, clock: Clock) {
    this.probe = probe;
    this.clock = clock;
  }

  /** Replaces the clock (per session: fresh drop and catch-up statistics). */
  setClock(clock: Clock): void {
    this.clock = clock;
  }

  check(reason: string): boolean {
    const run = this.probe.appActive() && this.probe.rendererAttached();
    if (run === this.running) return run;
    this.running = run;
    this.clock.reset();
    const kind = run ? (this.started ? 'resume' : 'start') : 'pause';
    if (kind === 'resume') this.resumes++;
    if (kind === 'pause') this.pauses++;
    if (run) this.started = true;
    this.transitions.push({kind, reason, tick: this.probe.gameTick(), framesSubmitted: this.probe.framesSubmitted()});
    if (this.transitions.length > 50) this.transitions.shift();
    return run;
  }

  /** Steps for a display tick: checks fresh state first; none while paused. */
  stepsFor(nowMs: number): number {
    if (!this.check('tick')) return 0;
    return this.clock.advance(nowMs);
  }
}
