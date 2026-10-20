// The lab app's only Babel change: the worklets plugin (react-native-worklets 0.12.2 docs).
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: ['react-native-worklets/plugin'],
};
