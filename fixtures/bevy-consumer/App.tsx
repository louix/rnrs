// Clean consumer app for the Bevy example: the only source change to the RN template. A
// Rust-owned Bevy scene (one rotating cube) renders on its own thread into the surface; the TSX
// overlay above it only sets controls through the module's TypeScript API. Runs the in-app
// sequence (smoke.ts), logs `RNRS_SMOKE <json>`, then logs `RNRS_BEVY_STATS <json>` every second.
// Android: console.log lines (logcat). iOS: release builds forward only console.error to os_log,
// which truncates long lines, so there each report is console.error lines `<TAG> <i>/<n> <part>`
// of at most 700 characters (scripts/consumer/ios-bevy-sim-test.mjs joins them).
//
// Touch (Android): the surface opts in with touchInput="rust", so a drag on it reaches the Rust
// scene on the UI thread and rotates the cube, without JS. The overlay's buttons stay ordinary
// React Native views above it. **Stall JS** blocks the JS thread for 1.5 s between two
// synchronous stats() calls and logs `RNRS_STALL {ms, before, after}` (scripts/consumer/
// bevy-touch-device.mjs drags during it). The surface's window rect is logged as `RNRS_SURFACE`.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, SafeAreaView, Text, View, type HostInstance } from 'react-native';
import { SurfaceView } from '@rnrs/surface';
import { bevy3DModule } from '@rnrs/example-bevy3d';
import { runSmoke, type Layout } from './smoke';

function report(tag: string, value: unknown) {
  const text = JSON.stringify(value);
  if (Platform.OS !== 'ios') {
    console.log(`${tag} ${text}`);
    return;
  }
  const parts = Math.max(1, Math.ceil(text.length / 700));
  for (let i = 0; i < parts; i++)
    console.error(`${tag} ${i + 1}/${parts} ${text.slice(i * 700, (i + 1) * 700)}`);
}

const STALL_MS = 1500;

const COLORS: [number, number, number][] = [
  [0.9, 0.45, 0.1],
  [0.1, 0.6, 0.9],
  [0.3, 0.85, 0.35],
  [0.85, 0.2, 0.6],
];

// Logs `RNRS_BUTTON {id, x, y, w, h}` (layout units, relative to the root view) so the device
// driver can tap the overlay: uiautomator cannot dump a continuously animating window.
function Button({ id, label, onPress }: { id: string; label: string; onPress: () => void }) {
  const ref = useRef<HostInstance>(null);
  const reportLayout = () =>
    ref.current?.measureInWindow((x, y, w, h) => report('RNRS_BUTTON', { id, x, y, w, h }));
  return (
    <Pressable
      ref={ref}
      onLayout={reportLayout}
      onPress={onPress}
      style={{
        backgroundColor: '#000a',
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 6,
        marginRight: 8,
      }}
    >
      <Text style={{ color: 'white', fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  const scene = useMemo(() => bevy3DModule().create(), []);
  const [layout, setLayout] = useState<Layout>({ height: 0, label: 'starting' });
  const [status, setStatus] = useState('running…');
  const [paused, setPaused] = useState(false);
  const [color, setColor] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [line, setLine] = useState('');
  const surfaceRef = useRef<HostInstance>(null);
  const reportSurface = () =>
    surfaceRef.current?.measureInWindow((x, y, w, h) => report('RNRS_SURFACE', { x, y, w, h }));
  const stall = () => {
    const before = scene.stats();
    const started = Date.now();
    while (Date.now() - started < STALL_MS) {
      /* deliberately block the JS thread */
    }
    const ms = Date.now() - started;
    report('RNRS_STALL', { ms, before, after: scene.stats() });
  };
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    runSmoke(scene, setLayout)
      .then((result) => {
        result.checks.forEach((c, i) => report('RNRS_SMOKE_CHECK', { i, ...c }));
        report('RNRS_SMOKE', {
          ok: result.ok,
          checks: result.checks.map((c) => ({ name: c.name, ok: c.ok })),
        });
        setStatus(result.checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`).join('\n'));
      })
      .catch((error) => {
        report('RNRS_SMOKE', { ok: false, checks: [], error: String(error) });
        setStatus(String(error));
      })
      .finally(() => {
        timer = setInterval(() => {
          try {
            const s = scene.stats();
            report('RNRS_BEVY_STATS', s);
            setLine(
              `${s.state} ${s.surfaceWidth}x${s.surfaceHeight} · presented ${s.framesPresented} · ${s.paused ? 'paused' : 'running'} · touches ${s.touchesStarted}/${s.touchesEnded}/${s.touchesCanceled}`,
            );
          } catch (error) {
            report('RNRS_BEVY_STATS', { error: String(error) });
          }
        }, 1000);
      });
    return () => {
      if (timer) clearInterval(timer);
      scene.close();
    };
  }, [scene]);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#222' }}>
      {layout.height > 0 && (
        <View style={{ height: layout.height }} ref={surfaceRef} onLayout={reportSurface}>
          <SurfaceView surfaceKey={scene.surfaceKey()} touchInput="rust" style={{ flex: 1 }} />
          <View style={{ position: 'absolute', left: 8, right: 8, top: 8 }}>
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
          </View>
          <View style={{ position: 'absolute', left: 8, bottom: 8, flexDirection: 'row' }}>
            <Button
              id="pause"
              label={paused ? 'Resume' : 'Pause'}
              onPress={() => {
                scene.setPaused(!paused);
                setPaused(!paused);
              }}
            />
            <Button
              id="color"
              label="Color"
              onPress={() => {
                const next = (color + 1) % COLORS.length;
                scene.setColor(...COLORS[next]);
                setColor(next);
              }}
            />
            <Button
              id="speed"
              label={`Speed ${speed}`}
              onPress={() => {
                const next = speed >= 4 ? 1 : speed + 1;
                scene.setSpeed(next);
                setSpeed(next);
              }}
            />
            <Button id="stall" label="Stall JS" onPress={stall} />
          </View>
        </View>
      )}
      <Text
        style={{
          color: '#ddd',
          fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
          fontSize: 11,
          padding: 12,
        }}
      >
        {status}
      </Text>
    </SafeAreaView>
  );
}
