// Sets rustNativeApp.sourceBuild in a consumer app's package.json: the modules the app compiles
// from source instead of linking their prebuilt binaries (needs Rust; app configuration, not
// native code). node scripts/consumer/source-build.mjs <app-dir> <value>, where value is "*"
// (every module), a comma-separated list of package names, or "" (none: prebuilt binaries only,
// the setting is removed). The consumer scripts pass RNRS_SOURCE_BUILD, default "*".
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [dir, value = '*'] = process.argv.slice(2);
const file = path.join(dir, 'package.json');
const app = JSON.parse(readFileSync(file, 'utf8'));
const { sourceBuild: _, ...rest } = app.rustNativeApp ?? {};
const sourceBuild = value === '*' ? '*' : value.split(',').filter(Boolean);
app.rustNativeApp = value === '' ? rest : { ...rest, sourceBuild };
if (!Object.keys(app.rustNativeApp).length) delete app.rustNativeApp;
writeFileSync(file, `${JSON.stringify(app, null, 2)}\n`);
console.log(
  `rustNativeApp.sourceBuild = ${JSON.stringify(app.rustNativeApp?.sourceBuild ?? null)}`,
);
