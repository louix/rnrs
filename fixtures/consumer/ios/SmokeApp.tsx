// App.tsx of the iOS smoke consumer (RNRS_IOS_FIXTURE=smoke in scripts/consumer/ios-app.sh): runs
// the fixture's runSmoke() and reports it for scripts/consumer/ios-smoke-sim-test.mjs as
// `RNRS_SMOKE <i>/<n> <chunk>` lines. console.error, because release builds forward only errors
// to os_log; chunks, because os_log truncates long messages.
import React, { useEffect, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { runSmoke } from './smoke';

const CHUNK = 700;
function report(result: unknown) {
  const text = JSON.stringify(result);
  const n = Math.max(1, Math.ceil(text.length / CHUNK));
  for (let i = 0; i < n; i++)
    console.error(`RNRS_SMOKE ${i + 1}/${n} ${text.slice(i * CHUNK, (i + 1) * CHUNK)}`);
}

export default function App() {
  const [status, setStatus] = useState('running…');
  useEffect(() => {
    runSmoke()
      .catch((error: unknown) => ({ ok: false, checks: [], error: String(error) }))
      .then((result) => {
        report(result);
        setStatus(JSON.stringify(result, null, 2));
      });
  }, []);
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 64 }}>
      <Text>{status}</Text>
    </ScrollView>
  );
}
