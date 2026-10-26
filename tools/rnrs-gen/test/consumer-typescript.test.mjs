// The packed @rnrs/cli in an app that type-checks with TypeScript 7: the app's tsc stays 7 in
// every install order, and the generator still gets the TypeScript 6 compiler API (its own
// typescript@6.0.3 dependency, nested under the CLI). Prepare the offline npm cache with
// node scripts/prepare-test-cache.mjs (npm ci alone need not cache registry metadata).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../cli.mjs';

const TS7 = '7.0.2';
const CLI_TS6 = JSON.parse(readFileSync(path.join(ROOT, 'packages/cli/package.json'), 'utf8'))
  .dependencies.typescript;

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')} failed in ${cwd}:\n${r.stdout}${r.stderr}`);
  return r.stdout;
};
const npm = (app, ...args) =>
  run(
    'npm',
    [...args, '--offline', '--no-audit', '--no-fund', '--legacy-peer-deps', '--ignore-scripts'],
    app,
  );
const newApp = (work, name) => {
  const app = path.join(work, name);
  mkdirSync(app);
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name, private: true }));
  return app;
};
/** The version `npx tsc` runs in the app. */
const tscVersion = (app) =>
  run(path.join(app, 'node_modules/.bin/tsc'), ['--version'], app)
    .trim()
    .replace(/^Version /, '');
/** The TypeScript API the installed generator loaded. */
const generatorApi = (app) =>
  JSON.parse(
    run(
      'node',
      [
        '--input-type=module',
        '-e',
        'console.log(JSON.stringify((await import(process.argv[1])).typescriptApi))',
        pathToFileURL(path.join(app, 'node_modules/@rnrs/cli/generator/parse.mjs')).href,
      ],
      app,
    ),
  );
/** A new module package in the app: rnrs init, then rnrs generate (parses the spec). */
const generateModule = (app) => {
  const dir = path.join(app, 'demo-mod');
  mkdirSync(dir);
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'demo-mod', version: '0.3.0' }),
  );
  const rnrs = path.join(app, 'node_modules/@rnrs/cli/bin/rnrs.mjs');
  run('node', [rnrs, 'init', '.', '--name', 'demo-mod', '--targets', 'web'], dir);
  return run('node', [rnrs, 'generate', '.'], dir);
};
/** The generator uses the CLI's own typescript dependency (packages/cli/package.json). */
const assertGeneratorApi = (app) => {
  const api = generatorApi(app);
  assert.equal(api.name, 'typescript', `generator TypeScript API: ${JSON.stringify(api)}`);
  assert.equal(api.version, CLI_TS6, `generator TypeScript API: ${JSON.stringify(api)}`);
  return api;
};

test(
  'packed @rnrs/cli keeps the app on TypeScript 7 and the generator on the TS 6 API',
  {
    timeout: 600_000,
  },
  () => {
    const work = mkdtempSync(path.join(tmpdir(), 'rnrs-consumer-ts-'));
    try {
      const packDir = path.join(work, 'pack');
      const packed = spawnSync('node', [path.join(ROOT, 'scripts/pack.mjs')], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, RNRS_PACK_OUT: packDir },
      });
      assert.equal(packed.status, 0, packed.stderr);
      const tarballs = ['rnrs-cli-0.3.0.tgz', 'rnrs-runtime-0.3.0.tgz'].map((t) =>
        path.join(packDir, t),
      );

      // An existing TypeScript 7 app, then the CLI and runtime installed into it.
      const existing = newApp(work, 'existing-ts7');
      npm(existing, 'install', '--save-exact', `typescript@${TS7}`);
      assert.equal(tscVersion(existing), TS7);
      npm(existing, 'install', ...tarballs);
      assert.equal(tscVersion(existing), TS7, 'installing @rnrs/cli changed the app tsc');
      const api = assertGeneratorApi(existing);
      assert.ok(
        api.file.startsWith(path.join(existing, 'node_modules/@rnrs/cli/node_modules/typescript')),
        `the CLI's typescript is nested under it: ${api.file}`,
      );
      assert.match(generateModule(existing), /rnrs_interface\.rs/);
      // A clean install from the app's lock keeps the same layout.
      rmSync(path.join(existing, 'node_modules'), { recursive: true });
      npm(existing, 'ci');
      assert.equal(tscVersion(existing), TS7, 'npm ci');
      assertGeneratorApi(existing);

      // TypeScript 7, the CLI and the runtime installed together.
      const grouped = newApp(work, 'grouped');
      npm(grouped, 'install', '--save-exact', `typescript@${TS7}`, ...tarballs);
      assert.equal(tscVersion(grouped), TS7);
      assertGeneratorApi(grouped);
      assert.match(generateModule(grouped), /rnrs_interface\.rs/);

      // An app without typescript: the CLI's own typescript@6.0.3 serves the generator.
      const plain = newApp(work, 'no-typescript');
      npm(plain, 'install', ...tarballs);
      assertGeneratorApi(plain);
      assert.match(generateModule(plain), /rnrs_interface\.rs/);

      // An app with its own typescript6 at another 6.x: the generator keeps the CLI's pin. The app's
      // typescript6 is a local stand-in (version 6.0.2 with a createProgram), so this stays offline.
      const aliased = newApp(work, 'app-typescript6');
      const standIn = path.join(work, 'typescript6-6.0.2');
      mkdirSync(standIn);
      writeFileSync(
        path.join(standIn, 'package.json'),
        JSON.stringify({ name: 'typescript6', version: '6.0.2', main: 'index.js' }),
      );
      writeFileSync(
        path.join(standIn, 'index.js'),
        "module.exports = { version: '6.0.2', createProgram() {} };\n",
      );
      npm(aliased, 'install', '--save-exact', `typescript@${TS7}`, standIn);
      npm(aliased, 'install', ...tarballs);
      assert.equal(tscVersion(aliased), TS7);
      assertGeneratorApi(aliased);
      assert.match(generateModule(aliased), /rnrs_interface\.rs/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
