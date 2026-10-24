// The benchmark app's only source change to the RN 0.88 template: run the comparison harness
// once per process and show its status.
import React, { useEffect, useState } from 'react';
import { SafeAreaView, Text } from 'react-native';
import { runHarness } from './harness';

export default function App() {
  const [status, setStatus] = useState('starting');
  useEffect(() => {
    runHarness(setStatus);
  }, []);
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Text style={{ padding: 16 }}>{status}</Text>
    </SafeAreaView>
  );
}
