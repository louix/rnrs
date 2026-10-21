package dev.rustjsilab.rnr

import com.facebook.jni.HybridData
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.queue.MessageQueueThreadImpl
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.turbomodule.core.interfaces.BindingsInstallerHolder
import com.facebook.soloader.SoLoader
import com.facebook.react.turbomodule.core.interfaces.TurboModuleWithJSIBindings

/**
 * Framework-supplied runtime lifecycle glue (stands in for generated/autolinked code; module
 * authors write none of it). One instance exists per React instance, i.e. per JS runtime.
 *
 * - [getBindingsInstaller] is called by TurboModuleManager on the JS thread the first time JS
 *   requires `RnrRuntime`; the native installer binds `globalThis.__rnrRuntime` to this
 *   instance's runtime scope.
 * - [invalidate] tears down every adapter of the scope without touching JSI. On React Native
 *   0.83.1 Android (bridgeless; the 0.88.0 source keeps this order) it is called by
 *   `ReactInstance.destroy()` on a background thread after the JS queue thread has been quit
 *   and joined and before the runtime is released; see docs/prototype.md. Correctness of the
 *   scope's ownership does not depend on that ordering: [RuntimeScopeOwner] serializes both
 *   calls.
 */
@ReactModule(name = RnrRuntimeModule.NAME)
class RnrRuntimeModule(context: ReactApplicationContext) :
    NativeRnrRuntimeSpec(context), TurboModuleWithJSIBindings {

  private val scope = RuntimeScopeOwner()

  init {
    RnrTestHooks.attach(context)
    // Modules that persist data get <filesDir>/rnr (app-private internal storage) through
    // rnrs_core::platform::app_data_dir(), before any module exists. Not created here: if the
    // directory cannot be created, the module that needs it gets that error when it asks,
    // and the runtime itself still starts.
    val dir = java.io.File(context.filesDir, "rnr")
    if (!RnrPlatform.setAppDataDir(dir.absolutePath)) {
      android.util.Log.e("rnr", "application data directory not set (already set to another path?): ${dir.absolutePath}")
    }
  }

  override fun getName(): String = NAME

  override fun version(): String = VERSION

  override fun getBindingsInstaller(): BindingsInstallerHolder = scope.bindingsInstaller()

  override fun invalidate() {
    // Diagnostics only: whether the JS thread had terminated when the hook ran (unknown
    // counts as alive).
    val jsThread = (reactApplicationContext.getJSMessageQueueThread() as? MessageQueueThreadImpl)?.looper?.thread
    scope.invalidate(jsThread?.isAlive ?: true)
    super.invalidate()
  }

  companion object {
    const val NAME = "RnrRuntime"
    const val VERSION = "0.1.0"
  }
}

/**
 * Owns one runtime scope's native part. Every native call and the release of the native part
 * happen under one lock, so a bindings request racing invalidation either gets an installer
 * (which keeps its own reference to the scope) or fails with IllegalStateException; neither
 * can use freed memory. Without invalidation, fbjni frees the native part when this object is
 * collected.
 */
class RuntimeScopeOwner {
  init {
    RnrLibrary.ensureLoaded()
  }

  private val lock = Any()
  private var scope: RnrRuntimeScope? = RnrRuntimeScope()

  fun bindingsInstaller(): BindingsInstallerHolder =
      synchronized(lock) {
        checkNotNull(scope) { "RnrRuntime was invalidated before its bindings were installed" }
            .bindingsInstaller()
      }

  /** Idempotent; any thread. Invalidates the scope, then frees the native part at once. */
  fun invalidate(jsThreadAlive: Boolean) {
    synchronized(lock) {
      val current = scope ?: return
      scope = null
      current.invalidateAndRelease(jsThreadAlive)
    }
  }
}

/** Java peer of the native runtime scope (android/src/main/jni/RnrRuntime.cpp). */
@DoNotStrip
internal class RnrRuntimeScope {
  init {
    RnrLibrary.ensureLoaded()
  }

  @DoNotStrip private val mHybridData: HybridData = initHybrid()

  fun bindingsInstaller(): BindingsInstallerHolder = bindingsInstallerNative()

  fun invalidateAndRelease(jsThreadAlive: Boolean) {
    invalidateNative(jsThreadAlive)
    mHybridData.resetNative()
  }

  private external fun initHybrid(): HybridData

  private external fun bindingsInstallerNative(): BindingsInstallerHolder

  private external fun invalidateNative(jsThreadAlive: Boolean)
}

/** Loads the framework's native library (JSI adapter plus the app's Rust bundle). */
internal object RnrLibrary {
  init {
    SoLoader.loadLibrary("rnr")
  }

  fun ensureLoaded() {}
}

/** Platform facts handed to the Rust side (rnrs_core::platform). */
object RnrPlatform {
  init {
    RnrLibrary.ensureLoaded()
  }

  @JvmStatic external fun setAppDataDir(path: String): Boolean
}

/** Test hook: process-wide scope counters (created, destroyed, invalidated). */
object RnrScopeDiagnostics {
  init {
    RnrLibrary.ensureLoaded()
  }

  @JvmStatic external fun counters(): LongArray
}

/**
 * Test hook: React Native reload through `ReactHost.reload`, since release builds have no
 * JS-reachable reload (the Android counterpart of the iOS reloadForTesting). Native code calls
 * [reload] only from `__rnrRuntime.reloadForTesting`, which exists only in RNR_TEST_HOOKS
 * builds; it only enqueues the reload on the main thread.
 */
@DoNotStrip
object RnrTestHooks {
  @Volatile private var context: java.lang.ref.WeakReference<ReactApplicationContext>? = null

  fun attach(context: ReactApplicationContext) {
    this.context = java.lang.ref.WeakReference(context)
  }

  @JvmStatic
  @DoNotStrip
  fun reload() {
    val app = context?.get()?.applicationContext as? ReactApplication ?: return
    UiThreadUtil.runOnUiThread { app.reactHost?.reload("rnr test hook") }
  }
}
