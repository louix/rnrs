// In-app checks for the Bevy example (docs/bevy3d.md), using only public package APIs. Rust
// renders continuously on its own thread; this sequence only sets controls, changes the
// layout and reads stats.
import type { Scene, SceneStats } from '@rnrs/example-bevy3d';

export interface Layout {
  /** Surface view height in layout units, or 0 to unmount it. */
  height: number;
  label: string;
}
export interface Check {
  name: string;
  ok: boolean;
  detail: unknown;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(
  scene: Scene,
  pred: (s: SceneStats) => boolean,
  timeoutMs: number,
): Promise<SceneStats> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = scene.stats();
    if (pred(s) || Date.now() > end) return s;
    await sleep(100);
  }
}

export async function runSmoke(
  scene: Scene,
  setLayout: (l: Layout) => void,
): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: unknown) => checks.push({ name, ok, detail });

  // First frames include device creation and Bevy pipeline compilation.
  setLayout({ height: 420, label: 'mounted' });
  const first = await until(scene, (s) => s.framesPresented > 30 || s.gpuState === 'failed', 30000);
  check(
    'mount: Bevy renders and presents',
    first.state === 'attached' && first.gpuState === 'ready' && first.framesPresented > 30,
    first,
  );

  const a0 = scene.stats().angle;
  await sleep(500);
  const a1 = scene.stats().angle;
  check('Rust-owned simulation advances (angle changes while running)', a0 !== a1, { a0, a1 });

  scene.setPaused(true);
  await sleep(300);
  const p0 = scene.stats();
  await sleep(700);
  const p1 = scene.stats();
  check(
    'pause: angle and rendering stop',
    p0.angle === p1.angle && p1.paused && p1.framesRendered - p0.framesRendered <= 1,
    { p0: p0.angle, p1: p1.angle, rendered: p1.framesRendered - p0.framesRendered },
  );
  scene.setColor(0.1, 0.6, 0.9);
  const recolored = await until(scene, (s) => s.framesPresented > p1.framesPresented, 2000);
  check(
    'color change while paused re-renders once',
    recolored.framesPresented > p1.framesPresented,
    { before: p1.framesPresented, after: recolored.framesPresented },
  );
  scene.setPaused(false);
  scene.setSpeed(3);

  setLayout({ height: 260, label: 'resized' });
  const resized = await until(
    scene,
    (s) =>
      s.surfaceHeight !== first.surfaceHeight && s.framesPresented > recolored.framesPresented + 30,
    5000,
  );
  check(
    'resize: presenting at the new size',
    resized.surfaceHeight !== first.surfaceHeight && resized.gpuState === 'ready',
    { before: `${first.surfaceWidth}x${first.surfaceHeight}`, after: resized },
  );

  setLayout({ height: 0, label: 'unmounted' });
  const gone = await until(scene, (s) => s.state === 'detached', 3000);
  await sleep(300);
  const idle0 = scene.stats().framesRendered;
  await sleep(500);
  const idle1 = scene.stats().framesRendered;
  check('unmount: detached and not rendering', gone.state === 'detached' && idle1 === idle0, {
    state: gone.state,
    rendered: idle1 - idle0,
  });

  setLayout({ height: 420, label: 'remounted' });
  const back = await until(
    scene,
    (s) => s.state === 'attached' && s.framesPresented > gone.framesPresented + 30,
    5000,
  );
  check(
    'remount: re-attached and presenting',
    back.state === 'attached' && back.framesPresented > gone.framesPresented + 30,
    back,
  );
  check('no detach timeouts or errors', back.detachTimeouts === 0 && back.lastError === null, back);
  return { ok: checks.every((c) => c.ok), checks };
}
