import React, { useEffect, useRef, useState } from 'react';
import { Button, SafeAreaView, ScrollView, Text } from 'react-native';
import { runRnrPrototype } from './rnrAndroid';

export default function App() {
  const [status, setStatus] = useState('Waiting for startup to settle…');
  const [running, setRunning] = useState(false);
  const active = useRef(false);
  async function run() {
    if (active.current) return;
    active.current = true;
    setRunning(true);
    try {
      await runRnrPrototype(setStatus);
    } catch (error) {
      setStatus(String(error));
      console.error(error);
    } finally {
      active.current = false;
      setRunning(false);
    }
  }
  // Startup deliberately runs once; rerenders must not restart it.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    const timer = setTimeout(run, 500);
    return () => {
      clearTimeout(timer);
      console.log(`rnr: surface unmounted at ${Date.now()}`);
    };
  }, []);
  /* oxlint-enable react-hooks/exhaustive-deps */
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#101820' }}>
      <ScrollView contentContainerStyle={{ padding: 28 }}>
        <Text style={{ color: '#ffffff', fontSize: 24, marginBottom: 20 }}>
          Rust ownership and lifecycle tests
        </Text>
        <Text style={{ color: '#e0e8ef', fontSize: 15, marginBottom: 24 }}>{status}</Text>
        <Button title="Run framework checks" disabled={running} onPress={run} />
      </ScrollView>
    </SafeAreaView>
  );
}
