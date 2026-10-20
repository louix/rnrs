// Sets rustNativeApp.logging in a consumer app's package.json (app configuration, not native
// code): node scripts/consumer/app-logging.mjs <app-dir> '<json>'. Used by the consumer scripts
// when RNR_APP_LOGGING is set, e.g. RNR_APP_LOGGING='{"filter":"info","iosPrivacy":"public"}'.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [dir, value] = process.argv.slice(2);
const file = path.join(dir, 'package.json');
const app = JSON.parse(readFileSync(file, 'utf8'));
app.rustNativeApp = { ...app.rustNativeApp, logging: JSON.parse(value) };
writeFileSync(file, `${JSON.stringify(app, null, 2)}\n`);
console.log(`rustNativeApp.logging = ${JSON.stringify(app.rustNativeApp.logging)}`);
