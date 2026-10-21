#!/usr/bin/env node
// rnrs CLI. In the packed @rnrs/cli the generator sits in ../generator; in the repository it
// is tools/rnrs-gen.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packed = path.join(here, '../generator/cli.mjs');
const cli = existsSync(packed) ? packed : path.join(here, '../../../tools/rnrs-gen/cli.mjs');
const { main } = await import(pathToFileURL(cli).href);
process.exit(await main(process.argv.slice(2)));
