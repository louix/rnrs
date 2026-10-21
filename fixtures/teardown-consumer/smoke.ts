// Focused checks of the runtime-teardown hook (rnrs-core lifecycle) through the web backend
// (RnrWebAdapter -> Adapter::teardown -> TeardownScope::retire_all), using only the fixture's
// public API: a resource registered with an adapter generation's scope is retired when that
// generation is torn down, even though JS still holds its wrapper.
import {
  createTeardownProbeModuleForTesting,
  teardownProbeModule,
} from '@rnrs/labs-teardown-probe';

export interface SmokeResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

export async function runSmoke(): Promise<SmokeResult> {
  const checks: SmokeResult['checks'] = [];
  const check = (name: string, body: () => string | void) => {
    try {
      checks.push({ name, ok: true, detail: body() ?? '' });
    } catch (error) {
      checks.push({ name, ok: false, detail: String((error as Error)?.message ?? error) });
    }
  };
  const fail = (message: string) => {
    throw new Error(message);
  };

  check('the runtime module and a testing generation both capture a teardown scope', () => {
    if (!teardownProbeModule().owned()) fail('runtime module unowned');
    const m = createTeardownProbeModuleForTesting(4);
    if (!m.owned()) fail('testing module unowned');
    m.teardown();
  });

  check('teardown retires a resource JS still holds, and only live resources', () => {
    const m = createTeardownProbeModuleForTesting(4);
    const before = m.retiredTotal();
    const held = m.track(); // retained by JS across the teardown
    const disposed = m.track(); // released before the teardown: nothing left to retire
    disposed.dispose();
    if (held.retired()) fail('retired before teardown');
    m.teardown();
    const next = createTeardownProbeModuleForTesting(4);
    const after = next.retiredTotal();
    if (after !== before + 1) fail(`retiredTotal ${before} -> ${after}, expected +1`);
    let closedError = '';
    try {
      held.retired();
    } catch (error) {
      closedError = String(error);
    }
    if (!/closed/.test(closedError))
      fail(`the torn-down generation's wrapper did not fail as closed: ${closedError}`);
    next.teardown();
    return `retiredTotal ${before} -> ${after}; old wrapper: ${closedError.slice(0, 60)}`;
  });

  check('teardown is idempotent and a later generation is unaffected', () => {
    const m = createTeardownProbeModuleForTesting(4);
    const kept = m.track();
    const before = m.retiredTotal();
    m.teardown();
    m.teardown();
    const next = createTeardownProbeModuleForTesting(4);
    const t = next.track();
    if (next.retiredTotal() !== before + 1) fail('a second teardown retired again');
    if (t.retired()) fail('a new generation resource was retired');
    next.teardown();
    void kept;
  });

  return { ok: checks.every((c) => c.ok), checks };
}
