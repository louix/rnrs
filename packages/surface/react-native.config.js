// Autolinking: the surface view manager (Android) and RnrsSurface.podspec (iOS, found by the
// CLI in this directory). The component's codegen output is registered by the app's
// autolinking from codegenConfig (ios.componentProvider on iOS); no app edits.
module.exports = {
  dependency: {
    platforms: {
      android: {
        packageImportPath: 'import dev.rustjsilab.rnrs.surface.RnrsSurfacePackage;',
        packageInstance: 'new RnrsSurfacePackage()',
      },
      ios: {},
    },
  },
};
