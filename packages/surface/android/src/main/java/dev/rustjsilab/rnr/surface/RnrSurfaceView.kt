package dev.rustjsilab.rnr.surface

import android.content.Context
import android.os.Build
import android.util.Log
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView

/**
 * A SurfaceView whose window is attached to the Rust surface named by `surfaceKey`.
 *
 * Everything runs on the UI thread. The platform surface can be created and destroyed many
 * times while the view stays mounted (backgrounding, visibility, re-layout); each time it
 * exists with a nonzero size and a key is set, it is attached, and before the platform
 * destroys it (or the key changes, or the view is dropped) it is detached.
 *
 * Detaching is synchronous, as Android requires for `surfaceDestroyed`: it revokes the
 * attachment (the renderer is admitted no further acquire/present) and waits, up to
 * [DETACH_TIMEOUT_MS], for the renderer to release the window, which includes destroying its
 * swapchain (a GPU wait). After a timeout the view continues; at most an operation already
 * admitted may still finish, and the window object stays retained until the renderer
 * releases it (docs/surface.md, "Lifecycle contract").
 *
 * Busy: a surface key shows in at most one view (the first attached wins), and a window is
 * owned by one attachment until released. A view refused as busy retries with backoff
 * ([RETRY_FIRST_MS] doubling to [RETRY_MAX_MS], then every [RETRY_MAX_MS]) while it still
 * has a key, a surface and a size, with one pending retry per view, cancelled on detach, key
 * change and drop. It logs once per busy episode. Stale or closed keys are refused, never
 * errors here.
 *
 * Touch input (opt-in, `touchInput="rust"`; docs/surface.md, "Touch input"): pointer
 * transitions go straight to Rust over JNI on this thread, never through JS. On the first
 * down the view consumes the gesture only if Rust accepts it (the renderer enabled input and
 * this view is attached); otherwise it returns false and the touch goes to whoever else wants
 * it. Once consumed, the view keeps returning true until the gesture's up or cancel, even if
 * Rust stops accepting (detach, reattach, opt-out): Rust then has already reset or refuses the
 * stale pointers, so the gesture is never half owned. It never requests that parents stop
 * intercepting: a parent that takes the gesture (a scroll view) sends ACTION_CANCEL, which
 * cancels every pointer in Rust.
 */
class RnrSurfaceView(context: Context) : SurfaceView(context), SurfaceHolder.Callback {
  private var key = 0L
  private var surfaceExists = false
  private var width = 0
  private var height = 0
  /** Nonzero while attached: Rust's number for this attachment, and the key it belongs to. */
  private var attachment = 0L
  private var attachedKey = 0L
  private var retryDelayMs = 0L
  private var touchInput = false
  /** True from an accepted first down to the gesture's up or cancel. */
  private var gesture = false
  /** Within a gesture: still forwarding to Rust (false after an opt-out mid-gesture). */
  private var forwarding = false
  private val retry = Runnable {
    retryDelayMs = minOf(retryDelayMs * 2, RETRY_MAX_MS)
    attach()
  }

  init {
    holder.addCallback(this)
  }

  private val density: Float
    get() = resources.displayMetrics.density

  fun setSurfaceKey(value: Double) {
    val next = if (value >= 1.0 && value <= MAX_SAFE_INTEGER) value.toLong() else 0L
    if (next == key) return
    detach()
    cancelRetry()
    key = next
    attach()
  }

  fun setTouchInput(value: String?) {
    val next = value == "rust"
    if (next == touchInput) return
    touchInput = next
    if (!next && gesture && forwarding) {
      // Opt-out mid-gesture: cancel in Rust, keep consuming this gesture until it ends.
      RnrSurfaceNative.nativeTouch(attachedKey, attachment, CANCEL_ALL, -1, 0f, 0f, android.os.SystemClock.uptimeMillis())
      forwarding = false
    }
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    val action = event.actionMasked
    if (action == MotionEvent.ACTION_DOWN) {
      gesture = false
      forwarding = false
      if (!touchInput || attachment == 0L) return super.onTouchEvent(event)
      if (!send(event, DOWN, 0)) return super.onTouchEvent(event)
      gesture = true
      forwarding = true
      return true
    }
    if (!gesture) return super.onTouchEvent(event)
    if (forwarding) {
      when (action) {
        MotionEvent.ACTION_POINTER_DOWN -> send(event, DOWN, event.actionIndex)
        MotionEvent.ACTION_MOVE -> for (i in 0 until event.pointerCount) send(event, MOVE, i)
        // Android 13+ marks a pointer-up that should not count as a release (e.g. an
        // accidental palm touch) with FLAG_CANCELED: that pointer is canceled, not ended.
        MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_UP ->
          send(event, if (canceled(event)) CANCEL else UP, event.actionIndex)
        MotionEvent.ACTION_CANCEL ->
          RnrSurfaceNative.nativeTouch(attachedKey, attachment, CANCEL_ALL, -1, 0f, 0f, event.eventTime)
      }
    }
    if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
      gesture = false
      forwarding = false
    }
    return true
  }

  private fun canceled(event: MotionEvent): Boolean =
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && (event.flags and FLAG_CANCELED) != 0

  /** One pointer of [event] to Rust, for the current attachment (0 when detached: refused). */
  private fun send(event: MotionEvent, phase: Int, index: Int): Boolean =
      RnrSurfaceNative.nativeTouch(attachedKey, attachment, phase, event.getPointerId(index), event.getX(index), event.getY(index), event.eventTime)

  /** The view is being dropped by React Native. */
  fun release() {
    detach()
    cancelRetry()
    key = 0L
  }

  override fun onDetachedFromWindow() {
    cancelRetry()
    super.onDetachedFromWindow()
  }

  override fun surfaceCreated(holder: SurfaceHolder) {
    surfaceExists = true
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
    this.width = width
    this.height = height
    if (attachment == 0L) {
      attach()
    } else if (width <= 0 || height <= 0) {
      detach()
    } else if (RnrSurfaceNative.nativeResize(attachedKey, attachment, width, height, density)) {
      Log.i(TAG, "surface $attachedKey: resized #$attachment ${width}x$height @$density")
    } else {
      // The surface was disposed while attached: nothing is retained for it any more.
      attachment = 0L
      attachedKey = 0L
      attach()
    }
  }

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    detach()
    cancelRetry()
    surfaceExists = false
  }

  /** Revalidates everything: also the entry point of a scheduled retry. */
  private fun attach() {
    if (key == 0L || !surfaceExists || attachment != 0L || width <= 0 || height <= 0) return
    val surface = holder.surface
    if (surface == null || !surface.isValid) return
    val result = RnrSurfaceNative.nativeAttach(key, surface, width, height, density)
    when {
      result > 0L -> {
        attachment = result
        attachedKey = key
        Log.i(TAG, "surface $key: attached #$result ${width}x$height @$density")
        cancelRetry()
      }
      result == BUSY -> {
        if (retryDelayMs == 0L) {
          Log.w(TAG, "surface $key: busy (shown in another view, or the window is still owned by a previous attachment); retrying")
          retryDelayMs = RETRY_FIRST_MS
        }
        removeCallbacks(retry)
        postDelayed(retry, retryDelayMs)
      }
      else -> Log.i(TAG, "surface $key: attach refused (unknown or closed key)")
    }
  }

  private fun cancelRetry() {
    removeCallbacks(retry)
    retryDelayMs = 0L
  }

  private fun detach() {
    if (attachment == 0L) return
    val started = System.nanoTime()
    if (RnrSurfaceNative.nativeDetach(attachedKey, attachment, DETACH_TIMEOUT_MS)) {
      Log.i(TAG, "surface $attachedKey: detached #$attachment in ${(System.nanoTime() - started) / 1000} us")
    } else {
      Log.w(TAG, "surface $attachedKey: detach #$attachment timed out after $DETACH_TIMEOUT_MS ms; attachment revoked, window retained until the renderer releases it")
    }
    attachment = 0L
    attachedKey = 0L
  }

  companion object {
    private const val TAG = "RnrSurface"
    /** Touch phase codes of `nativeTouch` (rnrs-surface touch.rs `Phase::from_code`). */
    private const val DOWN = 0
    private const val MOVE = 1
    private const val UP = 2
    private const val CANCEL = 3
    private const val CANCEL_ALL = 4
    /** `MotionEvent.FLAG_CANCELED` (API 33); the platform sets it only from API 33. */
    private const val FLAG_CANCELED = 0x20
    /** UI-thread budget for the synchronous detach; distinct from wgpu's 1000 ms acquire timeout. */
    private const val DETACH_TIMEOUT_MS = 500
    private const val BUSY = -1L
    private const val RETRY_FIRST_MS = 16L
    private const val RETRY_MAX_MS = 1000L
    private const val MAX_SAFE_INTEGER = 9007199254740991.0
  }
}
