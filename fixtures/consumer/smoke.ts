// Consumer smoke test: uses only the public APIs of the installed packages, as an app would.
// Shared by the clean React Native app and the Vite browser app (scripts/consumer/).
import {blake3Module} from '@rnrs/example-blake3';
import {counterModule} from '@rnrs/example-counter';
import vectors from './test_vectors.json';

export interface SmokeResult {
  ok: boolean;
  checks: {name: string; ok: boolean; detail: string}[];
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
const input = (len: number) => {
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = i % 251;
  return bytes.buffer;
};

export async function runSmoke(): Promise<SmokeResult> {
  const checks: SmokeResult['checks'] = [];
  async function check(name: string, body: () => Promise<string | void> | string | void) {
    try {
      checks.push({name, ok: true, detail: (await body()) ?? ''});
    } catch (error) {
      checks.push({name, ok: false, detail: String((error as Error)?.message ?? error)});
    }
  }
  const fail = (message: string) => { throw new Error(message); };

  await check('counter: sync and async methods', async () => {
    const c = counterModule().create(1.5);
    if (c.add(1) !== 2.5) fail('add');
    if ((await c.addLater(2, 5, false)) !== 4.5) fail('addLater');
    c.dispose();
  });

  await check('blake3: 35 official vectors (hash, keyed_hash, derive_key, 131-byte XOF)', () => {
    const b3 = blake3Module();
    const key = new Uint8Array(Array.from(vectors.key, c => c.charCodeAt(0))).buffer;
    for (const c of vectors.cases) {
      const data = input(c.input_len);
      if (hex(b3.hash(data)) !== c.hash.slice(0, 64)) fail(`hash ${c.input_len}`);
      if (hex(b3.keyedHash(key, data)) !== c.keyed_hash.slice(0, 64)) fail(`keyed ${c.input_len}`);
      if (hex(b3.deriveKey(vectors.context_string, data)) !== c.derive_key.slice(0, 64)) fail(`derive ${c.input_len}`);
      const h = b3.hasher();
      h.update(data);
      if (hex(h.finalizeXof(131)) !== c.hash) fail(`xof ${c.input_len}`);
      h.dispose();
    }
    return `${vectors.cases.length} cases`;
  });

  await check('blake3: validation and async hashing', async () => {
    const b3 = blake3Module();
    let message = '';
    try { b3.keyedHash(new ArrayBuffer(31), new ArrayBuffer(0)); } catch (e) { message = String(e); }
    if (!message.includes('key must be exactly 32 bytes, got 31')) fail(`key validation: ${message}`);
    try { b3.hash(new Uint8Array(1) as any); message = ''; } catch (e) { message = String(e); }
    if (!message.includes('must be an ArrayBuffer')) fail(`view rejection: ${message}`);
    const data = input(1 << 18);
    if (hex(await b3.hashLater(data)) !== hex(b3.hash(data))) fail('hashLater');
    if (b3.hash(new ArrayBuffer(0)).byteLength !== 32) fail('empty input');
  });

  return {ok: checks.every(c => c.ok), checks};
}
