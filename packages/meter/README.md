# Native objects example

`@rnrs/labs-meter` shows how to pass Rust objects to module and object methods.
Runs on Android, iOS and in the browser.

```ts
import { meterModule } from '@rnrs/labs-meter';

const meter = meterModule();
const a = meter.gauge(2);
const b = meter.gauge(5);
const combined = meter.combine(a, b);
try {
  a.set(3);
  console.log(a.get()); // 3
  console.log(combined.get()); // 7
} finally {
  a.dispose();
  b.dispose();
  combined.dispose();
}
```

`combine` creates a new gauge with the sum of two readings; `maxWith` creates
one with the larger reading. Both leave their inputs unchanged. `gaugeLater`
returns a gauge asynchronously.

## How it works

- `Gauge extends NativeObject` becomes a Rust trait. `type GaugeImpl = Reading` selects the Rust implementation returned by the module.
- `Native<Reading>` arguments refer to the same objects JavaScript holds. `combine` reads both gauges and returns a new `Native<Reading>`; it does not copy or mutate the inputs.
- `gaugeLater` returns the same handle type from an async Rust method. The generated wrapper turns its result into a JavaScript gauge.

See the [spec](meter.spec.ts) and [Rust implementation](rust/src/lib.rs).
The [headless module tutorial](../../docs/headless.md) walks through a similar example.
