package dev.rustjsilab.rnr

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/** Registers [RnrRuntimeModule]. Autolinking would add this package; the lab lists it by hand. */
class RnrRuntimePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == RnrRuntimeModule.NAME) RnrRuntimeModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
        RnrRuntimeModule.NAME to
            ReactModuleInfo(
                RnrRuntimeModule.NAME,
                RnrRuntimeModule::class.java.name,
                canOverrideExistingModule = false,
                needsEagerInit = false,
                isCxxModule = false,
                isTurboModule = true,
            )
    )
  }
}
