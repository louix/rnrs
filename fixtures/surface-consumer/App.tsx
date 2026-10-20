// Clean consumer app for the surface prototype: the only source change to the RN template.
// Runs the milestone 1 lifecycle sequence (smoke.ts), logs `RNR_SMOKE <json>`, then stays in a
// steady state logging `RNR_SURFACE_STATS <json>` every second so a device script can drive
// background/foreground and reload and compare counters. A TSX overlay is drawn above the
// surface to show SurfaceView composition.
import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, ScrollView, Text, View } from 'react-native';
import { SurfaceView } from '@rnrs/surface';
import { createRenderers, runSmoke, startFrames, type Scene } from './smoke';

export default function App() {
  const renderers = useMemo(() => createRenderers(), []);
  const [scene, setScene] = useState<Scene>({ label: 'starting', views: [] });
  const [status, setStatus] = useState('running…');
  useEffect(() => {
    const frames = startFrames(renderers);
    let timer: ReturnType<typeof setInterval> | undefined;
    runSmoke(renderers, setScene)
      .then((result) => {
        // logcat truncates lines near 4 KB: one line per check detail, then a compact summary.
        result.checks.forEach((c, i) =>
          console.log('RNR_SMOKE_CHECK ' + JSON.stringify({ i, ...c })),
        );
        console.log('RNR_SMOKE_SAMPLES ' + JSON.stringify(result.samples));
        console.log(
          'RNR_SMOKE ' +
            JSON.stringify({
              ok: result.ok,
              checks: result.checks.map((c) => ({ name: c.name, ok: c.ok })),
            }),
        );
        setStatus(result.checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`).join('\n'));
      })
      .catch((error) => {
        console.log('RNR_SMOKE ' + JSON.stringify({ ok: false, checks: [], error: String(error) }));
        setStatus(String(error));
      })
      .finally(() => {
        timer = setInterval(() => {
          try {
            console.log(
              'RNR_SURFACE_STATS ' +
                JSON.stringify({ submitted: frames.submitted(), A: renderers.A.stats() }),
            );
          } catch (error) {
            console.log('RNR_SURFACE_STATS ' + JSON.stringify({ error: String(error) }));
          }
        }, 1000);
      });
    return () => {
      frames.stop();
      if (timer) clearInterval(timer);
    };
  }, [renderers]);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#222' }}>
      {scene.views.map((v) => (
        <View key={v.id} style={{ height: v.height, marginBottom: 4 }}>
          <SurfaceView surfaceKey={renderers[v.renderer].surfaceKey()} style={{ flex: 1 }} />
          <Text
            style={{
              position: 'absolute',
              right: 8,
              top: 8,
              color: 'white',
              backgroundColor: '#0008',
              padding: 4,
            }}
          >
            {`TSX overlay · ${v.renderer} · ${scene.label}`}
          </Text>
        </View>
      ))}
      <ScrollView contentContainerStyle={{ padding: 12 }}>
        <Text style={{ color: '#ddd', fontFamily: 'monospace', fontSize: 11 }}>{status}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}
