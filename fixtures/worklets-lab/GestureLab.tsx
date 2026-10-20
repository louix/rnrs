// W6 (docs/research/worklets-poc-plan.md): an RNGH Pan gesture on a plain view calls the
// scalar worklet endpoint on each update (UI thread), and a Reanimated useAnimatedReaction
// forwards one SharedValue to Rust as a plain number. Rust never sees a SharedValue.
// Per-event cost is measured in the worklet against an empty worklet doing the same
// arithmetic (diagnostic only: wall time on the UI thread, no bound is claimed).
//
// Error containment: events and reactions can run after the RN runtime's scope is torn down,
// and an uncaught error in these UI-thread worklets is fatal under Reanimated. Every path
// therefore catches, classifies ERR_RNR_CLOSED (expected after teardown) and records any
// other error as unexpected (a test failure); nothing is rethrown or silently dropped.
import React from 'react';
import { View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import { useAnimatedReaction, useSharedValue } from 'react-native-reanimated';
import { isRnrClosedError } from '@rnrs/runtime/worklets';

export interface GestureStats {
  events: number;
  endpointMs: number;
  emptyMs: number;
  probed: boolean;
  /** Events skipped because `endpoint.$open` was false. */
  skippedClosed: number;
  /** ERR_RNR_CLOSED caught in the gesture handler / in the reaction. */
  caughtClosed: number;
  reactionCaughtClosed: number;
  /** Any other error (first 5): a test failure. */
  unexpected: string[];
}

export interface GestureLabProps {
  /** Endpoint with setPointer and scale (worklet endpoint of the probe module). */
  endpoint: any;
  /** Boxed Accumulator counting reactions (a native object captured by worklets). */
  reactions: any;
  /** The W1 routing probe: called once from the first gesture event. */
  probe: (x: number) => number;
  /** Written by the worklets, read by the smoke from the RN runtime. */
  stats: { value: GestureStats };
  /** Set by the smoke: call the endpoint without checking `$open` (forced late calls). */
  control: { value: { bypassOpen: boolean } };
}

// Installed on every worklet runtime by react-native-worklets (not in the RN type lib).
declare const performance: { now(): number };

const REPEAT = 20;

function empty(x: number, y: number): number {
  'worklet';
  return x * 2 + y;
}

function describe(error: unknown): string {
  'worklet';
  const e = error as { code?: unknown; message?: unknown } | null;
  return `${String(e?.code)}: ${String(e?.message ?? error)}`;
}

export function GestureLab({ endpoint, reactions, probe, stats, control }: GestureLabProps) {
  const translationX = useSharedValue(0);
  const pan = usePanGesture({
    onUpdate: (e) => {
      'worklet';
      try {
        if (!control.value.bypassOpen && !endpoint.$open) {
          stats.value = { ...stats.value, skippedClosed: stats.value.skippedClosed + 1 };
          return;
        }
        const t0 = performance.now();
        for (let i = 0; i < REPEAT; i++) endpoint.setPointer(e.x, e.y);
        const t1 = performance.now();
        let sink = 0;
        for (let i = 0; i < REPEAT; i++) sink += empty(e.x, e.y);
        const t2 = performance.now();
        const t = stats.value;
        if (!t.probed) probe(sink);
        stats.value = {
          ...t,
          events: t.events + 1,
          endpointMs: t.endpointMs + (t1 - t0),
          emptyMs: t.emptyMs + (t2 - t1),
          probed: true,
        };
      } catch (error) {
        const t = stats.value;
        stats.value = isRnrClosedError(error)
          ? { ...t, caughtClosed: t.caughtClosed + 1 }
          : {
              ...t,
              unexpected:
                t.unexpected.length < 5 ? [...t.unexpected, describe(error)] : t.unexpected,
            };
      }
      // Drives the reaction, also after teardown (its calls then throw and are caught there).
      translationX.value = e.translationX;
    },
  });
  useAnimatedReaction(
    () => translationX.value,
    (current, previous) => {
      if (previous === null || current === previous) return;
      try {
        endpoint.scale(current, 1);
        reactions.add(1);
      } catch (error) {
        const t = stats.value;
        stats.value = isRnrClosedError(error)
          ? { ...t, reactionCaughtClosed: t.reactionCaughtClosed + 1 }
          : {
              ...t,
              unexpected:
                t.unexpected.length < 5 ? [...t.unexpected, describe(error)] : t.unexpected,
            };
      }
    },
  );
  return (
    <GestureDetector gesture={pan}>
      <View style={{ flex: 1, backgroundColor: '#dde6f5' }} />
    </GestureDetector>
  );
}
