package dev.rustjsilab.rnrs

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/** Registers [RnrsRuntimeModule]. Autolinking would add this package; the lab lists it by hand. */
class RnrsRuntimePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == RnrsRuntimeModule.NAME) RnrsRuntimeModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
        RnrsRuntimeModule.NAME to
            ReactModuleInfo(
                RnrsRuntimeModule.NAME,
                RnrsRuntimeModule::class.java.name,
                canOverrideExistingModule = false,
                needsEagerInit = false,
                isCxxModule = false,
                isTurboModule = true,
            )
    )
  }
}
