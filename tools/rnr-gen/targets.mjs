// Supported-target declarations (`rustNative.targets`).
import {readFileSync} from 'node:fs';
import path from 'node:path';

/** Target names a package may declare. */
export const KNOWN_TARGETS = ['android', 'ios', 'web'];
/** Targets rnr can actually build and run. Every known target is implemented now; the check
 *  stays so that a future known name cannot be declared before its backend exists. */
export const IMPLEMENTED_TARGETS = ['android', 'ios', 'web'];

/** Returns the declared targets, or throws an Error with an actionable message. */
export function declaredTargets(manifest, manifestPath = 'package.json') {
  const name = manifest?.name ?? manifestPath;
  const targets = manifest?.rustNative?.targets;
  if (!Array.isArray(targets) || targets.length === 0)
    throw new Error(`${name}: ${manifestPath} must declare a nonempty "rustNative.targets" array, e.g. ["android", "web"]. Targets are never assumed.`);
  for (const target of targets) {
    if (!KNOWN_TARGETS.includes(target))
      throw new Error(`${name}: unknown target ${JSON.stringify(target)} in rustNative.targets; known targets: ${KNOWN_TARGETS.join(', ')}.`);
  }
  if (new Set(targets).size !== targets.length) throw new Error(`${name}: duplicate entries in rustNative.targets.`);
  return targets;
}

/** The declared targets, which must all be implemented: what generate, check, pack-js and
 *  bundling accept, so a package cannot be generated or packed with a promise of platform
 *  support that does not exist. `implemented` is overridable for tests. */
export function implementedTargets(manifest, manifestPath = 'package.json', implemented = IMPLEMENTED_TARGETS) {
  const targets = declaredTargets(manifest, manifestPath);
  const missing = targets.filter(t => !implemented.includes(t));
  if (missing.length) {
    const name = manifest?.name ?? manifestPath;
    throw new Error(`${name}: rustNative.targets in ${manifestPath} declares ${missing.map(t => JSON.stringify(t)).join(', ')}, which rnr does not implement yet ` +
      `(implemented: ${implemented.join(', ')}). Declaring it would promise support that does not exist; remove it until a backend is available.`);
  }
  return targets;
}

/** Throws unless `requested` is a declared target of the package. */
export function requireTarget(manifest, requested, manifestPath = 'package.json') {
  const targets = declaredTargets(manifest, manifestPath);
  if (!KNOWN_TARGETS.includes(requested))
    throw new Error(`Unknown target ${JSON.stringify(requested)}; known targets: ${KNOWN_TARGETS.join(', ')}.`);
  if (!targets.includes(requested))
    throw new Error(`${manifest.name} does not support target "${requested}" (declared: ${targets.join(', ')}). ` +
      `Build or import it only for a declared target, or add "${requested}" to rustNative.targets in ${manifestPath} once an implementation exists.`);
  return targets;
}

/** `check <package-dir> <target>`: exits 1 with an actionable diagnostic. */
export function main(argv) {
  const [command, dir, target] = argv;
  if (command !== 'check' || !dir || !target) {
    console.error('usage: node scripts/rn-targets.mjs check <package-dir> <target>');
    process.exit(2);
  }
  const manifestPath = path.join(dir, 'package.json');
  try {
    const targets = requireTarget(JSON.parse(readFileSync(manifestPath, 'utf8')), target, manifestPath);
    console.log(`ok: ${target} (declared: ${targets.join(', ')})`);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
