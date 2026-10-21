package dev.rustjsilab.rnr.surface

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.viewmanagers.RnrSurfaceViewManagerDelegate
import com.facebook.react.viewmanagers.RnrSurfaceViewManagerInterface

/** Fabric view manager for `RnrSurfaceView` (codegen spec in ../src/specs). */
@ReactModule(name = RnrSurfaceViewManager.NAME)
class RnrSurfaceViewManager :
    SimpleViewManager<RnrSurfaceView>(), RnrSurfaceViewManagerInterface<RnrSurfaceView> {
  private val delegate = RnrSurfaceViewManagerDelegate(this)

  override fun getDelegate(): ViewManagerDelegate<RnrSurfaceView> = delegate

  override fun getName(): String = NAME

  override fun createViewInstance(context: ThemedReactContext): RnrSurfaceView = RnrSurfaceView(context)

  override fun setSurfaceKey(view: RnrSurfaceView, value: Double) = view.setSurfaceKey(value)

  override fun setTouchInput(view: RnrSurfaceView, value: String?) = view.setTouchInput(value)

  /** Unmount: the window is detached now, even if the platform destroys the surface later. */
  override fun onDropViewInstance(view: RnrSurfaceView) {
    view.release()
    super.onDropViewInstance(view)
  }

  companion object {
    const val NAME = "RnrSurfaceView"
  }
}
