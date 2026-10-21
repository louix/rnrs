// Globals that React Native (Hermes) provides but its own type declarations do not, for the
// lab's typecheck (lib ES2022 only). TypeScript 5.9 found them in a transitively installed
// @types/node; TypeScript 6 no longer includes @types packages unless listed.
declare var performance: { now(): number };
declare function queueMicrotask(callback: () => void): void;
