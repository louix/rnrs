package com.helloworld

import android.util.Log
import dev.rustjsilab.rnr.RnrScopeDiagnostics
import dev.rustjsilab.rnr.RuntimeScopeOwner
import java.util.concurrent.CyclicBarrier
import kotlin.concurrent.thread

/**
 * Test hook (`adb shell am broadcast -a dev.rustjsilab.SCOPE_STRESS`): exercises runtime-scope
 * ownership without relying on React Native's call ordering. It races bindings requests
 * against invalidation on separate threads, then drops scopes that were never invalidated, and
 * checks that every native scope is eventually freed. Logs one `rnr scope stress:` line.
 */
internal object ScopeStress {
  fun run() = thread(name = "rnr-scope-stress") {
    val (created0, destroyed0, _) = RnrScopeDiagnostics.counters()
    var installers = 0
    var refused = 0
    val rounds = 500
    repeat(rounds) {
      val owner = RuntimeScopeOwner()
      val barrier = CyclicBarrier(2)
      var gotInstaller = false
      val requester = thread {
        barrier.await()
        gotInstaller = try { owner.bindingsInstaller(); true } catch (_: IllegalStateException) { false }
      }
      val invalidator = thread {
        barrier.await()
        owner.invalidate(false)
        owner.invalidate(false) // idempotent
      }
      requester.join()
      invalidator.join()
      if (gotInstaller) installers++ else refused++
      // After invalidation every request is refused.
      try { owner.bindingsInstaller(); error("installer after invalidation") } catch (_: IllegalStateException) {}
    }
    // Scopes never invalidated (e.g. a module that was created and dropped).
    repeat(rounds) { RuntimeScopeOwner() }
    val expected = 2L * rounds
    var freed = 0L
    for (attempt in 0 until 100) {
      System.gc()
      System.runFinalization()
      Thread.sleep(50)
      val (created, destroyed, _) = RnrScopeDiagnostics.counters()
      freed = destroyed - destroyed0
      if (created - created0 == expected && freed >= expected) break
    }
    val (created, _, _) = RnrScopeDiagnostics.counters()
    Log.i("rnr", "rnr scope stress: {\"rounds\":$rounds,\"installers\":$installers,\"refused\":$refused," +
        "\"created\":${created - created0},\"freed\":$freed,\"expected\":$expected}")
  }
}
