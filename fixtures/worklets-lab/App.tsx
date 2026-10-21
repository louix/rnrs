// Worklets lab app: runs the staged checks in smoke.ts
// and logs one RNRS_WORKLETS line. JS only; the native trees are the RN 0.88.0 template's.
import React, { useEffect, useState } from 'react';
import { SafeAreaView, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { runtimeBindings } from '@rnrs/runtime/testing';
import { GestureLab, type GestureLabProps } from './GestureLab';
import { onGestureLab, runWorkletsSmoke } from './smoke';

// Logcat truncates long lines (about 4 KB): the result goes out in numbered chunks,
// "RNRS_WORKLETS <run> <i>/<n> <text>", reassembled by scripts/consumer/worklets-device-test.mjs.
function report(result: unknown) {
  const text = JSON.stringify(result);
  const run = Date.now().toString(36);
  const size = 3000;
  const n = Math.max(1, Math.ceil(text.length / size));
  for (let i = 0; i < n; i++)
    console.log(`RNRS_WORKLETS ${run} ${i + 1}/${n} ${text.slice(i * size, (i + 1) * size)}`);
}

export default function App() {
  const [status, setStatus] = useState('running…');
  const [lab, setLab] = useState<GestureLabProps | null>(null);
  useEffect(() => onGestureLab(setLab), []);
  useEffect(() => {
    runWorkletsSmoke()
      .then((result) => {
        report(result);
        setStatus(JSON.stringify(result, null, 2));
        // W5: reload with the UI-runtime calls still running (test-hooks build only).
        if (result.reload) (runtimeBindings() as any).reloadForTesting();
      })
      .catch((error) => {
        report({ ok: false, checks: [], error: String(error) });
        setStatus(String(error));
      });
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1 }}>
        <Text numberOfLines={3} style={{ padding: 8 }}>
          {status.slice(0, 300)}
        </Text>
        <View style={{ flex: 1 }}>{lab && <GestureLab {...lab} />}</View>
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}
