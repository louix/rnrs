// Quiet headed view (?expect=view): one persistent Bevy cube with the consumer app's controls
// (Pause/Color/Speed, as fixtures/bevy-consumer/App.tsx) and nothing automatic. Resize,
// unmount/remount and the in-app sequence (the unchanged smoke.ts) run only when their buttons
// are pressed. Every action and every gpuState/presentation change goes to `log`, which the page
// persists so it survives a tab or GPU-process crash.
// Differences from App.tsx (web only): no automatic runSmoke on mount; the actions row; logging
// through a prop instead of console lines.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View as RNView } from 'react-native';
import { SurfaceView } from '@rnrs/surface';
import { bevy3DModule, type Scene, type SceneStats } from '@rnrs/example-bevy3d';
import { runSmoke, type Layout } from './.generated/app/smoke';

const COLORS: [number, number, number][] = [
  [0.9, 0.45, 0.1],
  [0.1, 0.6, 0.9],
  [0.3, 0.85, 0.35],
  [0.85, 0.2, 0.6],
];

function Button({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={{
        backgroundColor: disabled ? '#0004' : '#000a',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 6,
        marginRight: 8,
        marginTop: 6,
      }}
    >
      <Text style={{ color: disabled ? '#888' : 'white', fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

export interface ViewProps {
  log: (event: string, detail?: unknown) => void;
  onScene: (scene: Scene) => void;
  /** The opt-in actions, also callable from a test driver (each is logged like a button press). */
  onActions?: (actions: Record<string, () => void>) => void;
}

export default function QuietView({ log, onScene, onActions }: ViewProps) {
  const scene = useMemo(() => bevy3DModule().create(), []);
  const [layout, setLayout] = useState<Layout>({ height: 420, label: 'mounted' });
  const [paused, setPaused] = useState(false);
  const [color, setColor] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [running, setRunning] = useState(false);
  const [line, setLine] = useState('');
  const last = useRef<{ gpuState?: string; presentation?: string; state?: string }>({});
  useEffect(() => {
    onScene(scene);
    log('scene created');
    const timer = setInterval(() => {
      let s: SceneStats;
      try {
        s = scene.stats();
      } catch (error) {
        log('stats failed', String(error));
        return;
      }
      const prev = last.current;
      if (
        s.gpuState !== prev.gpuState ||
        s.presentation !== prev.presentation ||
        s.state !== prev.state
      ) {
        log('phase', {
          state: s.state,
          gpuState: s.gpuState,
          presentation: s.presentation,
          size: `${s.surfaceWidth}x${s.surfaceHeight}`,
          framesPresented: s.framesPresented,
          lastError: s.lastError,
        });
        last.current = { gpuState: s.gpuState, presentation: s.presentation, state: s.state };
      }
      setLine(
        `${s.state} · ${s.gpuState} · ${s.surfaceWidth}x${s.surfaceHeight} · submitted ${s.framesPresented} · ${s.paused ? 'paused' : 'running'}`,
      );
    }, 250);
    return () => {
      clearInterval(timer);
      scene.close();
    };
  }, [scene, log, onScene]);
  const act = (name: string, f: () => void) => () => {
    log('action', name);
    f();
  };
  const runSequence = () => {
    setRunning(true);
    runSmoke(scene, (l) => {
      log('sequence layout', l);
      setLayout(l);
    })
      .then((result) =>
        log('sequence result', {
          ok: result.ok,
          checks: result.checks.map((c) => ({ name: c.name, ok: c.ok })),
        }),
      )
      .catch((error) => log('sequence error', String(error)))
      .finally(() => setRunning(false));
  };
  const resize = act('resize', () =>
    setLayout((l) => ({ height: l.height === 260 ? 420 : 260, label: 'resized' })),
  );
  const toggleMount = act('unmount/remount', () =>
    setLayout((l) =>
      l.height > 0 ? { height: 0, label: 'unmounted' } : { height: 420, label: 'remounted' },
    ),
  );
  const sequence = act('run sequence', runSequence);
  useEffect(() => {
    onActions?.({ resize, toggleMount, sequence });
  });
  return (
    <RNView style={{ flex: 1, backgroundColor: '#222' }}>
      <RNView style={{ height: 440 }}>
        {layout.height > 0 && (
          <RNView style={{ height: layout.height }}>
            <SurfaceView surfaceKey={scene.surfaceKey()} style={{ flex: 1 }} />
            <RNView style={{ position: 'absolute', left: 8, right: 8, top: 8 }}>
              <Text
                style={{
                  color: 'white',
                  backgroundColor: '#0008',
                  padding: 4,
                  alignSelf: 'flex-start',
                }}
              >{`TSX overlay · Bevy cube · ${layout.label}`}</Text>
              <Text
                style={{
                  color: '#ddd',
                  backgroundColor: '#0008',
                  padding: 4,
                  marginTop: 4,
                  alignSelf: 'flex-start',
                  fontSize: 11,
                }}
              >
                {line}
              </Text>
            </RNView>
            <RNView style={{ position: 'absolute', left: 8, bottom: 8, flexDirection: 'row' }}>
              <Button
                label={paused ? 'Resume' : 'Pause'}
                onPress={act(paused ? 'resume' : 'pause', () => {
                  scene.setPaused(!paused);
                  setPaused(!paused);
                })}
              />
              <Button
                label="Color"
                onPress={act('color', () => {
                  const next = (color + 1) % COLORS.length;
                  scene.setColor(...COLORS[next]);
                  setColor(next);
                })}
              />
              <Button
                label={`Speed ${speed}`}
                onPress={act('speed', () => {
                  const next = speed >= 4 ? 1 : speed + 1;
                  scene.setSpeed(next);
                  setSpeed(next);
                })}
              />
            </RNView>
          </RNView>
        )}
      </RNView>
      <RNView style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 8 }}>
        <Text style={{ color: '#fc6', marginTop: 12, marginRight: 8 }}>
          Opt-in lifecycle actions:
        </Text>
        <Button
          disabled={running}
          label={layout.height === 260 ? 'Resize to 420' : 'Resize to 260'}
          onPress={resize}
        />
        <Button
          disabled={running}
          label={layout.height > 0 ? 'Unmount surface' : 'Remount surface'}
          onPress={toggleMount}
        />
        <Button disabled={running} label="Run in-app sequence (smoke.ts)" onPress={sequence} />
      </RNView>
    </RNView>
  );
}
