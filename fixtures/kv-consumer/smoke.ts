// kv consumer smoke (React Native on Android only: @rnrs/example-kv has no web target). Uses only
// the package's public API, with its own database, deleted at the end.
import {kvModule} from '@rnrs/example-kv';

export interface SmokeResult {
  ok: boolean;
  checks: {name: string; ok: boolean; detail: string}[];
}

const DB = 'consumer-smoke';
const bytes = (...xs: number[]) => new Uint8Array(xs).buffer;
const list = (b: ArrayBuffer | null) => (b ? Array.from(new Uint8Array(b)).join(',') : 'null');
const fail = (message: string): never => { throw new Error(message); };

export async function runSmoke(): Promise<SmokeResult> {
  const kv = kvModule();
  const checks: SmokeResult['checks'] = [];
  async function check(name: string, body: () => Promise<string | void>) {
    try {
      checks.push({name, ok: true, detail: (await body()) ?? ''});
    } catch (error) {
      checks.push({name, ok: false, detail: String((error as Error)?.message ?? error)});
    }
  }
  const rejection = async (p: () => Promise<unknown>) => {
    try { await p(); } catch (e: any) { return {name: String(e?.name), message: String(e?.message ?? e)}; }
    return fail('expected a rejection');
  };
  await kv.deleteDatabase(DB).catch(() => false);

  await check('values, keys, remove, flush', async () => {
    const store = await kv.open(DB);
    await store.put('a/1', bytes());
    await store.put('a/2', bytes(0, 128, 255));
    await store.put('b', bytes(7));
    if (list(await store.get('a/1')) !== '' || list(await store.get('a/2')) !== '0,128,255' || (await store.get('none')) !== null) fail('values');
    if ((await store.keys('a/', 10)).join(' ') !== 'a/1 a/2') fail('keys');
    if (!(await store.remove('b')) || (await store.remove('b'))) fail('remove');
    const flushed = await store.flush();
    await store.close();
    return `flushed ${flushed} bytes`;
  });

  await check('names and limits are validated before any work', async () => {
    for (const bad of ['../escape', 'a/b', 'UPPER', '', '.x']) {
      const e = await rejection(() => kv.open(bad));
      if (e.name !== 'RangeError' || !/database name/.test(e.message)) fail(`${bad}: ${e.name}: ${e.message}`);
    }
    const store = await kv.open(DB);
    const e = await rejection(() => store.keys('', 0));
    await store.close();
    if (e.name !== 'RangeError') fail(`limit: ${e.message}`);
  });

  await check('close waits for in-flight writes; later calls reject; reopen sees them', async () => {
    const store = await kv.open(DB);
    const writes = Array.from({length: 24}, (_, i) => store.put(`w/${i}`, bytes(i)).then(() => 'ok', e => String(e.message)));
    await store.close();
    const outcomes = await Promise.all(writes);
    const after = await rejection(() => store.get('w/0'));
    if (!/^closed:/.test(after.message)) fail(after.message);
    const reopened = await kv.open(DB);
    for (let i = 0; i < 24; i++) {
      const v = await reopened.get(`w/${i}`);
      const expected = outcomes[i] === 'ok' ? String(i) : 'null';
      if (list(v) !== expected) fail(`w/${i}: ${list(v)} after ${outcomes[i]}`);
    }
    await reopened.close();
    return `${outcomes.filter(o => o === 'ok').length} written before close, ${outcomes.filter(o => o !== 'ok').length} refused`;
  });

  await check('two handles share the database; deleteDatabase refuses while open', async () => {
    const a = await kv.open(DB);
    const b = await kv.open(DB);
    await a.put('shared', bytes(1));
    if (list(await b.get('shared')) !== '1') fail('not shared');
    await a.close();
    if (list(await b.get('shared')) !== '1') fail('closing one handle closed the other');
    const busy = await rejection(() => kv.deleteDatabase(DB));
    if (!/^busy:/.test(busy.message)) fail(busy.message);
    await b.close();
  });

  await check('cleanup: the smoke database is deleted', async () => {
    for (let i = 0; i < 50; i++) {
      try { if (await kv.deleteDatabase(DB)) return; fail('nothing deleted'); } catch (e: any) {
        if (!/^busy:/.test(String(e.message))) throw e;
        await new Promise(resolve => setTimeout(resolve, 50)); // a closed handle's release is in progress
      }
    }
    fail('database stayed busy');
  });

  return {ok: checks.every(c => c.ok), checks};
}
