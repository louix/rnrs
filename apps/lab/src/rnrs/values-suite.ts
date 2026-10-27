// Shared value-conversion suite for the generated Values module
// (packages/values/values.spec.ts), run unchanged on Android (JSI) and in the browser
// (Wasm). Both backends share one generated conversion implementation; this checks that
// they also agree on the observable JS behaviour.
import {
  Bag,
  Shader,
  Statement,
  createValuesModuleForTesting,
  isLookupError,
  isOverflow,
  valuesModule,
  type Event,
  type LookupError,
  type Labeled,
  type Shape,
  type Tagged,
} from '../../../../.generated/rnrs/values';
import { createModuleForTesting } from '../../../../packages/runtime/src/runtime';
import { workletEndpoint } from '../../../../packages/runtime/src/worklets';
import type { CheckResult } from './conformance';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
class CheckFailure extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailure(message);
}
function throws(fn: () => unknown, expected: string | RegExp): void {
  try {
    fn();
  } catch (error) {
    const text = String(error);
    const ok = typeof expected === 'string' ? text === expected : expected.test(text);
    expect(ok, `wrong error: ${text} (expected ${expected})`);
    return;
  }
  throw new CheckFailure(`expected throw: ${expected}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Key-order-insensitive comparison (Rust returns Record and JsonValue objects in key order). */
const sorted = (x: unknown): unknown =>
  Array.isArray(x)
    ? x.map(sorted)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, sorted((x as any)[k])]),
        )
      : x;
const sameEntries = (a: unknown, b: unknown) => same(sorted(a), sorted(b));

export interface ValuesEnv {
  /** Best-effort forced GC plus a turn for finalizers. */
  collectGarbage(): Promise<void>;
  /** Android test hook: ArrayBuffer results take the engine-refused copy fallback. The
   *  check then also patches the ArrayBuffer/Uint8Array globals (in the browser the
   *  wasm-bindgen glue itself looks those up, so they are left alone there). */
  forceBytesCopyOut?(force: boolean): void;
  /** Native (Android/iOS) test hook: number[] results throw mid-fill, before the prototype is restored. */
  failNumberFill?(fail: boolean): void;
  /** Browser: grows the bundle's Wasm memory by one page (detaching its old buffer). */
  growWasmMemory?(): void;
}

export async function runValuesSuite(env: ValuesEnv): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const v = valuesModule();
  async function check(name: string, body: () => Promise<string | void> | string | void) {
    const start = now();
    try {
      const detail = (await body()) ?? '';
      results.push({ name: `values: ${name}`, ok: true, ms: now() - start, detail });
    } catch (error) {
      results.push({
        name: `values: ${name}`,
        ok: false,
        ms: now() - start,
        detail: String(error instanceof Error ? error.message : error),
      });
    }
  }

  await check('numbers are f64: NaN, -0, ±Infinity, extremes', () => {
    for (const x of [
      0,
      -0,
      1.5,
      -1e308,
      Number.MIN_VALUE,
      Number.MAX_SAFE_INTEGER + 2,
      Infinity,
      -Infinity,
    ]) {
      expect(Object.is(v.echoNumber(x), x), `echo ${x}`);
    }
    expect(Number.isNaN(v.echoNumber(NaN)), 'NaN');
    expect(v.echoBool(true) === true && v.echoBool(false) === false, 'booleans');
    throws(() => v.echoNumber('1' as any), 'TypeError: x must be a number, got a string');
    throws(() => v.echoBool(0 as any), 'TypeError: b must be a boolean, got a number');
    throws(
      () => v.echoNumber(10n as any),
      'TypeError: x must be a number, got an unsupported value',
    );
  });

  await check('scalar wrappers preserve receivers, arity, errors and closed admission', () => {
    const other = createValuesModuleForTesting(4);
    const echo = other.echoNumber;
    expect(echo.call(v, 7) === 7, 'borrowed receiver selects receiving module');
    let detachedThrew = false;
    try {
      echo(7);
    } catch {
      detachedThrew = true;
    }
    expect(detachedThrew, 'detached method still fails');
    throws(() => (v.echoNumber as any)(), 'TypeError: x must be a number, got undefined');
    expect((v.echoNumber as any)(-0, 'extra') === 0, 'extra arguments ignored');
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    let before: unknown;
    try {
      v.echoNumber(revoked.proxy as any);
    } catch (e) {
      before = e;
    }
    expect(before instanceof Error, 'invalid proxy follows error path');
    other.teardown();
    throws(() => other.echoNumber(1), 'Error: runtime adapter is closed');
    throws(() => other.echoNumber('bad' as any), 'Error: runtime adapter is closed');
    throws(() => (other.echoNumber as any)(), 'Error: runtime adapter is closed');
    throws(() => other.echoNumber(revoked.proxy as any), 'Error: runtime adapter is closed');
    expect(echo.call(v, 9) === 9, 'borrowed method from closed module uses live receiver');
  });

  await check('prepared scalar entries: Rust errors, NaN results and closed admission', () => {
    // Browser: every prepared entry is the Rust scalar leaf's entry, not the bound generic
    // positional call it falls back to (both raise the same errors, so check which runs).
    if ((globalThis as any).__rnrsRuntime === undefined) {
      const host = (v as any).host;
      const direct = (v.constructor as any).descriptor.direct as number[][];
      const generic = direct.filter(([index]) => host[`m${index}`].name.startsWith('bound '));
      expect(direct.length >= 3 && generic.length === 0, `generic entries: ${generic}`);
    }
    expect(v.checkedDivide(7, 2) === 3.5, 'value');
    throws(() => v.checkedDivide(1, 0), 'Error: division by zero');
    throws(() => v.checkedDivide(1, -0), 'Error: division by zero');
    // A NaN result right after a failure is a value: no error is left behind.
    expect(Number.isNaN(v.checkedDivide(NaN, 1)), 'NaN result after an error');
    expect(Number.isNaN(v.checkedDivide(0, NaN)), 'NaN divisor is not zero');
    expect(Object.is(v.checkedDivide(-0, 5), -0), '-0 result');
    let caught: unknown;
    try {
      v.checkedDivide(2, 0);
    } catch (error) {
      caught = error;
    }
    expect(
      caught instanceof Error && caught.constructor === Error,
      `a plain Error: ${Object.prototype.toString.call(caught)} ${(caught as any)?.constructor?.name}`,
    );
    throws(() => v.checkedDivide('1' as any, 0), 'TypeError: a must be a number, got a string');
    throws(() => (v.checkedDivide as any)(1), 'TypeError: b must be a number, got undefined');
    const t = createValuesModuleForTesting(4);
    throws(() => t.checkedDivide(1, 0), 'Error: division by zero');
    expect(t.checkedDivide(9, 3) === 3, 'other module after an error');
    t.teardown();
    throws(() => t.checkedDivide(1, 1), 'Error: runtime adapter is closed');
    throws(() => t.checkedDivide(1, 0), 'Error: runtime adapter is closed');
    throws(() => t.checkedDivide('1' as any, 0), 'Error: runtime adapter is closed');
    expect(v.checkedDivide(8, 2) === 4, 'other modules unaffected');
  });

  await check('prepared scalar entries: subclasses, object arguments, fabricated hosts', () => {
    // Subclass instances route through their own host like any module instance.
    const Values = v.constructor as new (host: unknown) => typeof v;
    class Sub extends Values {}
    const sub = new Sub((v as any).host);
    expect(sub.echoNumber(3) === 3 && sub.echoBool(true) === true, 'subclass instance');
    // Object arguments take the error path, whose kind check reads the host's helpers.
    throws(() => v.echoNumber({} as any), 'TypeError: x must be a number, got an object');
    throws(() => v.echoNumber([] as any), 'TypeError: x must be a number, got an array');
    throws(
      () => v.echoBool(new Proxy({}, {}) as any),
      'TypeError: b must be a boolean, got an object',
    );
    // A fabricated (unsupported) host: the valid path never reads it; on the error path its
    // traps may throw, re-enter or tear the module down, and the call still only throws.
    // JSI entries are host functions reading the helpers from `this`; the browser's entries
    // are bound Wasm calls that never read the host.
    const jsi = (globalThis as any).__rnrsRuntime !== undefined;
    const t = createValuesModuleForTesting(4);
    let mode: 'throw' | 'reenter' | 'teardown' = 'throw';
    const reads = { throw: 0, reenter: 0, teardown: 0 };
    let reentered = false;
    let nested = '';
    const host = new Proxy((t as any).host, {
      get(target, key) {
        if (key === 'rnrs:helpers') {
          reads[mode]++;
          if (mode === 'throw') throw new Error('trap');
          if (mode === 'reenter') {
            reentered = v.echoNumber(2) === 2 && t.echoNumber(5) === 5;
            // A nested error-path call (its own generic reader) inside this one's.
            try {
              t.echoNumber({} as any);
            } catch (error) {
              nested = String(error);
            }
          }
          if (mode === 'teardown') t.teardown();
        }
        return Reflect.get(target, key);
      },
    });
    const echo = (Object.getPrototypeOf(v) as typeof v).echoNumber;
    const fake = { host } as unknown as typeof v;
    expect(echo.call(fake, 4) === 4, 'valid call through a fabricated host');
    for (mode of ['throw', 'reenter', 'teardown'] as const)
      throws(() => echo.call(fake, {} as any), /^TypeError: x must be a number, got /);
    const counts = JSON.stringify(reads);
    if (jsi) {
      // Each mode reads at least once; a throwing read is retried when the error text is built.
      expect(reads.throw >= 1 && reads.reenter >= 1 && reads.teardown >= 1, `reads ${counts}`);
      expect(reentered, 'calls re-entered from the error path succeed');
      expect(
        nested === 'TypeError: x must be a number, got an object',
        `nested error-path call: ${nested}`,
      );
    } else {
      expect(counts === '{"throw":0,"reenter":0,"teardown":0}', `browser entries read ${counts}`);
      t.teardown();
    }
    throws(() => t.echoNumber(1), 'Error: runtime adapter is closed');
    throws(() => echo.call(fake, {} as any), 'Error: runtime adapter is closed');
    expect(v.echoNumber(6) === 6, 'other modules unaffected');
  });

  await check(
    'a wrapper expecting a prepared entry the backend lacks is refused at install',
    () => {
      const jsi = (globalThis as any).__rnrsRuntime !== undefined;
      const Values = v.constructor as any;
      class Mismatched extends Values {
        static readonly descriptor = { ...Values.descriptor, direct: [[100000, jsi ? 1 : 9]] };
      }
      throws(
        () => createModuleForTesting(Mismatched as any, 4),
        jsi
          ? /does not match this module: ValuesModule has no prepared entry for method 100000\. Rebuild/
          : /ValuesModule: no entry of arity 9/,
      );
      const after = createValuesModuleForTesting(4);
      expect(after.echoNumber(8) === 8, 'install still works after a refusal');
      after.teardown();
    },
  );

  await check('strings: UTF-8 round trip, lone surrogates become U+FFFD', () => {
    for (const s of ['', 'plain', 'é ü 漢字', 'emoji 🦀', 'nul \u0000 inside'])
      expect(v.echoString(s) === s, `echo ${JSON.stringify(s)}`);
    expect(v.utf8Length('🦀') === 4 && v.utf8Length('é') === 2, 'UTF-8 lengths');
    const lone = '\uD800x\uDC00';
    const back = v.echoString(lone);
    expect(back === '�x�', `lone surrogates: ${JSON.stringify(back)}`);
    expect(v.utf8Length(lone) === 7, `utf8Length ${v.utf8Length(lone)}`);
    throws(() => v.echoString(1 as any), 'TypeError: s must be a string, got a number');
    return `lone -> ${JSON.stringify(back)}`;
  });

  await check('strings: lone-surrogate policy matches a reference encoder (incl. ropes)', () => {
    // The documented policy: UTF-8, each UTF-16 code unit of an unpaired surrogate becomes
    // U+FFFD. Reference encoder in JS; compared with the backend's copy via utf8Length and a
    // round trip, over edge cases and long concatenated strings (engine ropes) whose
    // surrogate pairs straddle the joins.
    const reference = (s: string) => {
      let out = '',
        bytes = 0;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
          const d = s.charCodeAt(i + 1);
          if (d >= 0xdc00 && d <= 0xdfff) {
            out += s[i] + s[i + 1];
            bytes += 4;
            i++;
            continue;
          }
        }
        if (c >= 0xd800 && c <= 0xdfff) {
          out += '\uFFFD';
          bytes += 3;
          continue;
        }
        out += s[i];
        bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
      }
      return { out, bytes };
    };
    const big = 'x'.repeat(5000);
    // Hermes Array.prototype.join builds UTF-16 storage even for ASCII-only content (the
    // benchmark's strLen fixtures are built this way), so these take the native encoder's
    // UTF-16 path rather than the ASCII-storage copy: lengths around 16/1024/64Ki, U+0000 and
    // U+007F, and ASCII next to lone and paired surrogates.
    const joined = (n: number, unit: (i: number) => string) =>
      Array.from({ length: n }, (_, i) => unit(i)).join('');
    const asciiUnit = (i: number) => String.fromCharCode(i % 128);
    const cases = [
      ...[1, 15, 16, 17, 1023, 1024, 1025, 65537].map((n) => joined(n, asciiUnit)),
      Array.from('abcdefghijklmnop'.repeat(64)).join(''),
      ['a', '\uD800', 'b'].join(''),
      ['x', '\uD83E'].join(''),
      ['\uD83E', '\uDD80', 'x'].join(''),
      ['\uDC00', '\u0000', '\u007F', '\u0080'].join(''),
      ['abc'.repeat(400), '\uD800', 'def'.repeat(400)].join(''),
      '\uD800',
      '\uDC00',
      '\uD800\uD800',
      '\uDC00\uD800',
      'a\uD800',
      '\uD800\uDC00\uDC00',
      '\uDBFF\uDFFF',
      '\u0000\uD83E',
      big + '\uD83E' + '\uDD80' + big,
      big + 'é' + '\uD83E',
      '\uDD80' + big,
      'abc'.repeat(3000) + '漢字'.repeat(2000) + '\uD800',
    ];
    let checked = 0;
    for (const s of cases) {
      const ref = reference(s);
      expect(
        v.utf8Length(s) === ref.bytes,
        `utf8Length ${s.length} units: ${v.utf8Length(s)} vs ${ref.bytes}`,
      );
      expect(v.echoString(s) === ref.out, `echo of a ${s.length}-unit case differs`);
      checked++;
    }
    return `${checked} cases`;
  });

  await check('arrays: element-wise copies, holes and non-arrays rejected', () => {
    const xs = [1, -0, Infinity];
    const back = v.echoNumbers(xs);
    expect(back !== xs && Object.is(back[1], -0) && back[2] === Infinity, 'copy with f64 values');
    expect(v.sum([]) === 0 && v.nestedSum([[1, 2], [], [3]]) === 6, 'sums');
    // eslint-disable-next-line no-sparse-arrays
    throws(() => v.sum([1, , 3] as any), 'TypeError: xs[1] must be a number, got undefined');
    throws(
      () => v.nestedSum([[1], ['2' as any]]),
      'TypeError: xs[1][0] must be a number, got a string',
    );
    throws(
      () => v.sum(new Float64Array([1, 2]) as any),
      'TypeError: xs must be an array, got an object',
    );
    throws(
      () => v.sum({ length: 1, 0: 1 } as any),
      'TypeError: xs must be an array, got an object',
    );
    expect(same(v.echoStrings(['x', '', '🦀']), ['x', '', '🦀']), 'strings');
    expect(v.points(3)[2].y === -2 && v.points(0).length === 0, 'returned records');
  });

  const labeled = (extra: Partial<Labeled> = {}): Labeled => ({
    label: 'L',
    tags: ['a', 'b'],
    parent: null,
    points: [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ],
    ...extra,
  });

  await check('records: optional (missing/undefined) vs nullable (null), output shape', () => {
    expect(
      v.describe(labeled({ note: 'n', parent: { x: 9, y: 8 } })) === 'L|a,b|n|(9,8)|(1,2);(3,4)',
      'all fields',
    );
    for (const l of [labeled(), labeled({ note: undefined })]) {
      expect(v.describe(l) === 'L|a,b|<none>|null|(1,2);(3,4)', 'None optional / nullable');
      const out = v.echoLabeled(l);
      expect(
        !('note' in out) && out.parent === null,
        `None optional omitted, nullable null: ${JSON.stringify(out)}`,
      );
    }
    const out = v.echoLabeled(labeled({ note: 'n' }));
    expect(
      same(Object.keys(out), ['label', 'tags', 'note', 'parent', 'points']),
      `keys ${Object.keys(out)}`,
    );
    throws(
      () => v.describe(labeled({ note: null as any })),
      'TypeError: l.note must be a string, got null',
    );
    throws(
      () => v.describe({ ...labeled(), parent: undefined as any }),
      'TypeError: l.parent must be a Point object, got undefined',
    );
    expect(
      same(Object.keys(v.echoPoint({ x: 1, y: 2, z: 3 } as any)), ['x', 'y']),
      'extra properties ignored',
    );
  });

  await check('invalid records name the failing path', () => {
    throws(() => v.echoPoint({ x: 1 } as any), 'TypeError: p.y must be a number, got undefined');
    throws(
      () =>
        v.describe(
          labeled({
            points: [
              { x: 1, y: 2 },
              { x: '1' as any, y: 0 },
            ],
          }),
        ),
      'TypeError: l.points[1].x must be a number, got a string',
    );
    throws(() => v.echoPoint(1 as any), 'TypeError: p must be a Point object, got a number');
    throws(() => v.echoPoint([1, 2] as any), 'TypeError: p must be a Point object, got an array');
    throws(() => v.echoPoint(null as any), 'TypeError: p must be a Point object, got null');
    throws(
      () => v.echoPoint((() => 0) as any),
      'TypeError: p must be a Point object, got a function',
    );
    throws(
      () => v.echoPoint((v.bag() as any).handle),
      'TypeError: p must be a Point object, got an object',
    );
  });

  await check('nullable and optional arguments', () => {
    expect(v.maybe(2) === 4 && v.maybe(null) === null, 'maybe');
    throws(() => v.maybe(undefined as any), 'TypeError: x must be a number, got undefined');
    expect(v.maybeString('ab') === 'AB' && v.maybeString(null) === null, 'maybeString');
    expect(
      same(v.maybePoint({ x: 1, y: 2 }), { x: 2, y: 1 }) && v.maybePoint(null) === null,
      'maybePoint',
    );
    expect(
      v.optionalArg(1) === '1+none' &&
        v.optionalArg(1, undefined) === '1+none' &&
        v.optionalArg(1, 2) === '1+2',
      'optional',
    );
    throws(() => v.optionalArg(1, null as any), 'TypeError: b must be a number, got null');
  });

  await check('getters run once in declaration order; their exceptions propagate unchanged', () => {
    const order: string[] = [];
    const p = {} as { x: number; y: number };
    Object.defineProperty(p, 'y', {
      enumerable: true,
      get() {
        order.push('y');
        return 2;
      },
    });
    Object.defineProperty(p, 'x', {
      enumerable: true,
      get() {
        order.push('x');
        return 1;
      },
    });
    expect(same(v.echoPoint(p), { x: 1, y: 2 }) && same(order, ['x', 'y']), `order ${order}`);
    const boom = new RangeError('boom from getter');
    const throwing = {
      get x(): number {
        throw boom;
      },
      y: 0,
    };
    let caught: unknown;
    try {
      v.echoPoint(throwing);
    } catch (error) {
      caught = error;
    }
    expect(caught === boom, `original exception object propagated: ${caught}`);
    const proxied = new Proxy({ x: 5, y: 6 }, { get: (t, k) => (k === 'x' ? 50 : (t as any)[k]) });
    expect(same(v.echoPoint(proxied), { x: 50, y: 6 }), 'proxy traps are honoured');
  });

  await check('a getter that disposes the receiver yields "disposed", not a stale borrow', () => {
    const bag = v.bag();
    expect(bag instanceof Bag && bag.add({ x: 0, y: 0 }) === 1, 'add');
    const p = {
      get x(): number {
        bag.dispose();
        return 1;
      },
      y: 2,
    };
    throws(() => bag.add(p), 'Error: Bag is disposed');
  });

  await check('async results carry records', async () => {
    const out = await v.echoLabeledLater(labeled({ note: 'later', parent: { x: 1, y: 1 } }), 5);
    expect(
      out.note === 'later' && out.parent?.x === 1 && out.points.length === 2,
      JSON.stringify(out),
    );
  });

  await check('unions: every variant round-trips; unit variants; Rust sees the variant', () => {
    const shapes: Shape[] = [
      { kind: 'circle', radius: 1 },
      { kind: 'rect', width: 2, height: 3 },
      { kind: 'empty' },
    ];
    for (const shape of shapes)
      expect(same(v.echoShape(shape), shape), `echo ${JSON.stringify(shape)}`);
    expect(
      v.area(shapes[0]) === Math.PI && v.area(shapes[1]) === 6 && v.area(shapes[2]) === 0,
      'area matches on the variant',
    );
    expect(same(v.allShapes(), shapes), `allShapes ${JSON.stringify(v.allShapes())}`);
    expect(
      same(v.maybeShape(null), null) && same(v.maybeShape(shapes[0]), shapes[0]),
      'nullable union',
    );
  });

  await check(
    'unions: annotated discriminator, constant literal fields checked and restored',
    () => {
      const round: Tagged = { kind: 'round', category: 'curved', r: 2 };
      const back = v.echoTagged(round);
      expect(
        same(back, round) && same(Object.keys(back), ['kind', 'category', 'r']),
        JSON.stringify(back),
      );
      throws(
        () => v.echoTagged({ kind: 'round', category: 'angular', r: 2 } as any),
        'TypeError: t.category must be "curved"',
      );
      throws(
        () => v.echoTagged({ kind: 'square', side: 1 } as any),
        'TypeError: t.category must be "angular"',
      );
    },
  );

  await check('unions: unknown, missing and non-string tags; field paths inside variants', () => {
    throws(
      () => v.area({ kind: 'triangle' } as any),
      'TypeError: s.kind: unknown Shape tag "triangle"; expected one of "circle", "rect", "empty"',
    );
    throws(
      () => v.area({ radius: 1 } as any),
      'TypeError: s.kind must be one of "circle", "rect", "empty"',
    );
    throws(
      () => v.area({ kind: 1 } as any),
      'TypeError: s.kind must be one of "circle", "rect", "empty"',
    );
    throws(() => v.area('circle' as any), 'TypeError: s must be a Shape object, got a string');
    throws(
      () => v.area({ kind: 'circle', radius: '1' } as any),
      'TypeError: s.radius must be a number, got a string',
    );
  });

  await check(
    'unions: nested in records and arrays, interface variants, optional and nullable fields',
    async () => {
      const events: Event[] = [
        { type: 'move', to: { x: 1, y: 2 } },
        { type: 'batch', shapes: [{ kind: 'circle', radius: 1 }, { kind: 'empty' }], label: 'b' },
        { type: 'batch', shapes: [] },
        { type: 'two-words', note: null },
        { type: 'two-words', note: 'n' },
      ];
      for (const e of events)
        expect(
          same(v.echoEvent(e), e),
          `echo ${JSON.stringify(e)} -> ${JSON.stringify(v.echoEvent(e))}`,
        );
      throws(
        () => v.echoEvent({ type: 'batch', shapes: [{ kind: 'hex' }] } as any),
        /^TypeError: e\.shapes\[0\]\.kind: unknown Shape tag "hex"/,
      );
      const scaled = await v.scaleLater({ kind: 'rect', width: 1, height: 2 }, 3);
      expect(
        same(scaled, { kind: 'rect', width: 3, height: 6 }),
        `async union ${JSON.stringify(scaled)}`,
      );
    },
  );

  /** Runs `body` with a temporary property on `target`, always restoring it. */
  function polluted(
    target: object,
    key: PropertyKey,
    descriptor: PropertyDescriptor,
    body: () => void,
  ) {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    try {
      body();
    } finally {
      if (previous) Object.defineProperty(target, key, previous);
      else delete (target as any)[key];
    }
  }

  await check('ordinary input reads: inherited values and getters fill fields and holes', () => {
    polluted(Object.prototype, 'note', { value: 'polluted', writable: true }, () => {
      expect(
        v.describe(labeled()) === 'L|a,b|polluted|null|(1,2);(3,4)',
        'inherited optional field is read',
      );
    });
    polluted(Object.prototype, 'y', { get: () => 99 }, () => {
      expect(same(v.echoPoint({ x: 1 } as any), { x: 1, y: 99 }), 'inherited getter supplies y');
    });
    polluted(Array.prototype, 1, { value: 5, writable: true }, () => {
      // eslint-disable-next-line no-sparse-arrays
      expect(v.sum([1, , 3] as any) === 9, 'inherited number fills the hole');
      expect(v.sum([1, 2, 3]) === 6, 'an own element shadows the inherited one');
    });
    const inherited = Object.create({ y: 7 }) as { x: number; y: number };
    inherited.x = 1;
    const out = v.echoPoint(inherited);
    expect(same(out, { x: 1, y: 7 }), `inherited y read: ${JSON.stringify(out)}`);
    expect(
      Object.getOwnPropertyDescriptor(out, 'y')?.value === 7,
      'the output is an own data property',
    );
  });

  await check('ordinary input reads: absent or mistyped values still fail with their path', () => {
    throws(() => v.echoPoint({ x: 1 } as any), 'TypeError: p.y must be a number, got undefined');
    throws(
      () => v.echoPoint(Object.create({ y: '2' }, { x: { value: 1, enumerable: true } })),
      'TypeError: p.y must be a number, got a string',
    );
    // eslint-disable-next-line no-sparse-arrays
    throws(() => v.sum([1, , 3] as any), 'TypeError: xs[1] must be a number, got undefined');
    polluted(Array.prototype, 1, { value: 'five', writable: true }, () => {
      let laterRead = false;
      // eslint-disable-next-line no-sparse-arrays
      const xs = [1, , 3] as any[];
      Object.defineProperty(xs, 2, {
        get() {
          laterRead = true;
          return 3;
        },
      });
      throws(() => v.sum(xs), 'TypeError: xs[1] must be a number, got a string');
      expect(!laterRead, 'the first bad value stops the conversion');
    });
  });

  await check(
    'ordinary input reads: prototype getters run in order and their exceptions propagate',
    () => {
      const order: string[] = [];
      const proto = {
        get x() {
          order.push('proto x');
          return 1;
        },
        get y() {
          order.push('proto y');
          return -1;
        },
      };
      const p = Object.create(proto) as { x: number; y: number };
      Object.defineProperty(p, 'y', {
        get() {
          order.push('own y');
          return 2;
        },
      });
      expect(
        same(v.echoPoint(p), { x: 1, y: 2 }) && same(order, ['proto x', 'own y']),
        `own y shadows the inherited getter; order ${order}`,
      );
      const boom = new RangeError('boom from a prototype getter');
      let caught: unknown;
      polluted(
        Object.prototype,
        'y',
        {
          get() {
            throw boom;
          },
        },
        () => {
          try {
            v.echoPoint({ x: 1 } as any);
          } catch (error) {
            caught = error;
          }
        },
      );
      expect(caught === boom, `original exception object propagated: ${caught}`);
    },
  );

  await check('ordinary input reads: union tags may be inherited or getters', () => {
    expect(
      v.area(Object.create({ kind: 'circle' }, { radius: { value: 1, enumerable: true } })) ===
        Math.PI,
      'inherited tag',
    );
    expect(
      v.area({
        get kind() {
          return 'rect' as const;
        },
        width: 2,
        height: 3,
      }) === 6,
      'getter tag',
    );
    throws(
      () => v.area(Object.create({ kind: 'hex' })),
      /^TypeError: s\.kind: unknown Shape tag "hex"/,
    );
  });

  await check('ordinary input reads do not call a patched global Reflect.get', () => {
    // Conversions before patching, so the result does not depend on whether a backend has
    // already resolved its helpers (the web backend resolves them on first use).
    // Same shapes as below (array, record, proxy of an array), so every helper is resolved.
    v.sum([1]);
    v.echoPoint({ x: 0, y: 0 });
    v.sum(new Proxy([1], {}));
    const original = Reflect.get;
    let calls = 0;
    (Reflect as any).get = function (...args: any[]) {
      calls++;
      return (original as any).apply(this, args);
    };
    let results: number[];
    try {
      results = [v.sum([1, 2, 3]), v.echoPoint({ x: 1, y: 2 }).y, v.sum(new Proxy([4, 5], {}))];
    } finally {
      (Reflect as any).get = original;
    }
    expect(
      same(results, [6, 2, 9]) && calls === 0,
      `results ${results}, Reflect.get calls ${calls}`,
    );
  });

  await check('numeric array failures at and after growth stop and preserve exceptions', () => {
    // 4096 fails before the first growth; 4097 fails after growth and one write.
    // Repetition exercises freeing partially initialized destinations on both exits.
    for (let repeat = 0; repeat < 16; repeat++) {
      for (const index of [4096, 4097]) {
        for (const throwing of [false, true]) {
          const xs = Array.from({ length: 8193 }, () => 1);
          const sentinel = new Error(`growth getter ${index}`);
          let badReads = 0;
          let nextReads = 0;
          Object.defineProperty(xs, index, {
            get() {
              badReads++;
              expect(v.sum([2, 3]) === 5, 'nested conversion at failure boundary');
              if (throwing) throw sentinel;
              return 'invalid';
            },
          });
          Object.defineProperty(xs, index + 1, {
            get() {
              nextReads++;
              return 1;
            },
          });
          if (throwing) {
            let caught: unknown;
            try {
              v.sum(xs);
            } catch (error) {
              caught = error;
            }
            expect(caught === sentinel, `original exception at ${index}`);
          } else {
            throws(() => v.sum(xs), `TypeError: xs[${index}] must be a number, got a string`);
          }
          expect(
            badReads === 1 && nextReads === 0,
            `stopped at ${index}: ${badReads}/${nextReads}`,
          );
        }
      }
    }
    expect(v.sum(Array.from({ length: 8193 }, () => 1)) === 8193, 'usable after partial failures');
  });

  await check('numeric arrays: Wasm memory growth from getters mid-conversion', () => {
    const grow = env.growWasmMemory;
    if (!grow) return 'skipped: no Wasm memory on this backend';
    // Two chunks of the browser's fused reader (4096 elements each); each getter grows the
    // memory (detaching the buffer being written) and re-enters.
    const xs = Array.from({ length: 6000 }, (_, i) => i + 0.5);
    for (const index of [3, 5000])
      Object.defineProperty(xs, index, {
        get() {
          grow();
          expect(v.sum([1, 2]) === 3, 're-entrant call after growth');
          return -index;
        },
      });
    const expected = Array.from({ length: 6000 }, (_, i) => (i === 3 || i === 5000 ? -i : i + 0.5));
    const echoed = v.echoNumbers(xs);
    expect(same(echoed, expected), 'every element lands after growth');
    expect(v.sum(xs) === expected.reduce((a, b) => a + b, 0), 'sum after growth');
  });

  await check('ordinary input reads: mutation and re-entrancy during array conversion', () => {
    // Length is read once. A getter that shrinks the array: later indices read through the
    // prototype chain (here polluted), exactly like xs[i].
    polluted(Array.prototype, 1, { value: 5, writable: true }, () => {
      polluted(Array.prototype, 2, { value: 6, writable: true }, () => {
        const xs: number[] = [0, 2, 3];
        Object.defineProperty(xs, 0, {
          get() {
            xs.length = 1;
            return 1;
          },
        });
        expect(v.sum(xs) === 12, 'shrunk array reads inherited 5 and 6');
      });
    });
    const grows: number[] = [0, 2];
    Object.defineProperty(grows, 0, {
      get() {
        grows.push(100);
        return 1;
      },
    });
    expect(v.sum(grows) === 3, 'elements added during conversion are not read');
    const outer: number[] = [0, 2];
    Object.defineProperty(outer, 0, {
      get() {
        expect(v.sum([10, 20]) === 30, 're-entrant call');
        return 1;
      },
    });
    expect(v.sum(outer) === 3, 'outer conversion continues after a re-entrant call');
    const tm = createValuesModuleForTesting(4);
    const tearing: number[] = [0, 2];
    Object.defineProperty(tearing, 0, {
      get() {
        tm.teardown();
        return 1;
      },
    });
    throws(() => tm.sum(tearing), 'Error: runtime adapter is closed');
  });

  await check(
    'outputs are own data properties: inherited setters and descriptor pollution cannot intercept',
    () => {
      let intercepted = 0;
      polluted(
        Object.prototype,
        'x',
        {
          set: () => {
            intercepted++;
          },
          get: () => -1,
        },
        () => {
          polluted(Object.prototype, 'get', { value: () => 0, writable: true }, () => {
            const out = v.echoPoint({ x: 1, y: 2 } as any as { x: number; y: number });
            const d = Object.getOwnPropertyDescriptor(out, 'x');
            expect(
              d &&
                d.value === 1 &&
                d.writable &&
                d.enumerable &&
                d.configurable &&
                intercepted === 0,
              `descriptor ${JSON.stringify(d)}, setter calls ${intercepted}`,
            );
            expect(Object.getPrototypeOf(out) === Object.prototype, 'ordinary object');
            polluted(
              Array.prototype,
              0,
              {
                set: () => {
                  intercepted++;
                },
              },
              () => {
                const arr = v.echoNumbers([7]);
                expect(
                  Object.getOwnPropertyDescriptor(arr, 0)?.value === 7 && intercepted === 0,
                  'array element defined',
                );
              },
            );
          });
        },
      );
    },
  );

  await check('number[] results: exact values and own data properties, pollution ignored', () => {
    const specials = [1.5, -0, 0, NaN, Infinity, -Infinity, 5e-324, -Number.MAX_VALUE, 2 ** 53 + 2];
    const exact = (out: number[], expected: number[], what: string) => {
      expect(
        Array.isArray(out) && Object.getPrototypeOf(out) === Array.prototype,
        `${what}: array`,
      );
      expect(out.length === expected.length, `${what}: length ${out.length}`);
      for (let i = 0; i < expected.length; i++) {
        const d = Object.getOwnPropertyDescriptor(out, i);
        expect(
          d && Object.is(d.value, expected[i]) && d.writable && d.enumerable && d.configurable,
          `${what}[${i}]: ${String(d?.value)}`,
        );
      }
    };
    exact(v.echoNumbers(specials), specials, 'specials');
    exact(v.echoNumbers([]), [], 'empty');
    const large = Array.from({ length: 100_000 }, (_, i) => i * 0.25 - 3);
    exact(v.echoNumbers(large), large, 'large');
    let intercepted = 0;
    const trap = { get: () => -1, set: () => void intercepted++ };
    polluted(Array.prototype, 0, trap, () =>
      polluted(Object.prototype, 1, trap, () =>
        // `get` innermost: `polluted` itself uses ordinary descriptors, which a polluted
        // Object.prototype.get would turn into invalid accessor-plus-value descriptors.
        polluted(Object.prototype, 'writable', { value: false, writable: true }, () =>
          polluted(Object.prototype, 'get', { value: () => 0, writable: true }, () => {
            exact(v.echoNumbers(specials), specials, 'polluted');
            exact(
              v.byteLengths([new ArrayBuffer(0), new ArrayBuffer(3)]),
              [0, 3],
              'polluted byteLengths',
            );
          }),
        ),
      ),
    );
    expect(intercepted === 0, `setter calls ${intercepted}`);
    // Inherited non-writable indices neither drop nor reject elements.
    polluted(Array.prototype, 0, { value: 9, writable: false }, () =>
      polluted(Object.prototype, 1, { value: 9, writable: false }, () =>
        exact(v.echoNumbers([1, 2, 3]), [1, 2, 3], 'non-writable inherited'),
      ),
    );
    // A proxy in the prototype chain is never trapped while the result is built.
    const traps: string[] = [];
    let recording = false;
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        if (recording) traps.push(`${name} ${String(args[1])}`);
        return (Reflect as any)[name](...args);
      };
    const proxy = new Proxy(Object.create(Object.prototype), {
      get: record('get'),
      set: record('set'),
      has: record('has'),
      getOwnPropertyDescriptor: record('getOwnPropertyDescriptor'),
      defineProperty: record('defineProperty'),
    });
    const arrayParent = Object.getPrototypeOf(Array.prototype);
    Object.setPrototypeOf(Array.prototype, proxy);
    let viaProxy: number[] = [];
    try {
      recording = true;
      viaProxy = v.echoNumbers([4, 5, 6]);
    } finally {
      recording = false;
      Object.setPrototypeOf(Array.prototype, arrayParent);
    }
    expect(traps.length === 0, `proxy traps: ${traps.join(', ')}`);
    exact(viaProxy, [4, 5, 6], 'proxy ancestor');
    // A failure between the prototype detach and its restore publishes nothing.
    let failure = 'hook not compiled in';
    if (env.failNumberFill) {
      env.failNumberFill(true);
      try {
        exact(v.echoNumbers([]), [], 'empty under the failure hook');
        let result: unknown = 'none';
        try {
          result = v.echoNumbers([1, 2, 3]);
        } catch (e) {
          failure = String(e);
        }
        expect(result === 'none', `a result was published: ${String(result)}`);
        expect(/number fill failure forced/.test(failure), `failure: ${failure}`);
      } finally {
        env.failNumberFill(false);
      }
      expect(Object.getPrototypeOf(Array.prototype) === Object.prototype, 'Array.prototype intact');
      exact(v.echoNumbers([7, 8]), [7, 8], 'after the failure');
    }
    return `${specials.length} specials, ${large.length} elements; forced fill failure: ${failure}`;
  });

  await check(
    'proxies: traps run identically; throwing and invalid lengths; revoked proxies',
    () => {
      expect(
        v.sum(new Proxy([1, 2, 3], {})) === 6,
        'a proxy of an array is an array (Array.isArray)',
      );
      const traps: string[] = [];
      const recorded = new Proxy(
        { x: 1, y: 2 },
        {
          getOwnPropertyDescriptor(t, k) {
            traps.push(`own:${String(k)}`);
            return Reflect.getOwnPropertyDescriptor(t, k);
          },
          get(t, k) {
            traps.push(`get:${String(k)}`);
            return (t as any)[k];
          },
        },
      );
      v.echoPoint(recorded);
      expect(same(traps, ['get:x', 'get:y']), `ordinary reads: get traps only, in order: ${traps}`);
      const arrayTraps: string[] = [];
      const recordedArray = new Proxy([1, 2, 3], {
        has(t, k) {
          arrayTraps.push(`has:${String(k)}`);
          return Reflect.has(t, k);
        },
        getOwnPropertyDescriptor(t, k) {
          arrayTraps.push(`own:${String(k)}`);
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
        get(t, k) {
          arrayTraps.push(`get:${String(k)}`);
          return (t as any)[k];
        },
      });
      expect(v.sum(recordedArray) === 6, 'proxy of an array sums');
      expect(
        same(arrayTraps, ['get:length', 'get:0', 'get:1', 'get:2']),
        `array proxy: length once, then each index once: ${arrayTraps}`,
      );
      const boom = new Error('length trap');
      let caught: unknown;
      try {
        v.sum(
          new Proxy([1], {
            get: (t, k) => {
              if (k === 'length') throw boom;
              return (t as any)[k];
            },
          }),
        );
      } catch (e) {
        caught = e;
      }
      expect(caught === boom, `length trap exception propagated: ${caught}`);
      throws(
        () => v.sum(new Proxy([1], { get: (t, k) => (k === 'length' ? 1.5 : (t as any)[k]) })),
        /^TypeError: array length 1.5 is not an integer/,
      );
      const { proxy, revoke } = Proxy.revocable([1], {});
      revoke();
      throws(() => v.sum(proxy), 'TypeError: xs must be an array, got an unsupported value');
    },
  );

  await check('a getter that tears the module down stops the call', () => {
    const tm = createValuesModuleForTesting(4);
    const bag = tm.bag();
    expect(bag.add({ x: 0, y: 0 }) === 1, 'add before');
    throws(
      () =>
        bag.add({
          get x() {
            tm.teardown();
            return 1;
          },
          y: 2,
        }),
      'Error: runtime adapter is closed',
    );
    const other = createValuesModuleForTesting(4);
    throws(
      () =>
        other.sizeArea({
          get width() {
            other.teardown();
            return 1;
          },
          height: 2,
        }),
      'Error: runtime adapter is closed',
    );
  });

  await check('imported records and names matching glue locals', () => {
    expect(v.sizeArea({ width: 2, height: 4 }) === 8, 'imported record');
    expect(v.mix(1.5, 'r', true) === '1.5|r|true', 'params named env/receiver/result');
    const slot = { kind: 'filled', object: 7, value: 'v' } as const;
    expect(
      same(v.echoSlot(slot), slot) && same(v.echoSlot({ kind: 'vacant' }), { kind: 'vacant' }),
      'fields named object/value',
    );
  });

  const bytes = (...xs: number[]) => new Uint8Array(xs).buffer;
  const list = (b: ArrayBuffer) => Array.from(new Uint8Array(b));

  await check('ArrayBuffer: copies in, new buffers out, empty and all byte values', async () => {
    const all = new Uint8Array(256).map((_, i) => i).buffer;
    expect(same(list(v.echoBytes(all)), list(all)) && v.byteSum(all) === 32640, 'all byte values');
    const empty = v.echoBytes(new ArrayBuffer(0));
    expect(empty instanceof ArrayBuffer && empty.byteLength === 0, 'empty');
    const made = v.makeBytes(300);
    expect(
      made instanceof ArrayBuffer && made.byteLength === 300 && new Uint8Array(made)[257] === 1,
      'native result',
    );
    const input = bytes(1, 2, 3);
    const out = v.echoBytes(input);
    expect(out !== input, 'a new buffer');
    new Uint8Array(out)[0] = 50; // results are ordinary, writable JS buffers
    new Uint8Array(input)[1] = 60;
    expect(
      same(list(out), [50, 2, 3]) && same(list(v.echoBytes(input)), [1, 60, 3]),
      'independent copies',
    );
    const later = v.bytesLater(input, 5);
    new Uint8Array(input)[2] = 70; // after the call: the operation owns its own copy
    expect(same(list(await later), [1, 60, 3]), 'async input is a snapshot');
    expect(v.maybeBytes(null) === null && same(list(v.maybeBytes(bytes(5))!), [5]), 'nullable');
    expect(same(v.byteLengths([new ArrayBuffer(0), bytes(1, 2)]), [0, 2]), 'arrays of buffers');
  });

  await check('ArrayBuffer: conversion order with getters', () => {
    const data = bytes(1, 2);
    const blob = {
      name: 'n',
      data,
      get after() {
        new Uint8Array(data)[0] = 42;
        return 1;
      },
    };
    expect(
      same(list(v.echoBlob(blob).data), [1, 2]) && new Uint8Array(data)[0] === 42,
      'data copied before later fields run',
    );
  });

  await check(
    'ArrayBuffer: views and look-alikes are rejected; engine-dependent kinds detected where they exist',
    () => {
      const view = new Uint8Array([1, 2]);
      throws(
        () => v.byteSum(view as any),
        'TypeError: b must be an ArrayBuffer, got a typed array or DataView; pass view.buffer.slice(start, end)',
      );
      throws(
        () => v.byteSum(new DataView(new ArrayBuffer(2)) as any),
        /got a typed array or DataView/,
      );
      throws(
        () => v.byteSum(new Proxy(new ArrayBuffer(2), {}) as any),
        'TypeError: b must be an ArrayBuffer, got an object',
      );
      throws(
        () => v.byteSum(Object.create(ArrayBuffer.prototype)),
        'TypeError: b must be an ArrayBuffer, got an object',
      );
      throws(() => v.byteSum([1, 2] as any), 'TypeError: b must be an ArrayBuffer, got an array');
      expect(v.byteSum(view.buffer.slice(1)) === 2, 'an explicit slice of a view');
      const notes: string[] = [];
      if (typeof SharedArrayBuffer === 'function') {
        throws(() => v.byteSum(new SharedArrayBuffer(4) as any), /got a SharedArrayBuffer/);
        notes.push('SharedArrayBuffer rejected');
      } else notes.push('no SharedArrayBuffer in this engine/context');
      let resizable: ArrayBuffer | undefined;
      try {
        resizable = new (ArrayBuffer as any)(4, { maxByteLength: 8 });
      } catch {
        /* unsupported */
      }
      if (resizable && (resizable as any).resizable === true) {
        throws(
          () => v.byteSum(resizable!),
          'TypeError: b must be a fixed-length ArrayBuffer, got a resizable one',
        );
        notes.push('resizable rejected');
      } else notes.push('no resizable ArrayBuffers in this engine');
      const transferable = new ArrayBuffer(4);
      if (typeof (transferable as any).transfer === 'function') {
        (transferable as any).transfer();
        throws(() => v.byteSum(transferable), 'TypeError: b is a detached ArrayBuffer');
        notes.push('detached rejected');
      } else notes.push('no ArrayBuffer.prototype.transfer (no detachment) in this engine');
      return notes.join('; ');
    },
  );

  await check(
    'ArrayBuffer: patched length/byteLength/detached getters and globals do not change copies',
    () => {
      const typedProto = Object.getPrototypeOf(Uint8Array.prototype);
      const saved: Array<[object, string, PropertyDescriptor | undefined]> = [
        ...['length', 'byteLength', 'byteOffset'].map(
          (k) =>
            [typedProto, k, Object.getOwnPropertyDescriptor(typedProto, k)] as [
              object,
              string,
              PropertyDescriptor | undefined,
            ],
        ),
        ...['byteLength', 'detached', 'resizable', 'maxByteLength'].map(
          (k) =>
            [
              ArrayBuffer.prototype,
              k,
              Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, k),
            ] as [object, string, PropertyDescriptor | undefined],
        ),
      ];
      const g = globalThis as any;
      const savedGlobals = { ArrayBuffer: g.ArrayBuffer, Uint8Array: g.Uint8Array };
      const input = new Uint8Array([1, 2, 3, 250]).buffer;
      const empty = new ArrayBuffer(0); // made before the globals are patched
      let reentered = 0;
      try {
        for (const [proto, key] of saved) {
          Object.defineProperty(proto, key, {
            configurable: true,
            get() {
              reentered++;
              return key === 'detached' || key === 'resizable'
                ? true
                : 65536; /* would reject or overread if used */
            },
          });
        }
        if (env.forceBytesCopyOut) {
          env.forceBytesCopyOut(true);
          g.Uint8Array = function () {
            reentered++;
            throw new Error('patched Uint8Array');
          };
          g.ArrayBuffer = function () {
            reentered++;
            throw new Error('patched ArrayBuffer');
          };
        }
        const copiedBefore = (v.stats() as any).bytesCopiedOut;
        const sum = v.byteSum(input);
        const echoed = v.echoBytes(input);
        const lengths = v.byteLengths([input, empty]);
        const copied = (v.stats() as any).bytesCopiedOut - copiedBefore;
        env.forceBytesCopyOut?.(false);
        g.Uint8Array = savedGlobals.Uint8Array;
        g.ArrayBuffer = savedGlobals.ArrayBuffer;
        for (const [proto, key, d] of saved)
          if (d) Object.defineProperty(proto, key, d);
          else delete (proto as any)[key];
        expect(sum === 256, `byteSum ${sum}`);
        expect(Array.from(new Uint8Array(echoed)).join(',') === '1,2,3,250', 'echoBytes');
        expect(lengths.join(',') === '4,0', `byteLengths ${lengths}`);
        // On Android nothing reads them. In the browser the wasm-bindgen glue reads typed-array
        // `byteLength` for its own memory view (string passing), so reads are only counted.
        if (env.forceBytesCopyOut) {
          expect(reentered === 0, `patched getters or globals ran ${reentered} times`);
          expect(copied === 1, `fallback copies ${copied}`);
        }
      } finally {
        env.forceBytesCopyOut?.(false);
        g.Uint8Array = savedGlobals.Uint8Array;
        g.ArrayBuffer = savedGlobals.ArrayBuffer;
        for (const [proto, key, d] of saved)
          if (d) Object.defineProperty(proto, key, d);
          else delete (proto as any)[key];
      }
      expect(v.byteSum(new Uint8Array(70000).fill(1).buffer) === 70000, 'module usable afterwards');
      return env.forceBytesCopyOut
        ? 'exact results with patched getters and globals; echoBytes took the copy fallback through the captured ArrayBuffer constructor'
        : `exact results with patched getters (${reentered} getter reads, by the wasm-bindgen glue's own memory view; globals not patched because the glue looks them up)`;
    },
  );

  await check(
    'ArrayBuffer results: adopted native storage is released when JS collects it',
    async () => {
      const stats = () => v.stats() as any;
      if (stats().bytesAdopted === undefined)
        return 'results are copied out of Wasm memory on this backend (no native storage to release)';
      const before = stats();
      const make = (n: number) => {
        for (let i = 0; i < n; i++) v.makeBytes(1024);
      };
      make(20);
      make(0);
      const deadline = now() + 5000;
      while (stats().bytesReleased - before.bytesReleased < 20) {
        if (now() > deadline)
          throw new CheckFailure(`released ${stats().bytesReleased - before.bytesReleased} of 20`);
        await env.collectGarbage();
      }
      const after = stats();
      expect(
        after.bytesCopiedOut === before.bytesCopiedOut,
        'results adopted Rust storage (no fallback copy)',
      );
      return `adopted ${after.bytesAdopted - before.bytesAdopted}, released ${after.bytesReleased - before.bytesReleased}, fallback copies ${after.bytesCopiedOut}`;
    },
  );

  await check(
    'Record<string, T> and JsonValue: SQL-style rows and nested JSON roundtrip',
    async () => {
      const rows = v.query(
        ['id', 'name', 'score', 'tags'],
        [
          [1, 'ada', 9.5, ['x', { deep: [null, true] }]],
          [2, 'bob', null, []],
        ],
      );
      expect(
        same(rows, [
          { id: 1, name: 'ada', score: 9.5, tags: ['x', { deep: [null, true] }] },
          { id: 2, name: 'bob', score: null, tags: [] },
        ]),
        `rows ${JSON.stringify(rows)}`,
      );
      const nested = { a: [1, { b: 'c', '': -0, 'two words': [[]] }], n: null, t: true, s: 'é' };
      const back = v.echoJson(nested) as any;
      expect(sameEntries(back, nested), `echoJson ${JSON.stringify(back)}`);
      expect(Object.is(back.a[1][''], -0), 'echoJson keeps -0');
      expect(Object.getPrototypeOf(back) === Object.prototype, 'outputs are ordinary objects');
      const later = await v.echoJsonLater(nested, 1);
      expect(sameEntries(later, nested), 'async roundtrip');
      expect(
        same(v.echoCounts({ b: 2, 10: 10, a: 1 }), { 10: 10, a: 1, b: 2 }),
        'echoCounts (sorted by Rust, integer keys first by JS)',
      );
      expect(
        same(v.echoShapesByName({ c: { kind: 'circle', radius: 1 } }), {
          c: { kind: 'circle', radius: 1 },
        }),
        'unions in a Record',
      );
      expect(
        v.optionalJson() === 'absent' && v.optionalJson(null) === 'null',
        'optional JsonValue',
      );
      const big = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i]));
      expect(Object.keys(v.echoCounts(big)).length === 1000, '1000 keys');
      expect(
        (await v.byteTotalLater({ a: new ArrayBuffer(3), b: new ArrayBuffer(4) }, 1)) === 7,
        'bytes in an async Record',
      );
    },
  );

  await check('Record<string, T> and JsonValue: own enumerable keys of plain objects only', () => {
    const inherited = Object.create({ inherited: 1 });
    throws(
      () => v.echoCounts(inherited),
      'TypeError: c must be a plain object, got an object whose prototype is not Object.prototype or null',
    );
    const plain: Record<string, number> = { own: 1 };
    Object.defineProperty(plain, 'hidden', { value: 2, enumerable: false });
    (plain as any)[Symbol('s')] = 3;
    expect(same(v.echoCounts(plain), { own: 1 }), 'non-enumerable and symbol keys ignored');
    const bare = Object.create(null);
    bare.k = 1;
    expect(same(v.echoCounts(bare), { k: 1 }), 'null-prototype objects accepted');
    for (const other of [new Date(0), new Map(), new (class Row {})(), new ArrayBuffer(1)])
      throws(
        () => v.echoJson(other as any),
        /must be a JsonValue \(plain object\), got an object whose prototype/,
      );
    throws(() => v.echoCounts([] as any), 'TypeError: c must be a plain object, got an array');
    throws(
      () => v.echoCounts({ 'a b': '1' } as any),
      'TypeError: c["a b"] must be a number, got a string',
    );
    throws(
      () => v.echoJson({ a: [1, NaN] }),
      'TypeError: v.a[1] must be a finite number (JsonValue), got NaN',
    );
    throws(
      () => v.echoJson([Infinity]),
      'TypeError: v[0] must be a finite number (JsonValue), got Infinity',
    );
    throws(
      () => v.echoJson({ u: undefined } as any),
      'TypeError: v.u must be a JsonValue, got undefined',
    );
    throws(
      () => v.echoJson([() => 1] as any),
      'TypeError: v[0] must be a JsonValue, got a function',
    );
    // A native object's JS wrapper is a class instance: refused like other non-plain objects.
    throws(
      () => v.echoJson(v.bag() as any),
      /v must be a JsonValue \(plain object\), got an object whose prototype is not/,
    );
    throws(
      () => v.echoJson(BigInt(1) as any),
      'TypeError: v must be a JsonValue, got an unsupported value',
    );
  });

  await check(
    'Record<string, T> and JsonValue: getters, proxies, cycles and safe output',
    async () => {
      const boom = new Error('boom');
      try {
        v.echoCounts({
          get x(): number {
            throw boom;
          },
        });
        throw new CheckFailure('getter exception swallowed');
      } catch (error) {
        expect(error === boom, `getter exception identity: ${error}`);
      }
      const trap = new Error('trap');
      try {
        v.echoJson(
          new Proxy(
            {},
            {
              ownKeys() {
                throw trap;
              },
            },
          ),
        );
        throw new CheckFailure('proxy trap exception swallowed');
      } catch (error) {
        expect(error === trap, `proxy trap exception identity: ${error}`);
      }
      expect(same(v.echoJson(new Proxy({ p: 1 }, {})), { p: 1 }), 'proxies of plain objects');
      const cyclic: any = { a: [] };
      cyclic.a.push(cyclic);
      throws(
        () => v.echoJson(cyclic),
        /^RangeError: v\.a\[0\]\.a\[0\].*JsonValue nesting is deeper than 128 levels/,
      );
      expect(v.nestedJson(128) !== null, '128 levels out');
      throws(
        () => v.nestedJson(129),
        /^RangeError: JsonValue result\[0\].* is nested deeper than 128 levels$/,
      );
      const parsed = JSON.parse('{"__proto__": 1, "constructor": 2}');
      const out = v.echoCounts(parsed) as any;
      expect(Object.getPrototypeOf(out) === Object.prototype, 'output prototype unchanged');
      expect(
        same(Object.keys(out), ['__proto__', 'constructor']) && out.constructor === 2,
        'own keys',
      );
      expect(
        ({} as any).polluted === undefined &&
          Object.prototype.hasOwnProperty.call(out, '__proto__'),
        '__proto__ is an own property',
      );
      try {
        await v.jsonNumberLater(NaN);
        throw new CheckFailure('non-finite result resolved');
      } catch (error) {
        expect(
          /result conversion failed: JsonValue result must be a finite number, got NaN/.test(
            String(error),
          ),
          `async output failure: ${error}`,
        );
      }
    },
  );

  await check(
    'Record<string, T> and JsonValue: 128 levels in, nested exceptions, class instances',
    () => {
      // Objects and arrays alternating, 128 containers deep, around a leaf: accepted and returned
      // intact (the backends' recursion depth on the JS thread); one more level is refused.
      const nest = (depth: number): any => {
        let value: any = 'leaf';
        for (let i = depth - 1; i >= 0; i--) value = i % 2 ? [value] : { k: value };
        return value;
      };
      let back = v.echoJson(nest(128)) as any;
      for (let i = 0; i < 128; i++) back = i % 2 ? back[0] : back.k;
      expect(back === 'leaf', 'depth 128 roundtrip');
      throws(
        () => v.echoJson(nest(129)),
        /^RangeError: v\.k\[0\]\.k.*JsonValue nesting is deeper than 128 levels/,
      );
      // Exceptions keep their identity from deep inside a value and from a getPrototypeOf trap.
      const boom = new Error('nested boom');
      const deep = {
        a: [
          {
            get x(): number {
              throw boom;
            },
          },
        ],
      };
      const proto = new Error('proto trap');
      const trapped = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw proto;
          },
        },
      );
      for (const [run, expected] of [
        [() => v.echoJson(deep), boom],
        [() => v.echoCounts(trapped as any), proto],
      ] as const) {
        try {
          run();
          throw new CheckFailure('exception swallowed');
        } catch (error) {
          expect(error === expected, `exception identity: ${error}`);
        }
      }
      throws(
        () => v.echoCounts(new (class Row {})() as any),
        'TypeError: c must be a plain object, got an object whose prototype is not Object.prototype or null',
      );
    },
  );

  await check(
    'Record<string, T> and JsonValue: worklet endpoints refuse dictionaries and JSON objects',
    () => {
      const t = createValuesModuleForTesting(4);
      try {
        // The JSI backend (Android, iOS) always has endpoints; only the browser backend has none,
        // and only there is the check skipped. Any failure below fails it.
        if (!(t.host.adapter as any).workletEndpoint) {
          expect(env.growWasmMemory !== undefined, 'a native backend has no worklet endpoint');
          return 'skipped: the browser backend has no worklet endpoints';
        }
        const ep: any = workletEndpoint(t, ['echoCounts', 'echoJson', 'nestedJson']);
        // Called from the RN runtime through the endpoint's conversion table: objects are refused
        // by its kind check (before any entries enumeration), container results by its value
        // creation; scalars pass as before.
        throws(
          () => ep.echoCounts({ a: 1 }),
          'TypeError: c must be a plain object, got an unsupported value',
        );
        throws(
          () => ep.echoJson({ a: 1 }),
          'TypeError: v must be a JsonValue, got an unsupported value',
        );
        try {
          ep.nestedJson(1);
          throw new CheckFailure('array result crossed the endpoint');
        } catch (error) {
          expect((error as any)?.code === 'ERR_RNRS_WORKLET_SHAPE', `result refusal: ${error}`);
        }
        expect(ep.echoJson(2) === 2 && ep.echoJson(null) === null, 'scalars still pass');
        return 'refused';
      } finally {
        t.teardown();
      }
    },
  );

  await check(
    'declared errors: worklet endpoints refuse Throws methods; raw endpoints refuse their errors',
    () => {
      const t = createValuesModuleForTesting(4);
      try {
        const raw = (t.host.adapter as any).workletEndpoint;
        // The JSI backend (Android, iOS) always has endpoints; only the browser backend has none.
        if (!raw) {
          expect(env.growWasmMemory !== undefined, 'a native backend has no worklet endpoint');
          return 'skipped: the browser backend has no worklet endpoints';
        }
        // Refused when the endpoint is created (JS), before any call.
        try {
          workletEndpoint(t, ['echoNumber', 'lookup']);
          throw new CheckFailure('an endpoint over a Throws method was created');
        } catch (error) {
          expect((error as any)?.code === 'ERR_RNRS_WORKLET_THROWS', `creation refusal: ${error}`);
        }
        // A raw endpoint (bypassing that check) runs the method, then its C++ path refuses the
        // declared error as a shape error; successes still pass.
        const ep: any = raw(['half']);
        expect(ep.half(4) === 2, 'a success passes');
        const before = v.lookupCalls();
        try {
          ep.half(3);
          throw new CheckFailure('a declared error crossed the endpoint');
        } catch (error) {
          expect((error as any)?.code === 'ERR_RNRS_WORKLET_SHAPE', `error refusal: ${error}`);
        }
        expect(v.lookupCalls() === before + 1, 'the method ran once');
        return 'refused';
      } finally {
        t.teardown();
      }
    },
  );

  await check("native objects: worklet boxes pass as arguments of another type's methods", () => {
    const t = createValuesModuleForTesting(4);
    try {
      const adapter = t.host.adapter as any;
      if (!adapter.workletEndpoint) {
        expect(env.growWasmMemory !== undefined, 'a native backend has no worklet endpoint');
        return 'skipped: the browser backend has no worklet endpoints';
      }
      // A Shader method on the allow-list lets Shaders be boxed; it is not called (its string
      // result would not cross the endpoint).
      const endpoint = workletEndpoint(t, ['Paint.setShader', 'Shader.name']);
      const paint = t.paint();
      const shader = t.shader('boxed');
      const paintBox: any = adapter.workletBox(endpoint, paint.handle);
      const shaderBox: any = adapter.workletBox(endpoint, shader.handle);
      // Paint.setShader(Shader) called through the endpoint with a boxed Shader argument.
      paintBox.setShader(shaderBox);
      // (Read back on the RN side: string results do not cross worklet endpoints.)
      expect(paint.shader()?.name() === 'boxed', 'the paint holds the boxed shader');
      // A box of the wrong native type is refused with the parameter's type.
      throws(() => paintBox.setShader(paintBox), 'TypeError: shader must be a Shader');
      paintBox.setShader(null);
      expect(paint.shader() === null, 'null clears');
      return 'passed';
    } finally {
      t.teardown();
    }
  });

  await check('native objects compose: factories, consumers and graph cycles', () => {
    const db = v.openDatabase('main');
    const statement = db.prepare('select 1');
    expect(statement instanceof Statement && statement.sql() === 'select 1', 'prepare');
    expect(statement.database().name() === 'main', 'statement -> database');
    const paint = v.paint();
    expect(paint.shader() === null, 'no shader yet');
    paint.setShader(v.shader('linear'));
    const held = paint.shader();
    expect(held instanceof Shader && held.name() === 'linear', 'paint holds the shader');
    paint.setShader(null);
    expect(paint.shader() === null, 'cleared');
  });

  await check('native handles inside records, unions, arrays and optional values', async () => {
    const db = v.openDatabase('main');
    const shader = v.shader('s');
    const prepared = db.prepared('q', shader);
    expect(
      prepared.statement instanceof Statement &&
        prepared.statement.sql() === 'q' &&
        prepared.shader instanceof Shader &&
        prepared.shader.name() === 's',
      'record output',
    );
    const bare = db.prepared('r');
    expect(!Object.prototype.hasOwnProperty.call(bare, 'shader'), 'absent optional handle');
    const [a, b] = [db.prepare('a'), db.prepare('b')];
    const record = { statement: prepared.statement, sql: 'q', shader, others: [a, b] };
    expect(db.describePrepared(record) === 'q|s|a,b', 'record input');
    const echoed = v.echoPrepared(record);
    expect(echoed.others[1] instanceof Statement && echoed.others[1].sql() === 'b', 'round trip');
    expect(v.maybePrepared(null) === null, 'nullable record');
    const slots = v.statementSlots(db);
    const many = slots[1];
    expect(
      slots[0].kind === 'one' &&
        slots[0].statement.sql() === 'a' &&
        many.kind === 'many' &&
        many.first === null &&
        many.statements.map((s) => s.sql()).join() === 'a,b' &&
        slots[2].kind === 'empty',
      'union output',
    );
    expect(db.pick({ kind: 'many', statements: [], first: b })?.sql() === 'b', 'union input');
    expect(db.pick(null) === null, 'nullable union');
    const all = await db.prepareAll(['x', 'y']);
    expect(all.map((s) => s.sql()).join() === 'x,y', 'async array');
    const later = await v.preparedLater(db, 'later', 1);
    expect(later.statement.sql() === 'later' && later.others[0].sql() === 'later', 'async record');
  });

  await check('nested handles: wrong type, disposed and other-generation handles fail', () => {
    const db = v.openDatabase('main');
    const shader = v.shader('s');
    const record = (statement: unknown) =>
      ({ statement, sql: 'q', others: [] }) as unknown as Parameters<typeof db.describePrepared>[0];
    throws(() => db.describePrepared(record(shader)), 'TypeError: p.statement must be a Statement');
    throws(() => db.describePrepared(record({})), 'TypeError: p.statement must be a Statement');
    throws(
      () => db.describePrepared(record(1)),
      'TypeError: p.statement must be a Statement, got a number',
    );
    const gone = db.prepare('gone');
    gone.dispose();
    throws(() => db.describePrepared(record(gone)), 'Error: Statement is disposed');
    const other = createValuesModuleForTesting(4);
    try {
      const foreign = other.openDatabase('other').prepare('x');
      throws(
        () => db.describePrepared(record(foreign)),
        'Error: Statement belongs to a closed runtime adapter',
      );
    } finally {
      other.teardown();
    }
  });

  await check('native handles in Record values, directly and inside records', async () => {
    const db = v.openDatabase('main');
    const [a, b] = [db.prepare('a'), db.prepare('b')];
    const direct = v.echoStatementsByName({ x: a, y: b });
    expect(
      direct.x instanceof Statement && direct.x.sql() === 'a' && direct.y.sql() === 'b',
      'direct',
    );
    const nested = v.echoPreparedByName({ p: { statement: a, sql: 'a', others: [b] }, n: null });
    expect(
      nested.p?.statement instanceof Statement &&
        nested.p.others[0].sql() === 'b' &&
        nested.n === null,
      'inside records',
    );
    throws(
      () => v.echoStatementsByName({ s: v.shader('s') } as any),
      'TypeError: m.s must be a Statement',
    );
    const later = await v.statementsByNameLater(db, ['x'], 1);
    expect(later.x instanceof Statement && later.x.sql() === 'x', 'async');
  });

  await check('async calls own their handles after JS disposes them', async () => {
    const paint = v.paint();
    const shader = v.shader('held');
    const name = paint.shaderNameLater(shader, 20);
    shader.dispose();
    expect((await name) === 'held', 'the task still had the shader');
  });

  await check(
    'declared errors: thrown and rejected DomainErrors narrow by their data',
    async () => {
      /** Exhaustive over the declared union: a new variant fails to compile here. */
      const describeError = (error: LookupError): string => {
        switch (error.kind) {
          case 'notFound':
            return `notFound:${error.key}`;
          case 'invalid':
            return `invalid:${error.reason}@${error.at}`;
          case 'busy':
            return 'busy';
          case 'detail':
            return 'detail';
          default: {
            const never: never = error;
            return never;
          }
        }
      };
      const caught = (fn: () => unknown): unknown => {
        try {
          fn();
        } catch (error) {
          return error;
        }
        throw new CheckFailure('expected a throw');
      };
      expect(v.lookup('one') === 1, 'success value');
      const missing = caught(() => v.lookup('missing'));
      expect(isLookupError(missing), `a LookupError: ${missing}`);
      expect(
        missing instanceof Error && missing.name === 'LookupError',
        'an Error named LookupError',
      );
      expect(missing.message === 'ValuesModule.lookup failed: notFound', missing.message);
      expect(describeError(missing.data) === 'notFound:missing', describeError(missing.data));
      const odd = caught(() => v.half(3));
      expect(isLookupError(odd) && describeError(odd.data) === 'invalid:odd@3', `half: ${odd}`);
      expect(v.half(4) === 2, 'half success');
      const over = caught(() => v.limitedSum([2, 3], 4));
      expect(isOverflow(over) && !isLookupError(over), 'record error');
      expect(
        over.message === 'ValuesModule.limitedSum failed' &&
          same(over.data, { limit: 4, got: [2, 3] }),
        over.message,
      );
      const bag = v.bag();
      const outside = caught(() => bag.at(0));
      expect(
        isLookupError(outside) && outside.message === 'Bag.at failed: notFound',
        `object method: ${outside}`,
      );
      bag.dispose();
      // Framework failures are not declared errors.
      const unconvertible = caught(() => v.lookup('nan'));
      expect(!isLookupError(unconvertible), 'conversion failure is not a LookupError');
      expect(
        String(unconvertible).startsWith('TypeError: error conversion failed: '),
        String(unconvertible),
      );
      const boom = new Error('boom');
      const thrown = caught(() =>
        v.limitedSum(
          Object.defineProperty([0], 0, {
            get() {
              throw boom;
            },
          }),
          1,
        ),
      );
      expect(thrown === boom, 'getter exception propagates unchanged');
      expect(
        !isLookupError(new Error('x')) && !isLookupError({ name: 'LookupError', data: {} }),
        'look-alikes',
      );
      // Async: rejections, same shape.
      const busy = await v.lookupLater('busy', 0).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isLookupError(busy) && describeError(busy.data) === 'busy', `async: ${busy}`);
      expect(busy.message === 'ValuesModule.lookupLater failed: busy', busy.message);
      expect((await v.lookupLater('one', 0)) === 1, 'async success');
      const lost = await v.lookupLater('nan', 0).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(
        !isLookupError(lost) && /error conversion failed: /.test(String(lost)),
        `async conversion: ${lost}`,
      );
      expect(!/result conversion failed/.test(String(lost)), 'one prefix');
    },
  );

  await check('no settlement violations', () => {
    expect(v.violations.length === 0, v.violations.join('; '));
  });
  return results;
}
