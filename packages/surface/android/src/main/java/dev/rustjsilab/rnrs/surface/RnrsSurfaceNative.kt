package dev.rustjsilab.rnrs.surface

import android.view.Surface
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.soloader.SoLoader

/**
 * JNI entry points implemented in Rust (rnrs-surface crate, src/android.rs), exported from the
 * framework's librnrs.so. All are called on the UI thread and never call into JS.
 */
@DoNotStrip
internal object RnrsSurfaceNative {
  init {
    SoLoader.loadLibrary("rnrs")
  }

  /** Returns the attachment number, or 0 if refused (unknown/closed key, already attached). */
  @JvmStatic external fun nativeAttach(key: Long, surface: Surface, width: Int, height: Int, density: Float): Long

  /** False if the attachment is no longer current. */
  @JvmStatic external fun nativeResize(key: Long, attachment: Long, width: Int, height: Int, density: Float): Boolean

  /** Waits up to [timeoutMs] for the renderer to release the window; false on timeout. */
  @JvmStatic external fun nativeDetach(key: Long, attachment: Long, timeoutMs: Int): Boolean

  /**
   * One touch transition (phase 0 down, 1 move, 2 up, 3 cancel, 4 cancel all) of [pointerId] at
   * view-local physical pixels, MotionEvent time ([SystemClock.uptimeMillis]). True if accepted.
   */
  @JvmStatic external fun nativeTouch(key: Long, attachment: Long, phase: Int, pointerId: Int, x: Float, y: Float, eventTimeMs: Long): Boolean

  @JvmStatic external fun nativeLiveSurfaces(): Int
}
