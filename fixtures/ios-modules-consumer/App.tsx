// The clean iOS consumer app's only source change: run the http/kv device test and show progress.
import React, { useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, Text } from 'react-native';
import { runIosModulesTest } from './modules';

export default function App() {
  const [status, setStatus] = useState('running…');
  useEffect(() => {
    runIosModulesTest(setStatus);
  }, []);
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text>{status}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}
