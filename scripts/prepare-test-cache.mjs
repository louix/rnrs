// npm ci caches tarballs, but not necessarily the registry metadata needed by a new
// offline install. Resolve the exact consumer-test dependencies before going offline.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const cli = JSON.parse(
  readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'),
);
const work = mkdtempSync(path.join(tmpdir(), 'rnrs-test-cache-'));
try {
  writeFileSync(
    path.join(work, 'package.json'),
    JSON.stringify({
      private: true,
      dependencies: {
        ...cli.dependencies,
        typescript: root.devDependencies.typescript,
        typescript6: `npm:typescript@${cli.dependencies.typescript}`,
      },
    }),
  );
  const result = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: work,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Preparing the npm test cache failed (${result.status})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
