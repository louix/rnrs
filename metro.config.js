const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
// Absolute paths contain regex metacharacters (`.` in `.local`, `.generated`, ...): escape them.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const under = (dir) => escape(path.join(__dirname, dir));
module.exports = mergeConfig(getDefaultConfig(__dirname), {
  resolver: {
    blockList: [
      new RegExp('^' + under('react-native') + '/.*'),
      // Build caches live under .generated/; generated module wrappers (.generated/rnr/) are sources.
      new RegExp('^' + under('.generated') + '/(?!rnr/).*'),
      /\/rust\/target\/.*/,
    ],
  },
  maxWorkers: 2,
});
