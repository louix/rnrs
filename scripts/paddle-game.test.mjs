// The paddle/ball game simulation (fixtures/paddle-game/game.ts): deterministic, bounded,
// fixed-timestep. Node strips the TS types on import.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Clock, MAX_STEPS_PER_TICK, MAX_TICK_S, STEP_S, autopilot, createGame, drawFrame, resize, step} from '../fixtures/paddle-game/game.ts';

const run = (seed, steps, input = g => autopilot(g, 17)) => {
  const g = createGame(360, 640, seed);
  for (let i = 0; i < steps; i++) step(g, input(g));
  return g;
};

test('the same seed and inputs give the same game; another seed differs', () => {
  const a = run(42, 6000);
  const b = run(42, 6000);
  assert.deepEqual(a, b);
  const c = run(43, 6000);
  assert.notDeepEqual(c.ball, a.ball);
});

test('the ball stays inside the playfield and the autopilot scores', () => {
  const g = createGame(360, 640, 7);
  for (let i = 0; i < 20000; i++) {
    step(g, autopilot(g, 3));
    if (g.phase === 'play') {
      assert.ok(g.ball.x >= g.ball.r - 1e-9 && g.ball.x <= g.width - g.ball.r + 1e-9, `x ${g.ball.x} at tick ${g.tick}`);
      assert.ok(g.ball.y >= g.ball.r - 1e-9, `y ${g.ball.y}`);
    }
  }
  assert.ok(g.score > 0, 'bricks were broken');
  assert.ok(g.lives >= 0 && g.lives <= 3);
});

test('with no input the ball is eventually missed: lives run out and the game is over', () => {
  const g = run(9, 60000, () => ({targetX: 0}));
  assert.equal(g.phase, 'over');
  assert.equal(g.lives, 0);
  const tick = g.tick;
  step(g, {targetX: 100});
  assert.equal(g.tick, tick + 1, 'an over game still counts ticks but changes nothing else');
});

test('the paddle moves toward the target at bounded speed and stays on screen', () => {
  const g = createGame(360, 640, 1);
  const x0 = g.paddle.x;
  step(g, {targetX: 10_000});
  assert.ok(Math.abs(g.paddle.x - x0 - g.paddle.speed * STEP_S) < 1e-9, 'one step moves at most speed × step');
  for (let i = 0; i < 1000; i++) step(g, {targetX: 10_000});
  assert.equal(g.paddle.x, g.width - g.paddle.w / 2);
  step(g, {targetX: NaN});
  assert.equal(g.paddle.x, g.width - g.paddle.w / 2, 'invalid input is ignored');
});

test('resize keeps the game consistent (rotation), also afterwards', () => {
  const g = run(5, 500);
  resize(g, 640, 360);
  assert.equal(g.width, 640);
  assert.ok(g.paddle.x - g.paddle.w / 2 >= 0 && g.paddle.x + g.paddle.w / 2 <= 640);
  assert.ok(g.ball.y <= 360 - g.ball.r && g.ball.y >= g.ball.r);
  for (let i = 0; i < 2000; i++) {
    step(g, autopilot(g, 1));
    if (g.phase === 'play') assert.ok(g.ball.x >= g.ball.r - 1e-9 && g.ball.x <= 640 - g.ball.r + 1e-9 && g.ball.y >= g.ball.r - 1e-9);
    assert.ok(g.paddle.x - g.paddle.w / 2 >= -1e-9 && g.paddle.x + g.paddle.w / 2 <= 640 + 1e-9);
  }
});

test('resize during the serve keeps the ball on the paddle', () => {
  const g = createGame(360, 640, 2);
  assert.equal(g.phase, 'serve');
  resize(g, 640, 360);
  assert.equal(g.ball.x, g.paddle.x);
  assert.ok(Math.abs(g.ball.y - (g.paddle.y - g.paddle.h / 2 - g.ball.r - 1)) < 1e-9, 'resting on the moved paddle');
});

test('brick reflection points away from the brick centre', () => {
  const g = createGame(360, 640, 3);
  g.phase = 'play';
  const k = g.bricks[g.bricks.length - 1];
  // Approach from below, already moving down-ish relative to the overlap: must end moving down.
  g.ball.x = k.x + k.w / 2;
  g.ball.y = k.y + k.h + g.ball.r - 1;
  g.ball.vx = 0;
  g.ball.vy = 100; // a blind flip would send it up into the brick row
  step(g, {targetX: null});
  assert.ok(g.ball.vy > 0, `vy ${g.ball.vy}`);
});

test('the clock: fixed steps independent of the display rate', () => {
  // The same 2 s of wall time at 60 Hz and at 120 Hz run the same number of steps.
  const count = hz => {
    const c = new Clock();
    let steps = 0;
    for (let i = 0; i <= 2 * hz; i++) steps += c.advance((i * 1000) / hz);
    return steps;
  };
  assert.equal(count(60), 240);
  assert.equal(count(120), 240);
  assert.equal(count(90), 240);
});

test('the clock: bounded catch-up after a stall, nothing on the first tick after reset', () => {
  const c = new Clock();
  assert.equal(c.advance(0), 0);
  assert.equal(c.advance(16.7), 2);
  // A 5 s stall (or a background period without reset): at most MAX_STEPS_PER_TICK steps.
  const steps = c.advance(16.7 + 5000);
  assert.ok(steps <= MAX_STEPS_PER_TICK, `${steps}`);
  // Conservation: elapsed time = simulated + dropped (the capped tick leaves no accumulator),
  // so the fractional remainder is counted as dropped too.
  const elapsedS = (16.7 + 5000) / 1000;
  assert.ok(Math.abs(elapsedS - ((2 + steps) * STEP_S + c.droppedS)) < 1e-9, `dropped ${c.droppedS}`);
  // Pause/resume: reset forgets the gap entirely.
  c.reset();
  assert.equal(c.advance(60_000), 0, 'no catch-up after a reset');
  assert.equal(c.advance(60_000 + 1000 / 60), 2);
  assert.ok(c.maxStepsInATick <= MAX_STEPS_PER_TICK);
});

test('one frame per draw: clear, alive bricks, paddle, ball', () => {
  const calls = [];
  const sink = new Proxy({}, {get: (_, name) => (...args) => { calls.push(name); return sink; }});
  const g = createGame(360, 640, 1);
  g.bricks[0].alive = false;
  drawFrame(sink, g);
  assert.equal(calls[0], 'begin');
  assert.equal(calls[1], 'clear');
  assert.equal(calls.filter(c => c === 'rect').length, g.bricks.length - 1);
  assert.deepEqual(calls.slice(-2), ['roundRect', 'circle']);
});


/** The app loop's shape (App.tsx) on fake time and a fake renderer, driven by a Lifecycle. */
async function rig() {
  const {Lifecycle} = await import('../fixtures/paddle-game/game.ts');
  const world = {active: true, attached: false, submitted: 0};
  const game = createGame(360, 640, 11);
  const clock = new Clock();
  const life = new Lifecycle({
    appActive: () => world.active, rendererAttached: () => world.attached,
    gameTick: () => game.tick, framesSubmitted: () => world.submitted,
  }, clock);
  let t = 0;
  const tick = () => {
    const steps = life.stepsFor((t += 1000 / 60));
    for (let i = 0; i < steps; i++) step(game, autopilot(game, 1));
    if (steps > 0) world.submitted++; // the app submits only when it stepped (or needs a frame)
    return steps;
  };
  return {world, game, life, tick};
}

test('lifecycle: starts paused; the startup attach is "start", not a resume; no steps or submits before it', async () => {
  const {world, game, life, tick} = await rig();
  for (let i = 0; i < 10; i++) assert.equal(tick(), 0);
  assert.equal(game.tick, 0);
  assert.equal(world.submitted, 0);
  world.attached = true;
  assert.equal(tick(), 0, 'first running tick: clock reset, no catch-up');
  assert.equal(tick(), 2);
  assert.deepEqual(life.transitions.map(t => t.kind), ['start']);
  assert.equal(life.resumes, 0);
});

test('lifecycle: stale "active" before the re-attach: no steps or submits while detached, exactly one resume, tick unchanged across the pause', async () => {
  const {world, game, life, tick} = await rig();
  world.attached = true;
  for (let i = 0; i < 30; i++) tick();
  // Background: the app goes inactive; the renderer detaches while JS is suspended.
  world.active = false;
  life.check('appstate');
  world.attached = false;
  // Foreground: "active" arrives before the renderer has re-attached.
  world.active = true;
  life.check('appstate');
  const tickAtPause = game.tick;
  const submittedAtPause = world.submitted;
  for (let i = 0; i < 30; i++) assert.equal(tick(), 0, 'no steps while observed detached');
  assert.equal(game.tick, tickAtPause);
  assert.equal(world.submitted, submittedAtPause, 'no submits while detached');
  // The renderer re-attaches: the next tick observes it.
  world.attached = true;
  assert.equal(tick(), 0, 'no catch-up on the first running tick');
  assert.equal(tick(), 2);
  assert.equal(life.resumes, 1, 'exactly one resume for the cycle');
  assert.equal(life.pauses, 1);
  const [start, pause, resume] = life.transitions;
  assert.deepEqual([start.kind, pause.kind, resume.kind], ['start', 'pause', 'resume']);
  assert.equal(resume.tick, pause.tick, 'game tick unchanged across the pause');
  assert.equal(resume.framesSubmitted, pause.framesSubmitted, 'no frames submitted across the pause');
});

test('lifecycle: a detach without any app-state change (unmount, split screen) stops steps on the next tick', async () => {
  const {world, life, tick} = await rig();
  world.attached = true;
  for (let i = 0; i < 5; i++) tick();
  world.attached = false; // no event at all
  assert.equal(tick(), 0, 'the tick itself observes the detach');
  assert.equal(life.pauses, 1);
  world.attached = true;
  tick();
  assert.equal(life.resumes, 1);
});
