// Scheduler probe app: runs the probe and reports it (RNRS_SMOKE), like the clean consumer.
import React, { useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, Text } from 'react-native';
import { runSmoke } from './smoke';

export default function App() {
  const [status, setStatus] = useState('running…');
  useEffect(() => {
    runSmoke()
      .then((result) => {
        console.log('RNRS_SMOKE ' + JSON.stringify(result));
        setStatus(JSON.stringify(result, null, 2));
      })
      .catch((error) => {
        console.log(
          'RNRS_SMOKE ' + JSON.stringify({ ok: false, checks: [], error: String(error) }),
        );
        setStatus(String(error));
      });
  }, []);
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text>{status}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}
