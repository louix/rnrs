# Counter example

`@rnrs/example-counter` shows a mutable Rust object with synchronous and async
methods. Runs on Android, iOS and in the browser.

```ts
import { counterModule } from '@rnrs/example-counter';

const counter = counterModule().create(0);
try {
  counter.increment(); // 1
  counter.add(4); // 5
  await counter.addLater(2, 100, false); // 7 after 100 ms
  console.log(counter.value());
} finally {
  counter.dispose();
}
```

`addLater(delta, delayMs, uncancellable, { signal })` accepts a delay from 0 to
60,000 ms. With `uncancellable: false`, cancellation while waiting leaves the value
unchanged. With `true`, the addition can still happen after the promise rejects.

## How it works

- The spec declares `Counter` as a `NativeObject`. Rust implements its generated trait and returns `Native<BasicCounter>`, so JavaScript holds a handle to the Rust state.
- Methods use `&self`; a `Mutex<f64>` lets them update the value safely across threads.
- A `Promise` method becomes an async Rust method with a `CancelToken`. `validate_add_later` checks the delay before work starts; the method checks cancellation while waiting.

See the [spec](counter.spec.ts) and [Rust implementation](rust/src/lib.rs).
Start with the [quickstart](../../docs/quickstart.md) for setup.
