// The lab app's only Babel change: the worklets plugin (react-native-worklets 0.13.0 docs).
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: ['react-native-worklets/plugin'],
};
