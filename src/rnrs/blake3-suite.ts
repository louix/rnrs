// Shared BLAKE3 suite (packages/blake3), run unchanged on Android and in the browser against
// the official test vectors (fixtures/blake3/test_vectors.json, BLAKE3 1.8.2).
import { Hasher, blake3Module } from '../../.generated/rnr/rnrs_blake3';
import vectors from '../../fixtures/blake3/test_vectors.json';
import type { CheckResult } from './conformance';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
class CheckFailure extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailure(message);
}

const hex = (b: ArrayBuffer) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const input = (len: number) => new Uint8Array(len).map((_, i) => i % 251).buffer;
const ascii = (s: string) => new Uint8Array(Array.from(s, (c) => c.charCodeAt(0))).buffer;

export async function runBlake3Suite(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const b3 = blake3Module();
  async function check(name: string, body: () => Promise<string | void> | string | void) {
    const start = now();
    try {
      const detail = (await body()) ?? '';
      results.push({ name: `blake3: ${name}`, ok: true, ms: now() - start, detail });
    } catch (error) {
      results.push({
        name: `blake3: ${name}`,
        ok: false,
        ms: now() - start,
        detail: String(error instanceof Error ? error.message : error),
      });
    }
  }
  const key = ascii(vectors.key);

  await check('official vectors: hash, keyed_hash, derive_key and 131-byte XOF', () => {
    for (const c of vectors.cases) {
      const data = input(c.input_len);
      expect(hex(b3.hash(data)) === c.hash.slice(0, 64), `hash ${c.input_len}`);
      expect(b3.hashHex(data) === c.hash.slice(0, 64), `hashHex ${c.input_len}`);
      expect(hex(b3.keyedHash(key, data)) === c.keyed_hash.slice(0, 64), `keyed ${c.input_len}`);
      expect(
        hex(b3.deriveKey(vectors.context_string, data)) === c.derive_key.slice(0, 64),
        `derive ${c.input_len}`,
      );
      for (const [hasher, expected] of [
        [b3.hasher(), c.hash],
        [b3.keyedHasher(key), c.keyed_hash],
        [b3.derivingHasher(vectors.context_string), c.derive_key],
      ] as const) {
        hasher.update(data);
        expect(hex(hasher.finalizeXof(131)) === expected, `xof ${c.input_len}`);
        hasher.dispose();
      }
    }
    return `${vectors.cases.length} cases, up to ${Math.max(...vectors.cases.map((c) => c.input_len))} bytes`;
  });

  await check('incremental updates in uneven chunks; finalize keeps state; reset', () => {
    const data = new Uint8Array(input(102400));
    const h = b3.hasher();
    for (let i = 0; i < data.length; i += 777) h.update(data.slice(i, i + 777).buffer);
    const once = hex(b3.hash(data.buffer));
    expect(hex(h.finalize()) === once && hex(h.finalize()) === once, 'finalize is repeatable');
    h.update(new ArrayBuffer(0));
    expect(hex(h.finalize()) === once, 'empty update changes nothing');
    h.reset();
    expect(hex(h.finalize()) === hex(b3.hash(new ArrayBuffer(0))), 'reset');
    expect(h instanceof Hasher, 'wrapper class');
  });

  await check('validation: key length, XOF length, input type', () => {
    for (const len of [0, 31, 33]) {
      let message = '';
      try {
        b3.keyedHash(new ArrayBuffer(len), new ArrayBuffer(1));
      } catch (e) {
        message = String(e);
      }
      expect(
        message === `Error: key must be exactly 32 bytes, got ${len}`,
        `keyedHash ${len}: ${message}`,
      );
      try {
        b3.keyedHasher(new ArrayBuffer(len));
        message = '';
      } catch (e) {
        message = String(e);
      }
      expect(message.includes('key must be exactly 32 bytes'), `keyedHasher ${len}`);
    }
    const h = b3.hasher();
    for (const bad of [-1, 1.5, 1048577, NaN]) {
      let message = '';
      try {
        h.finalizeXof(bad);
      } catch (e) {
        message = String(e);
      }
      expect(message.startsWith('Error: length must be'), `xof ${bad}: ${message}`);
    }
    expect(h.finalizeXof(0).byteLength === 0, 'empty XOF');
    let message = '';
    try {
      b3.hash(new Uint8Array(4) as any);
    } catch (e) {
      message = String(e);
    }
    expect(
      message.startsWith('TypeError: data must be an ArrayBuffer, got a typed array'),
      message,
    );
  });

  await check(
    'async: hashLater, a disposed hasher kept alive by updateLater, cancellation',
    async () => {
      const data = input(1 << 20);
      const expected = hex(b3.hash(data));
      expect(hex(await b3.hashLater(data)) === expected, 'hashLater');
      const h = b3.hasher();
      const pending = h.updateLater(data);
      h.dispose(); // the operation retains the Rust hasher
      await pending;
      let disposed = '';
      try {
        h.finalize();
      } catch (e) {
        disposed = String(e);
      }
      expect(disposed === 'Error: Hasher is disposed', disposed);
      const controller = new AbortController();
      const big = b3.hashLater(input(8 << 20), { signal: controller.signal });
      controller.abort();
      let outcome: string;
      try {
        await big;
        outcome = 'completed before the abort';
      } catch (e: any) {
        outcome = e.name;
      }
      expect(outcome === 'AbortError' || outcome === 'completed before the abort', outcome);
      expect(b3.violations.length === 0, b3.violations.join('; '));
      return `8 MiB hash with immediate abort: ${outcome}`;
    },
  );

  await check('updateLater: busy gate and whole-update commits', async () => {
    const digest = (...parts: ArrayBuffer[]) => {
      const h = b3.hasher();
      parts.forEach((p) => h.update(p));
      const d = hex(h.finalize());
      h.dispose();
      return d;
    };
    const head = ascii('head'),
      x = ascii('x');
    const a = input(4 << 20),
      b = new Uint8Array(1 << 20).fill(7).buffer;
    // Two concurrent updates: exactly one runs, the other fails busy; the digest reflects it whole.
    const h = b3.hasher();
    h.update(head);
    const settled = await Promise.allSettled([h.updateLater(a), h.updateLater(b)]);
    const won = settled.map((s) => s.status === 'fulfilled');
    expect(won.filter(Boolean).length === 1, `fulfilled: ${won}`);
    const lost = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(/hasher is busy/.test(String(lost.reason)), String(lost.reason));
    expect(
      hex(h.finalize()) === digest(head, won[0] ? a : b),
      'digest is head + the update that ran',
    );
    // A sync update issued right after: either ordered before the async one or rejected as busy.
    const g = b3.hasher();
    g.update(head);
    const pending = g.updateLater(a);
    let sync = 'ok';
    try {
      g.update(x);
    } catch (e) {
      sync = String(e);
    }
    await pending;
    const d = hex(g.finalize());
    expect(
      sync === 'ok'
        ? d === digest(head, x, a)
        : /hasher is busy/.test(sync) && d === digest(head, a),
      `sync: ${sync}`,
    );
    // Aborted: the state is either unchanged or includes the whole update, never a prefix.
    const c = b3.hasher();
    c.update(head);
    const controller = new AbortController();
    const op = c.updateLater(input(8 << 20), { signal: controller.signal });
    controller.abort();
    let outcome = 'resolved';
    try {
      await op;
    } catch (e: any) {
      outcome = e.name;
    }
    await b3.hashLater(new ArrayBuffer(0)); // let the cancelled operation exit and release the gate
    let state = '';
    for (let i = 0; i < 200 && !state; i++) {
      try {
        state = hex(c.finalize());
      } catch (e) {
        if (!/hasher is busy/.test(String(e))) throw e;
        await b3.hashLater(new ArrayBuffer(0));
      }
    }
    expect(
      state === digest(head) || state === digest(head, input(8 << 20)),
      `state after ${outcome}`,
    );
    [h, g, c].forEach((o) => o.dispose());
    return `concurrent loser: busy; sync after start: ${sync === 'ok' ? 'ordered before' : 'busy'}; abort: ${outcome}, state ${state === digest(head) ? 'unchanged' : 'whole update'}`;
  });

  await check('timing note (not a benchmark): 1 MiB hash', () => {
    const data = input(1 << 20);
    const start = now();
    for (let i = 0; i < 5; i++) b3.hash(data);
    return `${((now() - start) / 5).toFixed(2)} ms per 1 MiB hash including the input copy`;
  });
  return results;
}
