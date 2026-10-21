# Build a headless module

This module returns Rust objects to JS and accepts them back as arguments. Its counters are
immutable: `add` and `combine` return **new** counters and leave the originals unchanged. The same
Rust code runs on Android, iOS and in the browser. Start with the [tools](setup.md#tools).

## Create the module

In a new directory:

```sh
echo '{"name":"@demo/counter","private":true}' > package.json
npm exec --package=@rnrs/cli -- rnrs init
npm install
```

For a local framework checkout, install the archives as described in
[local framework packages](setup.md#local-framework-packages).

Replace `counter.spec.ts` with:

```ts
import type { NativeModule, NativeObject } from '@rnrs/runtime/spec';

/** An immutable counter. `add` and `combine` return new counters. */
export interface Counter extends NativeObject {
  value(): number;
  /** A new counter holding this value plus `delta`. This counter is unchanged. */
  add(delta: number): Counter;
  /** A new counter holding the sum of both values. Neither counter changes. */
  combine(other: Counter): Counter;
}

export interface CounterModule extends NativeModule {
  create(initial: number): Counter;
}
```

- `Counter extends NativeObject`, so JS holds a handle to a Rust value instead of a copy.
- `add` and `combine` return a `Counter`, and `combine` takes one as an argument. Object methods can take and return their own type; module methods can take and return any of the spec's native objects.
- Numbers are always `f64`.

## Implement it in Rust

Run `npx rnrs generate`. It writes `rust/src/rnrs_interface.rs`, which contains these traits:

```rust
pub trait Counter: NativeObject {
    fn value(&self) -> Result<f64, String>;
    fn add(&self, delta: f64) -> Result<Native<Self>, String>;
    fn combine(&self, other: Native<Self>) -> Result<Native<Self>, String>;
}

pub trait CounterModule: NativeObject + Default {
    type CounterImpl: Counter;
    fn create(&self, initial: f64) -> Result<Native<Self::CounterImpl>, String>;
}
```

Replace `rust/src/lib.rs` with:

```rust
use rnrs::Native;

pub mod rnrs_interface;
use rnrs_interface as spec;

#[derive(Default)]
pub struct Module;

impl spec::CounterModule for Module {
    type CounterImpl = Counter;

    fn create(&self, initial: f64) -> Result<Native<Counter>, String> {
        Ok(Counter::new(initial))
    }
}

/// Never changes after creation; `add` and `combine` build new counters.
pub struct Counter {
    value: f64,
}

impl Counter {
    fn new(value: f64) -> Native<Counter> {
        Native::new(Counter { value })
    }
}

impl spec::Counter for Counter {
    fn value(&self) -> Result<f64, String> {
        Ok(self.value)
    }

    fn add(&self, delta: f64) -> Result<Native<Counter>, String> {
        Ok(Counter::new(self.value + delta))
    }

    fn combine(&self, other: Native<Counter>) -> Result<Native<Counter>, String> {
        Ok(Counter::new(self.value + other.value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use spec::{Counter as _, CounterModule as _};

    #[test]
    fn add_and_combine_return_new_counters() {
        let a = Module.create(1.0).unwrap();
        let b = a.add(2.0).unwrap();
        let c = a.combine(b.clone()).unwrap();
        assert_eq!(a.value(), Ok(1.0));
        assert_eq!(b.value(), Ok(3.0));
        assert_eq!(c.value(), Ok(4.0));
    }
}
```

- **One object type.** `type CounterImpl = Counter` tells the module which Rust type implements the
  spec's `Counter`. In the object's own trait that type is `Self`, so `Native<Self>` and
  `Native<Counter>` are the same.
- **`Native<T>`** is a reference-counted handle. Returning `Native::new(...)` gives JS a new object.
  Receiving one, as `other` in `combine`, gives Rust a reference to the object JS passed, not a
  copy; read it through the handle (`other.value`).
- **Threads.** On Android and iOS, native objects must be `Send + Sync`, because async calls and
  finalizers can reach them from other threads. Immutable fields such as an `f64` already are. For
  state that changes in place, the [`counter` example package](../packages/counter) uses a `Mutex`.
- **Errors.** `Err(String)` throws in JS. Panics abort the process.

Run the Rust test, check the package and create the archive:

```sh
npx rnrs test
npx rnrs check
npm pack                # → demo-counter-0.1.0.tgz
```

## Use it from JS

```ts
import { counterModule } from '@demo/counter';

const a = counterModule().create(1);
const b = a.add(2);       // a new counter holding 3; a still holds 1
const c = a.combine(b);   // a new counter holding 4; a and b are unchanged

a.dispose();
b.dispose();
c.dispose();
```

- `counterModule()` returns the runtime's single module instance; there is nothing to create or close.
- Every call that returns a `Counter` creates a handle. Call `dispose()` on each one when you are done,
  including results. Garbage collection releases forgotten handles only eventually, as a fallback.
  Chaining (`a.add(1).add(2)`) leaves the intermediate handle for garbage collection.
- Using a handle after `dispose()` throws `Counter is disposed`.

## Use it in React Native

The app installs `@rnrs/runtime` and the module archive, then builds as described in
[setup](setup.md#use-a-module-in-an-app):

```sh
npm install @rnrs/runtime /absolute/path/to/demo-counter-0.1.0.tgz
```

This component keeps the current counter in a ref. Each press replaces it with a new counter and
disposes the old one; unmounting disposes the last.

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { Button, Text, View } from 'react-native';
import { counterModule, type Counter } from '@demo/counter';

export function CounterView() {
  const counter = useRef<Counter | null>(null);
  const [value, setValue] = useState<number | null>(null);

  useEffect(() => {
    const initial = counterModule().create(0);
    counter.current = initial;
    setValue(initial.value());
    return () => {
      counter.current?.dispose();
      counter.current = null;
    };
  }, []);

  const add = (delta: number) => {
    const current = counter.current;
    if (!current) return;
    const next = current.add(delta);   // a new counter; current is unchanged
    current.dispose();
    counter.current = next;
    setValue(next.value());
  };

  return (
    <View>
      <Text>{value ?? '…'}</Text>
      <Button title="+1" onPress={() => add(1)} />
    </View>
  );
}
```

Create native objects in effects and event handlers, not during rendering.

## Use it in the browser

In a fresh app directory:

```sh
echo '{"name": "web-app", "private": true, "type": "module", "devDependencies": {"vite": "6.4.4"}}' > package.json
npm install @rnrs/runtime /absolute/path/to/demo-counter-0.1.0.tgz
```

For local framework testing, install the runtime, CLI and module archives in one `npm install`
command instead.

`index.html`:

```html
<!doctype html>
<pre id="out"></pre>
<script type="module" src="./main.ts"></script>
```

`main.ts` initializes the Rust bundle once, before any module call:

```ts
import { initRnrs } from '@rnrs/runtime/web';
import * as bundle from './.rnrs/web/pkg/rnrs_bundle.js';
import { counterModule } from '@demo/counter';

initRnrs(bundle).then(() => {
  const a = counterModule().create(1);
  const b = a.add(2);       // a new counter; a still holds 1
  const c = a.combine(b);   // another new counter; a and b are unchanged
  document.getElementById('out')!.textContent = `a=${a.value()} b=${b.value()} c=${c.value()}`;
  a.dispose();
  b.dispose();
  c.dispose();
}).catch((error) => {
  document.getElementById('out')!.textContent = String(error);
});
```

Build the Rust bundle, then the app:

```sh
npx rnrs build --target web --app .
npx vite build
npx vite preview
```

The page shows `a=1 b=3 c=4`.

## Next

- [Generator reference](generator.md): records, unions, buffers, async methods and every supported type.
- [Ownership](ownership.md): disposal, cancellation, back-pressure and runtime reloads.
- [Example modules](support.md#example-modules): `counter` adds a mutable counter with a cancellable async method; `meter` passes objects to module methods.
