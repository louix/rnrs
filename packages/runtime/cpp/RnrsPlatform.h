#pragma once
// The few OS services the shared framework C++ (RnrsScope, RnrsJsi, RnrsBindings) needs, so that
// one copy builds for Android, iOS and the host tests. No JSI, JNI or Objective-C here.
#include <cstdint>
#include <string>

namespace rnrs::platform {

// Kernel thread id of the calling thread (gettid on Linux/Android, pthread_threadid_np on
// Apple platforms). Only compared for equality.
using ThreadId = uint64_t;
ThreadId currentThread();

// Diagnostics name of the calling thread: the kernel thread name, or on Apple platforms the
// pthread name, falling back to the current dispatch queue's label ("queue:<label>").
std::string currentThreadName();

// Whether a thread that the platform reported as finished still has its kernel task entry
// with the same name (Linux/Android /proc; always false elsewhere). Diagnostics only.
bool threadEntryLingering(ThreadId thread, const std::string& name);

// Wall clock in milliseconds (diagnostics).
uint64_t realtimeMs();

enum class LogLevel { Info, Error, Fatal };
// printf-style; tag "rnrs" (logcat on Android, os_log on Apple platforms, stderr on hosts).
void log(LogLevel level, const char* format, ...) __attribute__((format(printf, 2, 3)));

}  // namespace rnrs::platform
