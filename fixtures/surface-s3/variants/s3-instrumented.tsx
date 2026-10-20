// C1 S3 run 3, s3-instrumented: the matched repro (../App.tsx) with request instrumentation
// (RNR-NET console.log lines: runtime, request number, phase, path) and a log line right before
// the unmount-time renderer-closing post; otherwise unchanged. Bundled by
// scripts/consumer/ios-bundle-variant.sh onto the same binary (docs/research/ios-surface-c1-design.md).
//
// Original header: C1 stage S3 harness app (docs/research/ios-surface-c1-design.md): the paddle game on
// @rnrs/surface + @rnrs/example-vello2d, presenting continuously (seeded autopilot), driven by the
// simulator driver (scripts/consumer/ios-s3-sim-test.mjs) through a local HTTP server on the
// host (the simulator shares the host's network; the template allows local networking). It
// polls for commands and posts reports; without the server it just plays. JS only: no native
// file of the app is edited.
//
// Commands: stats (renderer stats + lifecycle), reload (React Native reload through the
// framework's test hook), unmount / remount (closes the renderer and its SurfaceView; a remount
// creates a new renderer, so a new surface key), resize (toggles the surface's height).
import React, { useEffect, useRef, useState } from 'react';
import { AppState, SafeAreaView, Text, View, type LayoutChangeEvent } from 'react-native';
import { SurfaceView } from '@rnrs/surface';
import { runtimeBindings } from '@rnrs/runtime/testing';
import { vello2DModule, type Renderer, type RendererStats } from '@rnrs/example-vello2d';
import { FrameWriter } from '@rnrs/example-vello2d/frame';
import {
  Clock,
  Lifecycle,
  autopilot,
  createGame,
  drawFrame,
  resize,
  step,
  type Game,
} from './game';

const SERVER = 'http://127.0.0.1:8765';
const SEED = 12345;
/** Each JS runtime (reloads included) gets its own id in the reports. */
const RUNTIME = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/** Requests this runtime has issued (all paths), for the RNR-NET lines. */
let requests = 0;
function netLog(path: string, phase: string) {
  requests++;
  console.log(`RNR-NET runtime=${RUNTIME} n=${requests} phase=${phase} path=${path}`);
}

async function post(path: string, body: object, phase = 'normal') {
  netLog(path, phase);
  try {
    await fetch(`${SERVER}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtime: RUNTIME, at: Date.now(), ...body }),
    });
  } catch {
    // No driver: nothing to report to.
  }
}

/** Renderer stats plus what JS knows (lifecycle, game) — the S3 driver's evidence. */
function snapshot(
  st: RendererStats | null,
  life: Lifecycle | null,
  game: Game | null,
  key: number,
) {
  return {
    appState: AppState.currentState,
    surfaceKey: key,
    renderer: st,
    lifecycle: life
      ? {
          running: life.running,
          resumes: life.resumes,
          pauses: life.pauses,
          transitions: life.transitions.slice(-8),
        }
      : null,
    game: game ? { tick: game.tick, score: game.score } : null,
  };
}

function GameSurface({ onStats, tall }: { onStats: (s: () => object) => void; tall: boolean }) {
  const [renderer, setRenderer] = useState<Renderer | null>(null);
  const layout = useRef<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let r: Renderer;
    try {
      r = vello2DModule().create({ resolutionScale: 1 });
    } catch (e) {
      // E.g. the render-thread cap: reported, never thrown into React.
      void post('/event', { kind: 'renderer-create-failed', error: String(e) });
      return;
    }
    setRenderer(r);
    void post('/event', { kind: 'renderer-created', surfaceKey: r.surfaceKey() });
    return () => {
      console.log(`RNR-NET unmount-post-next runtime=${RUNTIME} requestsBefore=${requests}`);
      void post(
        '/event',
        { kind: 'renderer-closing', surfaceKey: r.surfaceKey(), stats: r.stats() },
        'cleanup',
      );
      r.close();
    };
  }, []);

  useEffect(() => {
    if (!renderer) return;
    const r = renderer;
    const writer = new FrameWriter();
    let game: Game | null = null;
    const clock = new Clock();
    const life = new Lifecycle(
      {
        appActive: () => AppState.currentState === 'active',
        rendererAttached: () => r.stats().state === 'attached',
        gameTick: () => game?.tick ?? 0,
        framesSubmitted: () => r.stats().framesSubmitted,
      },
      clock,
    );
    const appState = AppState.addEventListener('change', (s) => {
      life.check('appstate');
      void post('/event', { kind: 'appstate', state: s, stats: r.stats() });
    });
    let handle = 0;
    let needsFrame = true;
    const tick = (now: number) => {
      handle = requestAnimationFrame(tick);
      const l = layout.current;
      if (!l) return;
      if (!game) game = createGame(l.w, l.h, SEED);
      else if (game.width !== l.w || game.height !== l.h) {
        resize(game, l.w, l.h);
        needsFrame = true;
      }
      const steps = life.stepsFor(now);
      if (!life.running) return;
      for (let i = 0; i < steps; i++) step(game, autopilot(game, 7));
      if (steps > 0 || needsFrame) {
        drawFrame(writer, game);
        r.submit(writer.finish());
        needsFrame = false;
      }
    };
    handle = requestAnimationFrame(tick);
    onStats(() => snapshot(r.stats(), life, game, r.surfaceKey()));
    return () => {
      cancelAnimationFrame(handle);
      appState.remove();
    };
  }, [renderer, onStats]);

  const onLayout = (e: LayoutChangeEvent) => {
    layout.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
  };
  return (
    <View style={{ height: tall ? '100%' : '60%' }} onLayout={onLayout}>
      {renderer && <SurfaceView surfaceKey={renderer.surfaceKey()} style={{ flex: 1 }} />}
    </View>
  );
}

export default function App() {
  const [mounted, setMounted] = useState(true);
  const [tall, setTall] = useState(true);
  const [generation, setGeneration] = useState(0);
  const stats = useRef<() => object>(() => ({ appState: AppState.currentState, renderer: null }));

  useEffect(() => {
    void post('/event', { kind: 'runtime-start' });
    let seq = 0;
    let stopped = false;
    const poll = async () => {
      while (!stopped) {
        let command: { id: number; cmd: string } | null = null;
        try {
          netLog('/next', 'poll');
          const res = await fetch(`${SERVER}/next?runtime=${RUNTIME}&seq=${seq}`);
          command = res.status === 200 ? await res.json() : null;
        } catch {
          command = null;
        }
        if (command && command.id >= seq) {
          seq = command.id + 1;
          const done = (data: object = {}) =>
            post('/report', { id: command!.id, cmd: command!.cmd, ...data });
          switch (command.cmd) {
            case 'stats':
              await done({ snapshot: stats.current() });
              break;
            case 'reload':
              await done({ snapshot: stats.current() });
              console.log(`RNR-NET reload runtime=${RUNTIME} requestsBefore=${requests}`);
              runtimeBindings().reloadForTesting!();
              break;
            case 'unmount':
              setMounted(false);
              await done();
              break;
            case 'remount':
              setGeneration((g) => g + 1);
              setMounted(true);
              await done();
              break;
            case 'resize':
              setTall((t) => !t);
              await done();
              break;
            default:
              await done({ error: 'unknown command' });
          }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
    };
    void poll();
    const periodic = setInterval(() => void post('/stats', { snapshot: stats.current() }), 1000);
    return () => {
      stopped = true;
      clearInterval(periodic);
    };
  }, []);

  const onStats = React.useCallback((s: () => object) => {
    stats.current = s;
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
      <View style={{ flex: 1 }}>
        {mounted && <GameSurface key={generation} onStats={onStats} tall={tall} />}
      </View>
      <Text
        style={{ position: 'absolute', top: 40, left: 8, color: '#9ab', fontSize: 12 }}
      >{`S3 ${RUNTIME} ${mounted ? 'mounted' : 'unmounted'}`}</Text>
    </SafeAreaView>
  );
}
