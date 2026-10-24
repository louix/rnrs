#import <Foundation/Foundation.h>
#import <ReactCommon/RCTTurboModule.h>

// React Native's module provider for the pure C++ TurboModule RnrsCmpCxx
// (package.json codegenConfig.ios.modulesProvider).
@interface RnrsCmpCxxProvider : NSObject <RCTModuleProvider>
@end
