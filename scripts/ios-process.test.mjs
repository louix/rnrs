import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePath, selectAppPid} from './consumer/ios-process.mjs';

const ours = 'file:///private/var/containers/Bundle/Application/AAAA-1111/HelloWorld.app/';
const other = 'file:///private/var/containers/Bundle/Application/BBBB-2222/HelloWorld.app/';
const apps = [
  {bundleIdentifier: 'dev.example.ours', url: ours},
  {bundleIdentifier: 'dev.example.compare', url: other},
];
const proc = (pid, url) => ({processIdentifier: pid, executable: url});
const select = (extra = {}) => selectAppPid({apps, bundleId: 'dev.example.ours', executable: 'HelloWorld', ...extra});

test('paths: file URLs are decoded, trailing slashes and /private dropped', () => {
  assert.equal(normalizePath('file:///private/var/a%20b/X.app/'), '/var/a b/X.app');
  assert.equal(normalizePath('/var/a/X.app'), '/var/a/X.app');
});

test('picks the process of the installed bundle, not another app with the same executable name', () => {
  const processes = [proc(10, `${other}HelloWorld`), proc(20, `${ours}HelloWorld`), proc(30, 'file:///usr/libexec/HelloWorld')];
  assert.equal(select({processes}), 20);
  // The same match when the process path lacks /private and the app URL has it.
  assert.equal(select({processes: [proc(21, '/var/containers/Bundle/Application/AAAA-1111/HelloWorld.app/HelloWorld')]}), 21);
});

test('no running process, or only the other app, fails closed', () => {
  assert.throws(() => select({processes: []}), /found 0/);
  assert.throws(() => select({processes: [proc(10, `${other}HelloWorld`)]}), /found 0/);
  // A helper inside the bundle is not the app's executable.
  assert.throws(() => select({processes: [proc(11, `${ours}Frameworks/x.framework/HelloWorld`)]}), /found 0/);
});

test('ambiguous matches fail closed', () => {
  assert.throws(() => select({processes: [proc(20, `${ours}HelloWorld`), proc(22, `${ours}HelloWorld`)]}), /found 2/);
  assert.throws(() => selectAppPid({apps: [...apps, {bundleIdentifier: 'dev.example.ours', url: other}], processes: [proc(20, `${ours}HelloWorld`)],
    bundleId: 'dev.example.ours', executable: 'HelloWorld'}), /found 2/);
});

test('missing installation, bundle URL or pid fails closed', () => {
  assert.throws(() => select({apps: [], processes: [proc(20, `${ours}HelloWorld`)]}), /found 0/);
  assert.throws(() => select({apps: [{bundleIdentifier: 'dev.example.ours'}], processes: []}), /no bundle URL/);
  assert.throws(() => select({processes: [proc(undefined, `${ours}HelloWorld`)]}), /invalid process id/);
});

test('real devicectl output (iPhone 12 Pro, iOS 26.7.1): two HelloWorld apps running at once', () => {
  // Trimmed from `devicectl device info apps` / `info processes` JSON (result.apps, result.runningProcesses).
  const apps = [
    {bundleIdentifier: 'dev.rustjsilab.rnr.ios931d4aba', url: 'file:///private/var/containers/Bundle/Application/FA846506-38A0-462B-B6BB-18AE6842F782/HelloWorld.app/'},
    {bundleIdentifier: 'dev.rustjsilab.rnr.rnrcompare', url: 'file:///private/var/containers/Bundle/Application/30073C78-A5C9-40DB-95EE-843555935AD9/HelloWorld.app/'},
  ];
  const processes = [
    proc(1123, 'file:///private/var/containers/Bundle/Application/FA846506-38A0-462B-B6BB-18AE6842F782/HelloWorld.app/HelloWorld'),
    proc(1142, 'file:///private/var/containers/Bundle/Application/30073C78-A5C9-40DB-95EE-843555935AD9/HelloWorld.app/HelloWorld'),
  ];
  assert.equal(selectAppPid({apps, processes, bundleId: 'dev.rustjsilab.rnr.rnrcompare', executable: 'HelloWorld'}), 1142);
  assert.equal(selectAppPid({apps, processes, bundleId: 'dev.rustjsilab.rnr.ios931d4aba', executable: 'HelloWorld'}), 1123);
});
