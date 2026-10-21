// Clean consumer app for the rnrs wgpu adapter: one Rust triangle (@rnrs/labs-webgpu-triangle)
// in an @rnrs/surface view, the only source change to the RN template. Logs
// `RNR_TRIANGLE_STATS <json>` every second (with the number of background changes requested) so
// a device script can drive background, rotation and restart (Android: logcat; iOS: release
// builds forward only console.error to os_log, so the line is an error there).
import React, { useEffect, useMemo } from 'react';
import { Platform, SafeAreaView, Text, View } from 'react-native';
import { SurfaceView } from '@rnrs/surface';
import { webgpuTriangleModule } from '@rnrs/labs-webgpu-triangle';
import { cycleBackground } from './smoke';

const report = Platform.OS === 'ios' ? console.error : console.log;

export default function App() {
  const triangle = useMemo(() => webgpuTriangleModule().create(), []);
  useEffect(() => {
    const stop = cycleBackground(triangle);
    let changes = 0;
    const counter = setInterval(() => changes++, 1000);
    const log = setInterval(() => {
      try {
        report('RNR_TRIANGLE_STATS ' + JSON.stringify({ changes, ...triangle.stats() }));
      } catch (error) {
        report('RNR_TRIANGLE_STATS ' + JSON.stringify({ error: String(error) }));
      }
    }, 1000);
    return () => {
      stop();
      clearInterval(counter);
      clearInterval(log);
    };
  }, [triangle]);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#222' }}>
      <View style={{ flex: 1 }}>
        <SurfaceView surfaceKey={triangle.surfaceKey()} style={{ flex: 1 }} />
      </View>
      <Text style={{ color: '#ddd', padding: 12 }}>rnrs::gpu triangle</Text>
    </SafeAreaView>
  );
}
