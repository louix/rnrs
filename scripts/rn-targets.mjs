// CLI wrapper kept for the documented command; the logic lives in the generator.
// Usage: node scripts/rn-targets.mjs check <package-dir> <target>
export * from '../tools/rnrs-gen/targets.mjs';
import { main } from '../tools/rnrs-gen/targets.mjs';
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
