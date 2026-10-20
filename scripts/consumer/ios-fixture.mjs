// The iOS consumer app's JS changes, written into an app directory: App.tsx, the device test,
// the smoke test, the blake3 vectors, and the lab's shared suites with their repository
// imports pointed at the installed packages. Used by scripts/consumer/ios-app.sh (the real
// app) and scripts/typecheck-ios-fixture.mjs (the same files, type-checked in the repo).
// `--modules` writes the http/kv consumer instead (fixtures/ios-modules-consumer: App.tsx,
// modules.ts, and the shared http and kv consumer smokes).
//   node scripts/consumer/ios-fixture.mjs [--modules] <app-dir>
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SUITES = ['conformance', 'meter-suite', 'values-suite', 'blake3-suite'];
/** Repository import -> installed package, as an app sees them. */
const IMPORTS = {
  '../../packages/rnr-runtime/src/runtime': '@rnrs/runtime',
  '../../.generated/rnr/counter': '@rnrs/example-counter',
  '../../.generated/rnr/meter': '@rnrs/labs-meter',
  '../../.generated/rnr/values': '@rnrs/labs-values',
  '../../.generated/rnr/rnr_blake3': '@rnrs/example-blake3',
  '../../fixtures/blake3/test_vectors.json': '../test_vectors.json',
};

export function writeIosFixture(app) {
  for (const f of ['ios/App.tsx', 'ios/device.ts', 'smoke.ts'])
    copyFileSync(path.join(ROOT, 'fixtures/consumer', f), path.join(app, path.basename(f)));
  copyFileSync(
    path.join(ROOT, 'fixtures/blake3/test_vectors.json'),
    path.join(app, 'test_vectors.json'),
  );
  mkdirSync(path.join(app, 'suites'), { recursive: true });
  for (const suite of SUITES) {
    let text = readFileSync(path.join(ROOT, 'src/rnr', `${suite}.ts`), 'utf8');
    for (const [from, to] of Object.entries(IMPORTS))
      text = text.replaceAll(`'${from}'`, `'${to}'`);
    if (/from '\.\.\/\.\.\//.test(text))
      throw new Error(`suite ${suite} still imports from the repository`);
    writeFileSync(path.join(app, 'suites', `${suite}.ts`), text);
  }
}

/** The http/kv consumer: modules.ts drives both smokes, a reload and a process restart. */
export function writeIosModulesFixture(app) {
  for (const f of ['App.tsx', 'modules.ts'])
    copyFileSync(path.join(ROOT, 'fixtures/ios-modules-consumer', f), path.join(app, f));
  copyFileSync(path.join(ROOT, 'fixtures/http-consumer/smoke.ts'), path.join(app, 'http-smoke.ts'));
  copyFileSync(path.join(ROOT, 'fixtures/kv-consumer/smoke.ts'), path.join(app, 'kv-smoke.ts'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const modules = process.argv[2] === '--modules';
  (modules ? writeIosModulesFixture : writeIosFixture)(path.resolve(process.argv.at(-1)));
}
