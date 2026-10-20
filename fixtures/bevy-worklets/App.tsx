// Android-only bounded input fixture. UI gestures capture an existing boxed Scene handle.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  GestureDetector,
  GestureHandlerRootView,
  usePanGesture,
} from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';
import * as Worklets from 'react-native-worklets';
import { enableWorklets, isRnrClosedError, workletEndpoint } from '@rnrs/runtime/worklets';
import { SurfaceView } from '@rnrs/surface';
import { bevy3DModule, type Scene } from '@rnrs/example-bevy3d';

enableWorklets(Worklets);
const report = (tag: string, value: unknown) => console.log(tag + ' ' + JSON.stringify(value));

function Button({ id, onPress }: { id: string; onPress: () => void }) {
  const ref = useRef<View>(null);
  return (
    <Pressable
      ref={ref}
      onLayout={() =>
        ref.current?.measureInWindow((x, y, w, h) => report('RNR_BUTTON', { id, x, y, w, h }))
      }
      onPress={onPress}
      style={{ padding: 14, backgroundColor: '#345', margin: 4 }}
    >
      <Text style={{ color: 'white' }}>{id}</Text>
    </Pressable>
  );
}

function SceneView({ scene }: { scene: Scene }) {
  useEffect(
    () => () => {
      scene.close();
    },
    [scene],
  );
  return <SurfaceView surfaceKey={scene.surfaceKey()} style={{ flex: 1 }} />;
}

export default function App() {
  const scene = useMemo(() => {
    const module = bevy3DModule();
    workletEndpoint(module, ['Scene.setRotation']);
    const s = module.create();
    s.setPaused(true);
    return s;
  }, []);
  const [mounted, setMounted] = useState(true);
  const [line, setLine] = useState('starting');
  const events = useSharedValue({ events: 0, accepted: 0, refused: 0, closed: 0, unexpected: '' });
  const pan = usePanGesture({
    onUpdate: (e) => {
      'worklet';
      const previous = events.value;
      try {
        const accepted = scene.setRotation(e.translationX * 0.012);
        events.value = {
          ...previous,
          events: previous.events + 1,
          accepted: previous.accepted + (accepted ? 1 : 0),
          refused: previous.refused + (accepted ? 0 : 1),
        };
      } catch (error) {
        events.value = isRnrClosedError(error)
          ? { ...previous, events: previous.events + 1, closed: previous.closed + 1 }
          : { ...previous, events: previous.events + 1, unexpected: String(error) };
      }
    },
  });
  useEffect(() => {
    const timer = setInterval(() => {
      try {
        const stats = scene.stats();
        report('RNR_INPUT', { stats, gesture: events.value });
        setLine(
          stats.state + ' received ' + stats.inputReceived + ' applied ' + stats.inputApplied,
        );
      } catch (error) {
        report('RNR_INPUT_ERROR', String(error));
      }
    }, 500);
    return () => {
      clearInterval(timer);
      scene.close();
    };
  }, [scene, events]);
  const stall = () => {
    // A short lead-in lets the driver start a real swipe; the bracket samples themselves
    // are taken synchronously in this RN task. No SharedValue read occurs in the stall.
    report('RNR_STALL_ARMED', {});
    setTimeout(() => {
      const before = scene.stats();
      const start = performance.now();
      while (performance.now() - start < 1500) {
        /* controlled RN JS stall */
      }
      const after = scene.stats();
      report('RNR_STALL', { before, after, elapsedMs: performance.now() - start });
    }, 750);
  };
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#181c22' }}>
      <GestureDetector gesture={pan}>
        <View collapsable={false} style={{ height: 400 }}>
          {mounted && <SceneView scene={scene} />}
          <View pointerEvents="none" style={{ position: 'absolute', top: 12, left: 12 }}>
            <Text style={{ color: 'white' }}>TSX overlay · UI pan → Rust → Bevy</Text>
            <Text style={{ color: 'white' }}>{line}</Text>
          </View>
        </View>
      </GestureDetector>
      <Button id="Stall JS" onPress={stall} />
      <Button id="Unmount" onPress={() => setMounted(false)} />
      <Text style={{ color: 'white', padding: 12 }}>
        Drag the cube. After unmount, the retained gesture pad tests late calls.
      </Text>
    </GestureHandlerRootView>
  );
}

// Hermes provides this global; RN's TypeScript library does not declare it.
declare const performance: { now(): number };
