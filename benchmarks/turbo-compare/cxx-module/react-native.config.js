// Autolinking of a pure C++ TurboModule library (React Native 0.88): Android adds
// android/CMakeLists.txt to the app's appmodules build and registers RnrsCmpCxx (from
// RnrsCmpCxx.h) in the C++ module provider; iOS uses RnrsCmpCxx.podspec and the module provider
// class named in package.json codegenConfig.ios.modulesProvider.
module.exports = {
  dependency: {
    platforms: {
      android: {
        cxxModuleCMakeListsModuleName: 'rnrscmpcxx',
        cxxModuleCMakeListsPath: 'CMakeLists.txt',
        cxxModuleHeaderName: 'RnrsCmpCxx',
      },
      ios: {},
    },
  },
};
