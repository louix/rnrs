// Framework/backend version-mismatch diagnostics, run on both platforms: wrappers generated
// for a newer call protocol, and native/Wasm adapters built by an older @rnrs/runtime, fail
// with actionable errors instead of a TypeError on first call.
import { checkWrapperProtocol, RUNTIME_PROTOCOL } from '../../packages/runtime/src/runtime';
import { refuseWasmAdapter } from '../../packages/runtime/src/web-backend';
import type { CheckResult } from './conformance';

export function runProtocolSuite(
  platform: string,
  checkAdapter: (fake: Record<string, unknown>, name: string) => void,
  complete: Record<string, unknown>,
  stale: Record<string, unknown>,
  missing: string,
): CheckResult[] {
  const message = (f: () => void) => {
    try {
      f();
      return '';
    } catch (e) {
      return String((e as Error).message);
    }
  };
  const checks: [string, boolean, string][] = [];
  const newer = message(() =>
    checkWrapperProtocol({ name: 'FutureModule', protocol: RUNTIME_PROTOCOL + 1 }),
  );
  checks.push([
    'a wrapper for a newer call protocol is refused with an actionable error',
    /FutureModule was generated for call protocol 3, but this @rnrs\/runtime implements up to 2/.test(
      newer,
    ),
    newer,
  ]);
  checks.push([
    'older (array-only) and current wrappers are accepted',
    message(() => checkWrapperProtocol({ name: 'Old' })) === '' &&
      message(() => checkWrapperProtocol({ name: 'Current', protocol: 2 })) === '',
    '',
  ]);
  const old = message(() => checkAdapter(stale, 'StaleModule'));
  checks.push([
    `an adapter from an older ${platform} build is refused with an actionable error`,
    old.includes('does not match this JS runtime') && old.includes(`"${missing}"`),
    old,
  ]);
  checks.push([
    'a complete adapter is accepted',
    message(() => checkAdapter(complete, 'Current')) === '',
    '',
  ]);
  if (platform === 'Wasm') {
    // A refused Wasm adapter is torn down and freed exactly once each, in that order, even
    // when teardown throws, and the original error is the one reported.
    const results: string[] = [];
    for (const teardownThrows of [false, true]) {
      const calls: string[] = [];
      const fake = {
        teardown() {
          calls.push('teardown');
          if (teardownThrows) throw new Error('teardown failed');
        },
        free() {
          calls.push('free');
        },
      };
      const reported = message(() => refuseWasmAdapter(fake, new Error('mismatch')));
      results.push(`${calls.join(',')}|${reported}`);
    }
    checks.push([
      'a refused Wasm adapter is torn down then freed, once each, even if teardown throws',
      results.every((r) => r === 'teardown,free|mismatch'),
      results.join('; '),
    ]);
  }
  return checks.map(([name, ok, detail]) => ({ name: `protocol: ${name}`, ok, ms: 0, detail }));
}
