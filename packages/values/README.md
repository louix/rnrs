# Value types example

`@rnrs/labs-values` shows how to pass records, arrays, tagged unions, dictionaries,
buffers and JSON between TypeScript and Rust. Runs on Android, iOS and in the browser.

```ts
import { valuesModule } from '@rnrs/labs-values';

const values = valuesModule();
const point = values.echoPoint({ x: 2, y: 3 });
const area = values.area({ kind: 'circle', radius: 4 });
const counts = values.echoCounts({ apples: 3, pears: 2 });
const bytes = values.echoBytes(new Uint8Array([1, 2, 3]).buffer);
```

The [spec](values.spec.ts) pairs each type with methods that accept or return it.
The [Rust implementation](rust/src/lib.rs) uses the generated structs and enums.

- `Labeled` shows optional and nullable fields; `Shape` shows a tagged union.
- `Inventory` combines nested dictionaries and `JsonValue`.
- `Bag`, `Database` and `Statement` show native objects inside other values. The database objects are in-memory examples, with no SQL execution or persistence.
- `lookup` and `limitedSum` use `Throws<Result, Error>` for typed errors, exposed as `DomainError.data` in JavaScript.

## How it works

- The generator maps records to Rust structs, tagged unions to enums, arrays to `Vec<T>` and dictionaries to `BTreeMap<String, T>`. Methods use these types directly.
- Optional and nullable fields both use Rust `Option<T>`, but preserve different JavaScript APIs: an optional field may be absent; a nullable field uses `null`.
- `Throws<T, E>` becomes `Result<T, E>`. Returning `Err` throws or rejects with a `DomainError` whose `data` contains the declared error value.

See the [type map](../../docs/types.md) for conversion rules and the
[quickstart](../../docs/quickstart.md) for setup.
