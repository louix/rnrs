package com.helloworld

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.WindowManager

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.ReactApplication
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  // Test hooks for the ownership prototype (same process, new JS runtime):
  // - `adb shell am broadcast -a dev.rustjsilab.RELOAD`: a real React Native reload.
  // - `adb shell am broadcast -a dev.rustjsilab.DESTROY`: ReactHost.destroy() (React instance
  //   destruction without invalidating the host), then Activity.recreate(), whose new surface
  //   starts a new React instance.
  // - `adb shell am broadcast -a dev.rustjsilab.SCOPE_STRESS`: runtime-scope ownership stress
  //   check (ScopeStress.kt), independent of React Native's lifecycle.
  private val reloadReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      val host = (application as ReactApplication).reactHost ?: return
      Log.i("rnrs", "lifecycle test hook: ${intent.action} at ${System.currentTimeMillis()}")
      when (intent.action) {
        RELOAD -> host.reload("rnrs reload test")
        DESTROY -> host.destroy("rnrs destroy test", null) { _ -> runOnUiThread { recreate() } }
        SCOPE_STRESS -> ScopeStress.run()
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (!beforeDestroyLogged) {
      // Timeline diagnostics: ReactHost's before-destroy step (UI thread).
      beforeDestroyLogged = true
      (application as ReactApplication).reactHost?.addBeforeDestroyListener {
        Log.i("rnrs", "ReactHost before-destroy listeners at ${System.currentTimeMillis()}")
      }
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    val filter = IntentFilter(RELOAD).apply { addAction(DESTROY); addAction(SCOPE_STRESS) }
    if (Build.VERSION.SDK_INT >= 33) registerReceiver(reloadReceiver, filter, Context.RECEIVER_EXPORTED)
    else registerReceiver(reloadReceiver, filter)
  }

  override fun onDestroy() {
    unregisterReceiver(reloadReceiver)
    super.onDestroy()
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "HelloWorld"

  private companion object {
    const val RELOAD = "dev.rustjsilab.RELOAD"
    const val DESTROY = "dev.rustjsilab.DESTROY"
    const val SCOPE_STRESS = "dev.rustjsilab.SCOPE_STRESS"
    var beforeDestroyLogged = false
  }

  /** The app runs the framework ownership and lifecycle suites. */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
        override fun getLaunchOptions(): Bundle =
            Bundle().apply { putString("mode", intent?.getStringExtra("mode") ?: "rnrs") }
      }
}
