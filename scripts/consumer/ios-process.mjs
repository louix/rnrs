// Finds the process of one installed iOS app from devicectl's JSON (pure, unit-tested in
// scripts/ios-process.test.mjs). Other apps may have the same executable name (the RN
// template's apps are all "HelloWorld"), so the match is by the installed app's bundle path:
//   `devicectl device info apps` -> result.apps[] {bundleIdentifier, url}
//   `devicectl device info processes` -> result.runningProcesses[] {processIdentifier, executable}
// Exactly one installed app with the bundle id and exactly one process whose executable is
// <that app's bundle path>/<executable name> are required; anything else is an error.

/** A file URL or path as a comparable absolute path: decoded, no trailing slash, and
 *  without the /private prefix that iOS may or may not report for /var. */
export function normalizePath(urlOrPath) {
  let p = String(urlOrPath ?? '');
  if (p.startsWith('file://')) p = decodeURIComponent(new URL(p).pathname);
  p = p.replace(/\/+$/, '');
  return p.startsWith('/private/') ? p.slice('/private'.length) : p;
}

/** The pid of `bundleId`'s running process, or throws with the reason. */
export function selectAppPid({apps, processes, bundleId, executable}) {
  const installed = (apps ?? []).filter(a => a.bundleIdentifier === bundleId);
  if (installed.length !== 1) throw new Error(`expected one installed app ${bundleId}, found ${installed.length}`);
  if (!installed[0].url) throw new Error(`devicectl reported no bundle URL for ${bundleId}`);
  const expected = `${normalizePath(installed[0].url)}/${executable}`;
  const running = (processes ?? []).filter(p => p.executable && normalizePath(p.executable) === expected);
  if (running.length !== 1) throw new Error(`expected one process ${expected}, found ${running.length}`);
  const pid = running[0].processIdentifier;
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid process id ${pid} for ${expected}`);
  return pid;
}
