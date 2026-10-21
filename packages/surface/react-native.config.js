// Autolinking: the surface view manager (Android) and RnrSurface.podspec (iOS, found by the
// CLI in this directory). The component's codegen output is registered by the app's
// autolinking from codegenConfig (ios.componentProvider on iOS); no app edits.
module.exports = {
  dependency: {
    platforms: {
      android: {
        packageImportPath: 'import dev.rustjsilab.rnr.surface.RnrSurfacePackage;',
        packageInstance: 'new RnrSurfacePackage()',
      },
      ios: {},
    },
  },
};
