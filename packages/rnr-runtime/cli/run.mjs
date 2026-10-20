#!/usr/bin/env node
// Runs the rnrs CLI for the framework's native build hooks (the Android Gradle task and the
// iOS script phase build the app's Rust bundle with `rnrs build`). Not a bin: apps and authors
// run `rnrs` from @rnrs/cli. The CLI is @rnrs/runtime's exact-version dependency, resolved
// from this package the way Node resolves it.
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const runtime = path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
const {version} = JSON.parse(readFileSync(runtime, 'utf8'));
let manifest;
try {
  manifest = createRequire(runtime).resolve('@rnrs/cli/package.json');
} catch {
  console.error(`rnrs: @rnrs/cli is not installed (needed by @rnrs/runtime ${version} at ${path.dirname(runtime)} to build the app's Rust bundle). ` +
    `Reinstall the app's dependencies, or add it: npm install --save-dev @rnrs/cli@${version}`);
  process.exit(1);
}
const cli = JSON.parse(readFileSync(manifest, 'utf8'));
if (cli.version !== version) {
  console.error(`rnrs: @rnrs/runtime ${version} requires @rnrs/cli ${version}, but resolved ${cli.version} at ${path.dirname(manifest)}. Install matching versions of both packages.`);
  process.exit(1);
}
// The bin runs the command line it was given: process.argv is this script's.
await import(pathToFileURL(path.join(path.dirname(manifest), cli.bin.rnrs)).href);
