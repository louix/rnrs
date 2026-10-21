package dev.rustjsilab.rnrs.surface

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.viewmanagers.RnrsSurfaceViewManagerDelegate
import com.facebook.react.viewmanagers.RnrsSurfaceViewManagerInterface

/** Fabric view manager for `RnrsSurfaceView` (codegen spec in ../src/specs). */
@ReactModule(name = RnrsSurfaceViewManager.NAME)
class RnrsSurfaceViewManager :
    SimpleViewManager<RnrsSurfaceView>(), RnrsSurfaceViewManagerInterface<RnrsSurfaceView> {
  private val delegate = RnrsSurfaceViewManagerDelegate(this)

  override fun getDelegate(): ViewManagerDelegate<RnrsSurfaceView> = delegate

  override fun getName(): String = NAME

  override fun createViewInstance(context: ThemedReactContext): RnrsSurfaceView = RnrsSurfaceView(context)

  override fun setSurfaceKey(view: RnrsSurfaceView, value: Double) = view.setSurfaceKey(value)

  override fun setTouchInput(view: RnrsSurfaceView, value: String?) = view.setTouchInput(value)

  /** Unmount: the window is detached now, even if the platform destroys the surface later. */
  override fun onDropViewInstance(view: RnrsSurfaceView) {
    view.release()
    super.onDropViewInstance(view)
  }

  companion object {
    const val NAME = "RnrsSurfaceView"
  }
}
