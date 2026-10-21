// Type-checks the iOS consumer apps' JS (scripts/consumer/ios-fixture.mjs: the counter/blake3
// app and the http/kv app) in the repository: the same files the apps get, with the package
// names mapped to the repository's runtime and generated module wrappers (run
// `node tools/rnr-gen/cli.mjs generate` first).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIosFixture, writeIosModulesFixture } from './consumer/ios-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATHS = {
  '@rnrs/runtime': 'packages/rnr-runtime/src/index.ts',
  '@rnrs/runtime/testing': 'packages/rnr-runtime/src/testing.ts',
  '@rnrs/example-counter': '.generated/rnr/counter/index.ts',
  '@rnrs/labs-meter': '.generated/rnr/meter/index.ts',
  '@rnrs/labs-values': '.generated/rnr/values/index.ts',
  '@rnrs/example-blake3': '.generated/rnr/rnrs_blake3/index.ts',
  '@rnrs/example-http': '.generated/rnr/rnrs_http/index.ts',
  '@rnrs/example-kv': '.generated/rnr/rnrs_kv/index.ts',
};
for (const [name, write] of [
  ['ios-fixture-typecheck', writeIosFixture],
  ['ios-modules-fixture-typecheck', writeIosModulesFixture],
]) {
  const dir = path.join(ROOT, '.generated', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  write(dir);
  const rel = (p) => path.relative(dir, path.join(ROOT, p));
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        extends: rel('tsconfig.json'),
        compilerOptions: {
          // Relative to this tsconfig (no baseUrl, which TypeScript 6 deprecates).
          paths: Object.fromEntries(Object.entries(PATHS).map(([k, v]) => [k, [rel(v)]])),
        },
        include: ['.', rel('src/rn-globals.d.ts')],
      },
      null,
      2,
    ),
  );
  execFileSync(path.join(ROOT, 'node_modules/.bin/tsc'), ['-p', dir], { stdio: 'inherit' });
}
console.log('ios fixtures: type check passed');
