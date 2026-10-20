// iOS touch-input harness (docs/surface.md, "Touch input"): a <SurfaceView touchInput="rust">
// on a GPU-free @rnrs/labs-touch-probe surface (nothing is drawn), with a Pressable overlay above
// part of it. The simulator driver (scripts/consumer/ios-touch-sim-test.mjs) injects UIKit
// touches with an XCUITest runner and commands this app through a local HTTP server on the host
// (the simulator shares the host's network). The probe is drained only by the `stats` command:
// nothing consumes touches in the background. JS only: no native file of the app is edited.
//
// Commands: frames (window frames, in points, of the surface and the overlay), stats (drain + JS state), touch-off / touch-on (the touchInput prop), detach /
// attach (surfaceKey 0, then the same key again: a reattach of the same surface), remount
// (closes the probe and its view, creates a new probe: a new surface key).
import React, {useEffect, useRef, useState} from 'react';
import {Pressable, SafeAreaView, Text, View} from 'react-native';
import {SurfaceView} from '@rnrs/surface';
import {touchProbeModule, type Probe} from '@rnrs/labs-touch-probe';

const SERVER = 'http://127.0.0.1:8765';
const RUNTIME = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

async function post(path: string, body: object) {
  try {
    await fetch(`${SERVER}${path}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({runtime: RUNTIME, at: Date.now(), ...body})});
  } catch {
    // No driver: nothing to report to.
  }
}

export default function App(): React.JSX.Element {
  const [probe, setProbe] = useState<Probe | null>(null);
  const [touchInput, setTouchInput] = useState<'none' | 'rust'>('rust');
  const [detached, setDetached] = useState(false);
  const [overlayTaps, setOverlayTaps] = useState(0);
  const surfaceBox = useRef<View>(null);
  const overlay = useRef<View>(null);
  const state = useRef({probe: null as Probe | null, overlayTaps: 0, touchInput: 'rust', detached: false, probes: 0});
  state.current.overlayTaps = overlayTaps;
  state.current.touchInput = touchInput;
  state.current.detached = detached;

  const create = () => {
    const p = touchProbeModule().create();
    state.current.probe = p;
    state.current.probes += 1;
    setProbe(p);
    return p;
  };

  useEffect(() => {
    const p = create();
    void post('/event', {kind: 'ready', surfaceKey: p.surfaceKey()});
    let seq = 0;
    let stopped = false;
    const poll = async () => {
      while (!stopped) {
        let command: {id: number; cmd: string} | null = null;
        try {
          const res = await fetch(`${SERVER}/next?runtime=${RUNTIME}&seq=${seq}`);
          command = res.status === 200 ? await res.json() : null;
        } catch {
          command = null;
        }
        if (command && command.id >= seq) {
          seq = command.id + 1;
          const s = state.current;
          const done = (data: object = {}) => post('/report', {id: command!.id, cmd: command!.cmd, ...data});
          switch (command.cmd) {
            case 'frames': {
              const frame = (ref: React.RefObject<View | null>) => new Promise<number[] | null>(resolve =>
                ref.current ? ref.current.measureInWindow((x, y, w, h) => resolve([x, y, w, h])) : resolve(null));
              await done({surface: await frame(surfaceBox), overlay: await frame(overlay)});
              break;
            }
            case 'stats': {
              const current = s.probe;
              await done({
                surfaceKey: current?.surfaceKey() ?? 0,
                probe: current?.drain() ?? null,
                js: {overlayTaps: s.overlayTaps, touchInput: s.touchInput, detached: s.detached, probes: s.probes},
              });
              break;
            }
            case 'touch-off': setTouchInput('none'); await done(); break;
            case 'touch-on': setTouchInput('rust'); await done(); break;
            case 'detach': setDetached(true); await done(); break;
            case 'attach': setDetached(false); await done(); break;
            case 'remount': {
              const old = s.probe;
              old?.close();
              const final = old?.drain() ?? null; // after close: the closed reset is queued
              const next = create();
              await done({closed: final, surfaceKey: next.surfaceKey()});
              break;
            }
            default:
              await done({error: 'unknown command'});
          }
        } else {
          await new Promise(r => setTimeout(r, 100));
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      state.current.probe?.close();
    };
  }, []);

  const key = probe && !detached ? probe.surfaceKey() : 0;
  return (
    <SafeAreaView style={{flex: 1, backgroundColor: '#202020'}}>
      <Text style={{color: 'white', padding: 8}}>touch probe: {touchInput}{detached ? ' (detached)' : ''}</Text>
      <View ref={surfaceBox} style={{flex: 1, margin: 16}}>
        <SurfaceView key={probe ? probe.surfaceKey() : 0} testID="probe-surface" surfaceKey={key} touchInput={touchInput} style={{flex: 1}} />
        <Pressable ref={overlay} testID="overlay" accessibilityRole="button" onPress={() => setOverlayTaps(n => n + 1)}
          style={{position: 'absolute', left: 0, top: 0, width: 140, height: 90, backgroundColor: '#3060c0'}}>
          <Text style={{color: 'white', padding: 8}}>overlay {overlayTaps}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
