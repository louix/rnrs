package dev.rustjsilab.rnr.surface

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/** Registers [RnrSurfaceViewManager]; added by autolinking. */
class RnrSurfacePackage : ReactPackage {
  @Deprecated("Required by ReactPackage; this package has no native modules")
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> = emptyList()

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
      listOf(RnrSurfaceViewManager())
}
