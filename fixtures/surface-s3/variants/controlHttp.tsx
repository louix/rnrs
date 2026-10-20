// C1 S3 run 3, reload-crash controls D1, D3 and D4 (docs/research/ios-surface-c1-design.md): no
// surface and no renderer (vello2d is not imported), the same HTTP command transport as the S3
// harness (../App.tsx), reloads through the RnrRuntime test hook. Bundled as the app's
// App.tsx by scripts/consumer/ios-bundle-variant.sh; driven by
// scripts/consumer/ios-s3-sim-test.mjs --mode control-http.
//
// Every runtime (each reload starts a new one) makes its first request right after mount, as
// the S3 harness does, except with firstFetchDelayMs (D4: 2 s after mount).
//
// quiesce false (D1): the reload is requested while the poll loop and the periodic stats posts
// keep running, as in the S3 harness, so a request may be in flight at the reload.
// quiesce true (D3): before the reload, in the old runtime, the poll loop and the stats posts
// stop and every request this runtime started has settled, then 1 s passes with none in flight
// (the new runtime still fetches right after mount).
// Limitation: React Native's own reload, DevSettings.reload, is a no-op in a Release build (the
// JS module is a stub without __DEV__; RCTDevSettings is the empty variant without
// RCT_DEV_MENU). The hook calls RCTTriggerReloadCommandListeners, as the Debug DevSettings.reload
// does, so the hook and React Native's reload cannot be told apart on this binary.
import React, {useEffect} from 'react';
import {AppState, SafeAreaView, Text} from 'react-native';
import {runtimeBindings} from '@rnrs/runtime/testing';

const SERVER = 'http://127.0.0.1:8765';
const RUNTIME = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

export function controlApp(variant: string, {quiesce = false, firstFetchDelayMs = 0}: {quiesce?: boolean; firstFetchDelayMs?: number} = {}) {
  let inFlight = 0;
  let settled: (() => void)[] = [];
  const track = async <T,>(f: () => Promise<T>): Promise<T> => {
    inFlight++;
    try {
      return await f();
    } finally {
      inFlight--;
      if (inFlight === 0) settled.splice(0).forEach(r => r());
    }
  };
  const idle = () => (inFlight === 0 ? Promise.resolve() : new Promise<void>(r => settled.push(r)));
  const post = (path: string, body: object) =>
    track(async () => {
      try {
        await fetch(`${SERVER}${path}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({runtime: RUNTIME, variant, at: Date.now(), ...body})});
      } catch {
        // No driver: nothing to report to.
      }
    });

  return function App() {
    useEffect(() => {
      const mounted = Date.now();
      let seq = 0;
      let stopped = false;
      let periodic: ReturnType<typeof setInterval> | undefined;
      const snapshot = () => ({variant, appState: AppState.currentState, inFlight});
      const poll = async () => {
        if (firstFetchDelayMs > 0) await new Promise<void>(r => setTimeout(r, firstFetchDelayMs));
        if (stopped) return;
        void post('/event', {kind: 'runtime-start', firstFetchDelayMs, firstFetchAfterMs: Date.now() - mounted});
        periodic = setInterval(() => void post('/stats', {snapshot: snapshot()}), 1000);
        while (!stopped) {
          let command: {id: number; cmd: string} | null = null;
          try {
            const res = await track(() => fetch(`${SERVER}/next?runtime=${RUNTIME}&seq=${seq}`));
            command = res.status === 200 ? await res.json() : null;
          } catch {
            command = null;
          }
          if (command && command.id >= seq) {
            seq = command.id + 1;
            const done = (data: object = {}) => post('/report', {id: command!.id, cmd: command!.cmd, ...data});
            if (command.cmd === 'stats') {
              await done({snapshot: snapshot()});
            } else if (command.cmd === 'reload') {
              await done({snapshot: snapshot(), quiesce});
              if (quiesce) {
                stopped = true;
                clearInterval(periodic);
                await idle();
                await new Promise<void>(r => setTimeout(r, 1000));
                console.log(`RNR-D3 reload runtime=${RUNTIME} inFlight=${inFlight}`);
              }
              runtimeBindings().reloadForTesting!();
            } else {
              await done({error: 'unknown command'});
            }
          }
          await new Promise<void>(r => setTimeout(r, 250));
        }
      };
      void poll();
      return () => {
        stopped = true;
        clearInterval(periodic);
      };
    }, []);
    return (
      <SafeAreaView style={{flex: 1, backgroundColor: '#000'}}>
        <Text style={{marginTop: 40, marginLeft: 8, color: '#9ab', fontSize: 12}}>{`S3 control ${variant} ${RUNTIME}`}</Text>
      </SafeAreaView>
    );
  };
}
