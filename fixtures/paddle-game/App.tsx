// Paddle/ball game on @rnrs/surface + @rnrs/example-vello2d: the clean consumer app's only source.
// TypeScript owns the whole game (game.ts); Rust only draws the frame submitted once per
// display tick. Input is ordinary React Native touch on an overlay; the HUD is TSX above the
// SurfaceView.
//
// Lifecycle (game.ts Lifecycle): the game runs only on ticks where the app is observed active
// and the renderer observed attached at that moment (fresh AppState and stats() at the top of
// every requestAnimationFrame tick, and in the AppState and poll handlers). It starts paused.
//
// Sessions: first a scripted one (seeded autopilot, 20 s of running time) whose checks are
// logged as RNRS_GAME*, then an interactive one driven by touch, logging RNRS_GAME_STATS twice a
// second for the device driver (scripts/consumer/game-device-test.mjs).
//
// Contention runs (contention.ts): only when launched with
// an rnrsgame://contention data URI; they replace both sessions. Without the URI nothing changes.
import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  Linking,
  SafeAreaView,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { SurfaceView } from '@rnrs/surface';
import { vello2DModule, type Renderer, type RendererStats } from '@rnrs/example-vello2d';
import { FrameWriter } from '@rnrs/example-vello2d/frame';
import { Session, TIMING_RECORDS, parseConfig, perfNow } from './contention';
import {
  Clock,
  Lifecycle,
  STEP_S,
  autopilot,
  createGame,
  drawFrame,
  resize,
  step,
  type Game,
} from './game';
import { Recorder, report, type Check } from './smoke';

const SEED = 12345;
const SCRIPTED_ACTIVE_S = 20;

interface Hud {
  score: number;
  lives: number;
  level: number;
  rafPerS: number;
  simHz: number;
  presentedPerS: number;
  mode: string;
  paused: boolean;
}

/** Layout size (layout units) against the renderer surface (physical pixels, scale). */
function sizes(layout: { w: number; h: number } | null, st: RendererStats, g: Game | null) {
  return {
    layout: layout ? [Math.round(layout.w * 100) / 100, Math.round(layout.h * 100) / 100] : null,
    game: g ? [Math.round(g.width * 100) / 100, Math.round(g.height * 100) / 100] : null,
    surface: [st.surfaceWidth, st.surfaceHeight],
    raster: [st.rasterWidth, st.rasterHeight],
    scale: st.scale,
    resizes: st.resizes,
  };
}
/** Physical surface = layout × scale, within 2 px (Android rounds the view's pixel size). */
function sizeAgrees(layout: { w: number; h: number } | null, st: RendererStats) {
  return (
    !!layout &&
    st.state === 'attached' &&
    Math.abs(st.surfaceWidth - layout.w * st.scale) <= 2 &&
    Math.abs(st.surfaceHeight - layout.h * st.scale) <= 2
  );
}

export default function App() {
  const [renderer, setRenderer] = useState<Renderer | null>(null);
  const [hud, setHud] = useState<Hud>({
    score: 0,
    lives: 3,
    level: 0,
    rafPerS: 0,
    simHz: 0,
    presentedPerS: 0,
    mode: 'scripted',
    paused: true,
  });
  const layout = useRef<{ w: number; h: number } | null>(null);
  const touchX = useRef<number | null>(null);
  const touches = useRef(0);
  const session = useRef<Session | null>(null);

  // The renderer is created by an effect (not during render), after reading the launch URI,
  // and closed on unmount.
  useEffect(() => {
    let r: Renderer | null = null;
    let cancelled = false;
    Linking.getInitialURL()
      .catch(() => null)
      .then((url) => {
        if (cancelled) return;
        const cfg = parseConfig(url);
        if (cfg) {
          session.current = new Session(cfg);
          console.log(
            'RNRS_CONTENTION ' +
              JSON.stringify({
                run: cfg.run,
                event: 'config',
                url,
                config: cfg,
                hermesRuntimeProperties: session.current.runtimeProperties,
              }),
          );
        }
        r = vello2DModule().create(
          cfg?.instrumented
            ? { resolutionScale: 1, timingRecords: TIMING_RECORDS }
            : { resolutionScale: 1 },
        );
        setRenderer(r);
      });
    return () => {
      cancelled = true;
      r?.close();
    };
  }, []);

  useEffect(() => {
    if (!renderer) return;
    const r = renderer;
    const writer = new FrameWriter();
    const contention = session.current;
    let game: Game | null = null;
    let mode: 'scripted' | 'interactive' = 'scripted';
    let clock = new Clock();
    const life = new Lifecycle(
      {
        appActive: () => AppState.currentState === 'active',
        rendererAttached: () => r.stats().state === 'attached',
        gameTick: () => game?.tick ?? 0,
        framesSubmitted: () => r.stats().framesSubmitted,
      },
      clock,
    );
    let handle = 0;
    let recorder = new Recorder();
    let sessionActiveS = 0;
    let lastRunningNow: number | null = null;
    let wasRunning = false;
    const firstTickAfterResumeSteps: number[] = [];
    let needsFrame = true;
    let rate = { t: 0, ticks: 0, steps: 0, presented: 0 };
    let interactive = { resumes: 0, pauses: 0, transitions: 0 };

    const appState = AppState.addEventListener('change', () => life.check('appstate'));

    const ensureGame = () => {
      const l = layout.current;
      if (!l) return null;
      if (!game) game = createGame(l.w, l.h, mode === 'scripted' ? SEED : SEED + 1);
      else if (game.width !== l.w || game.height !== l.h) {
        resize(game, l.w, l.h);
        needsFrame = true;
      }
      return game;
    };

    const finishScripted = (now: number) => {
      recorder.endedMs = now;
      recorder.activeS = sessionActiveS;
      const s = recorder.summary();
      const st = r.stats();
      const g = game!;
      const checks: Check[] = [];
      const check = (name: string, ok: boolean, detail: unknown) =>
        checks.push({
          name,
          ok,
          detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
        });
      check(
        'renderer attached, GPU ready, no surface errors',
        st.state === 'attached' &&
          st.gpuState === 'ready' &&
          st.surfaceErrors === 0 &&
          st.lastError === null,
        {
          state: st.state,
          gpu: st.gpuState,
          errors: st.surfaceErrors,
          lastError: st.lastError,
          presentation: st.presentation,
        },
      );
      check(
        'the simulation runs at its fixed rate (120 steps per running second ±5%)',
        Math.abs(s.perActiveSecond.simSteps - 1 / STEP_S) <= 6,
        s.perActiveSecond,
      );
      check(
        'at most one batched frame per display tick (submits ≤ ticks)',
        s.perActiveSecond.submits <= s.perActiveSecond.rafTicks + 0.5,
        s.perActiveSecond,
      );
      check(
        'frames are presented (> 30/s)',
        s.perActiveSecond.rendererPresented > 30,
        s.perActiveSecond,
      );
      check('the scripted player breaks bricks (score > 0)', g.score > 0, {
        score: g.score,
        lives: g.lives,
        level: g.level,
        ticks: g.tick,
      });
      check(
        'the renderer surface matches the layout (physical = layout × scale, ±2 px)',
        sizeAgrees(layout.current, st),
        sizes(layout.current, st, g),
      );
      report('RNRS_GAME', {
        ok: checks.every((c) => c.ok),
        checks,
        metrics: s,
        consistency: { maxStepsInATick: clock.maxStepsInATick, droppedS: clock.droppedS },
        seed: SEED,
        lifecycle: { transitions: life.transitions, resumes: life.resumes, pauses: life.pauses },
      });
      // Interactive session: a fresh game, clock and baselines.
      mode = 'interactive';
      game = null;
      needsFrame = true;
      recorder = new Recorder();
      clock = new Clock();
      life.setClock(clock);
      sessionActiveS = 0;
      interactive = {
        resumes: life.resumes,
        pauses: life.pauses,
        transitions: life.transitions.length,
      };
    };

    const tick = (now: number) => {
      handle = requestAnimationFrame(tick);
      const tTop = perfNow();
      const g = ensureGame();
      if (!g) return;
      // Contention: phase changes, and stalls in the rAF placement (before this tick's steps),
      // gated on a fresh lifecycle check (not the previous tick's state). Outside contention runs
      // the optional call, and so the check, is skipped.
      contention?.beginTick(life.check('tick'), () => contention.drainFrom(() => r.drainTimings()));
      const steps = life.stepsFor(now); // fresh AppState and renderer state, every tick
      if (!life.running) {
        wasRunning = false;
        lastRunningNow = null;
        return;
      }
      if (!wasRunning) {
        firstTickAfterResumeSteps.push(steps);
        if (firstTickAfterResumeSteps.length > 20) firstTickAfterResumeSteps.shift();
        needsFrame = true;
        wasRunning = true;
        if (recorder.startedMs === 0) recorder.startedMs = now;
      }
      if (lastRunningNow !== null) sessionActiveS += Math.min((now - lastRunningNow) / 1000, 0.1);
      lastRunningNow = now;
      contention?.beforeSteps(steps, g.tick);
      const auto = contention ? contention.autopilot : mode === 'scripted';
      for (let i = 0; i < steps; i++) step(g, auto ? autopilot(g, 7) : { targetX: touchX.current });
      let submitted = false;
      if (steps > 0 || needsFrame) {
        drawFrame(writer, g);
        submitted = r.submit(writer.finish());
        needsFrame = false;
      }
      recorder.tick(now, steps, submitted);
      contention?.endTick(tTop, now, steps, submitted, clock.droppedS);
      contention?.afterSubmit();
      rate.ticks++;
      rate.steps += steps;
      if (!contention && mode === 'scripted' && sessionActiveS >= SCRIPTED_ACTIVE_S)
        finishScripted(now);
    };
    handle = requestAnimationFrame(tick);

    // Poll (10 Hz): a further fresh check, and renderer snapshots for metrics while running.
    const poll = setInterval(() => {
      if (life.check('poll')) recorder.snapshot(r.stats());
    }, 100);
    // Contention: a ring drain (instrumented runs only) and a renderer snapshot each second.
    const contentionTimer =
      contention &&
      setInterval(() => {
        if (contention.phase === 'done') return;
        if (contention.cfg.instrumented) contention.drainFrom(() => r.drainTimings());
        contention.snapshot(r.stats());
      }, 1000);
    const hudTimer = setInterval(() => {
      const st = r.stats();
      const now = Date.now();
      const dt = (now - rate.t) / 1000;
      if (rate.t > 0 && dt > 0) {
        setHud({
          score: game?.score ?? 0,
          lives: game?.lives ?? 0,
          level: game?.level ?? 0,
          rafPerS: Math.round(rate.ticks / dt),
          simHz: Math.round(rate.steps / dt),
          presentedPerS: Math.round((st.framesPresented - rate.presented) / dt),
          mode,
          paused: !life.running,
        });
      }
      rate = { t: now, ticks: 0, steps: 0, presented: st.framesPresented };
    }, 250);
    const statsTimer = setInterval(() => {
      if (contention || mode !== 'interactive' || !game) return;
      const st = r.stats();
      console.log(
        'RNRS_GAME_STATS ' +
          JSON.stringify({
            tick: game.tick,
            running: life.running,
            appState: AppState.currentState,
            renderer: st.state,
            gpu: st.gpuState,
            surfaceErrors: st.surfaceErrors,
            resumes: life.resumes - interactive.resumes,
            pauses: life.pauses - interactive.pauses,
            transitions: life.transitions.slice(-6),
            firstTickAfterResumeSteps,
            framesSubmitted: st.framesSubmitted,
            presented: st.framesPresented,
            attaches: st.attaches,
            detaches: st.detaches,
            sizes: sizes(layout.current, st, game),
            sizeAgrees: sizeAgrees(layout.current, st),
            paddleX: Math.round(game.paddle.x),
            touchX: touchX.current === null ? null : Math.round(touchX.current),
            touches: touches.current,
            score: game.score,
            lives: game.lives,
            phase: game.phase,
            renderersOpen: st.renderersOpen,
            ownedByRuntime: st.ownedByRuntime,
            consistency: {
              simS: Math.round(game.tick * STEP_S * 1000) / 1000,
              activeS: Math.round(sessionActiveS * 1000) / 1000,
              droppedS: Math.round(clock.droppedS * 1000) / 1000,
              maxStepsInATick: clock.maxStepsInATick,
            },
          }),
      );
    }, 500);

    return () => {
      cancelAnimationFrame(handle);
      clearInterval(poll);
      if (contentionTimer) clearInterval(contentionTimer);
      clearInterval(hudTimer);
      clearInterval(statsTimer);
      appState.remove();
    };
  }, [renderer]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    layout.current = { w: width, h: height };
  };
  const onTouch = (e: GestureResponderEvent) => {
    const x = e.nativeEvent.locationX;
    touchX.current = x;
    touches.current++;
    session.current?.touch(e.nativeEvent.timestamp, x);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
      <View style={{ flex: 1 }} onLayout={onLayout}>
        {renderer && <SurfaceView surfaceKey={renderer.surfaceKey()} style={{ flex: 1 }} />}
        {/* Touch overlay above the surface: ordinary RN responder events, in layout units. */}
        <View
          style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={onTouch}
          onResponderMove={onTouch}
        />
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 8,
            top: 8,
            right: 8,
            flexDirection: 'row',
            justifyContent: 'space-between',
          }}
        >
          <Text
            style={{ color: 'white', fontSize: 18, fontWeight: '600' }}
          >{`Score ${hud.score}  Lives ${hud.lives}  Level ${hud.level + 1}`}</Text>
          <Text style={{ color: '#9ab', fontSize: 12, fontFamily: 'monospace' }}>
            {`${hud.mode}${hud.paused ? ' (paused)' : ''}\nrAF ${hud.rafPerS}/s · sim ${hud.simHz}/s\npresented ${hud.presentedPerS}/s (incl. re-presents)`}
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}
