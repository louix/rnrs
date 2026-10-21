const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
// Absolute paths contain regex metacharacters (`.` in `.local`, `.generated`, ...): escape them.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const under = (dir) => escape(path.join(__dirname, dir));
module.exports = mergeConfig(getDefaultConfig(__dirname), {
  resolver: {
    blockList: [
      new RegExp('^' + under('react-native') + '/.*'),
      // Build caches live under .generated/; generated module wrappers (.generated/rnrs/) are sources.
      // Metro 0.87 also tests directory paths (no trailing slash), so `rnrs` itself must not match.
      new RegExp('^' + under('.generated') + '/(?!rnrs(?:/|$)).*'),
      /\/rust\/target\/.*/,
    ],
  },
  maxWorkers: 2,
});
