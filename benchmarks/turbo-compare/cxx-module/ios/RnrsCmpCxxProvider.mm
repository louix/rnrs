#import "RnrsCmpCxxProvider.h"
#import "RnrsCmpCxx.h"

@implementation RnrsCmpCxxProvider
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::RnrsCmpCxx>(params.jsInvoker);
}
@end

// Harness helper for RnrsCmpCxx::installHarness: NSProcessInfoThermalState (0 nominal .. 3 critical).
extern "C" int rnrsCmpThermalState(void)
{
  return static_cast<int>([NSProcessInfo processInfo].thermalState);
}
