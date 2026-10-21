// Autolinking: the framework's native library on each platform (lifecycle module, JSI
// adapter, Rust bundle). iOS uses RnrRuntime.podspec, found by the CLI in this directory.
module.exports = {
  dependency: {
    platforms: {
      android: {
        packageImportPath: 'import dev.rustjsilab.rnr.RnrRuntimePackage;',
        packageInstance: 'new RnrRuntimePackage()',
      },
      ios: {},
    },
  },
};
