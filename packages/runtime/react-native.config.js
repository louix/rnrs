// Autolinking: the framework's native library on each platform (lifecycle module, JSI
// adapter, Rust bundle). iOS uses RnrsRuntime.podspec, found by the CLI in this directory.
module.exports = {
  dependency: {
    platforms: {
      android: {
        packageImportPath: 'import dev.rustjsilab.rnrs.RnrsRuntimePackage;',
        packageInstance: 'new RnrsRuntimePackage()',
      },
      ios: {},
    },
  },
};
