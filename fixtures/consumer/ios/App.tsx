// The clean iOS consumer app's only source change: run the device test and show progress.
import React, { useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, Text } from 'react-native';
import { runIosDeviceTest } from './device';

export default function App() {
  const [status, setStatus] = useState('running…');
  useEffect(() => {
    runIosDeviceTest(setStatus);
  }, []);
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text>{status}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}
