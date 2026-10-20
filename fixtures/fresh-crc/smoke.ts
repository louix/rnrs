// The fresh author package's smoke test (React Native and web): real calls into the Rust crate.
import { crcModule } from '@demo/crc';

export interface SmokeResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

export async function runSmoke(): Promise<SmokeResult> {
  const crc = crcModule();
  const bytes = new Uint8Array(Array.from('123456789', (c) => c.charCodeAt(0)));
  const checks: SmokeResult['checks'] = [];
  const check = (name: string, body: () => string, want: string) => {
    try {
      const got = body();
      checks.push({ name, ok: got === want, detail: got });
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error) });
    }
  };
  check('crc32 of "123456789" bytes', () => String(crc.crc32(bytes.buffer.slice(0))), '3421780262');
  check('crc32 of no bytes', () => String(crc.crc32(new ArrayBuffer(0))), '0');
  check('crc32Hex of "123456789"', () => crc.crc32Hex('123456789'), 'cbf43926');
  check(
    'a typed-array view is rejected',
    () => {
      try {
        crc.crc32(bytes as any);
        return 'accepted';
      } catch (e) {
        return /TypeError/.test(String(e)) ? 'TypeError' : String(e);
      }
    },
    'TypeError',
  );
  return { ok: checks.every((c) => c.ok), checks };
}
