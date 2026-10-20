// The fresh Expo consumer's only source change (scripts/consumer/expo-app.sh): call the counter
// module through the framework runtime and report it as `RNR_SMOKE <i>/<n> <chunk>` lines
// (scripts/consumer/ios-smoke-sim-test.mjs). console.error, because release builds forward it
// to os_log (and Android's logcat); chunks, because os_log truncates long messages.
import React, { useEffect, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { counterModule } from '@rnrs/example-counter';

async function runCounter() {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  async function check(name: string, body: () => Promise<string> | string) {
    try {
      checks.push({ name, ok: true, detail: await body() });
    } catch (error) {
      checks.push({ name, ok: false, detail: String((error as Error)?.message ?? error) });
    }
  }
  await check('counter: sync add', () => {
    const c = counterModule().create(1.5);
    const value = c.add(1);
    c.dispose();
    if (value !== 2.5) throw new Error(`add returned ${value}`);
    return String(value);
  });
  await check('counter: async addLater', async () => {
    const c = counterModule().create(1.5);
    const value = await c.addLater(2, 5, false);
    c.dispose();
    if (value !== 3.5) throw new Error(`addLater returned ${value}`);
    return String(value);
  });
  return { ok: checks.every((c) => c.ok), checks };
}

export default function App() {
  const [status, setStatus] = useState('running…');
  useEffect(() => {
    runCounter()
      .catch((error) => ({ ok: false, checks: [], error: String(error) }))
      .then((result) => {
        const text = JSON.stringify(result);
        const n = Math.max(1, Math.ceil(text.length / 700));
        for (let i = 0; i < n; i++)
          console.error(`RNR_SMOKE ${i + 1}/${n} ${text.slice(i * 700, (i + 1) * 700)}`);
        setStatus(JSON.stringify(result, null, 2));
      });
  }, []);
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 64 }}>
      <Text>{status}</Text>
    </ScrollView>
  );
}
