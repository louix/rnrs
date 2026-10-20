// C1 S3 run 3, reload-crash control D2 (docs/research/ios-surface-c1-design.md): the paddle
// game presenting on @rnrs/surface, with no networking at all (no fetch, no HTTP transport).
// Each runtime reloads itself through the RnrRuntime hook once its renderer is attached and
// has presented at least MIN_PRESENTED frames, so every reload tears down a presenting surface.
// Evidence goes to the unified log as console.log lines (React Native logs JS console output
// at every level in Release, subsystem com.facebook.react.log):
//   RNR-D2 start runtime=<id>
//   RNR-D2 reload runtime=<id> state=<state> framesPresented=<n> surfaceKey=<k>
// The app keeps reloading; scripts/consumer/ios-s3-sim-test.mjs --mode control-surface-nofetch
// counts the reloads, asserts the presents before each one and terminates the app after 10.
import React, {useEffect, useRef, useState} from 'react';
import {AppState, SafeAreaView, Text, View, type LayoutChangeEvent} from 'react-native';
import {SurfaceView} from '@rnrs/surface';
import {runtimeBindings} from '@rnrs/runtime/testing';
import {vello2DModule, type Renderer} from '@rnrs/example-vello2d';
import {FrameWriter} from '@rnrs/example-vello2d/frame';
import {Clock, Lifecycle, autopilot, createGame, drawFrame, resize, step, type Game} from './game';

const SEED = 12345;
const MIN_PRESENTED = 30;
const MIN_RUNTIME_MS = 2000;
const RUNTIME = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const STARTED = Date.now();

export default function App() {
  const [renderer, setRenderer] = useState<Renderer | null>(null);
  const layout = useRef<{w: number; h: number} | null>(null);

  useEffect(() => {
    console.log(`RNR-D2 start runtime=${RUNTIME}`);
    let r: Renderer;
    try {
      r = vello2DModule().create({resolutionScale: 1});
    } catch (e) {
      console.log(`RNR-D2 renderer-create-failed runtime=${RUNTIME} error=${String(e)}`);
      return;
    }
    setRenderer(r);
    return () => r.close();
  }, []);

  useEffect(() => {
    if (!renderer) return;
    const r = renderer;
    const writer = new FrameWriter();
    let game: Game | null = null;
    const clock = new Clock();
    const life = new Lifecycle({
      appActive: () => AppState.currentState === 'active',
      rendererAttached: () => r.stats().state === 'attached',
      gameTick: () => game?.tick ?? 0,
      framesSubmitted: () => r.stats().framesSubmitted,
    }, clock);
    let handle = 0;
    let reloading = false;
    const tick = (now: number) => {
      handle = requestAnimationFrame(tick);
      const l = layout.current;
      if (!l || reloading) return;
      if (!game) game = createGame(l.w, l.h, SEED);
      else if (game.width !== l.w || game.height !== l.h) resize(game, l.w, l.h);
      const steps = life.stepsFor(now);
      if (life.running && steps > 0) {
        for (let i = 0; i < steps; i++) step(game, autopilot(game, 7));
        drawFrame(writer, game);
        r.submit(writer.finish());
      }
      const st = r.stats();
      if (st.state === 'attached' && st.framesPresented >= MIN_PRESENTED && Date.now() - STARTED >= MIN_RUNTIME_MS) {
        reloading = true;
        console.log(`RNR-D2 reload runtime=${RUNTIME} state=${st.state} framesPresented=${st.framesPresented} surfaceKey=${r.surfaceKey()}`);
        runtimeBindings().reloadForTesting!();
      }
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [renderer]);

  const onLayout = (e: LayoutChangeEvent) => {
    layout.current = {w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height};
  };
  return (
    <SafeAreaView style={{flex: 1, backgroundColor: '#000'}}>
      <View style={{flex: 1}} onLayout={onLayout}>
        {renderer && <SurfaceView surfaceKey={renderer.surfaceKey()} style={{flex: 1}} />}
      </View>
      <Text style={{position: 'absolute', top: 40, left: 8, color: '#9ab', fontSize: 12}}>{`S3 control-surface-nofetch ${RUNTIME}`}</Text>
    </SafeAreaView>
  );
}
