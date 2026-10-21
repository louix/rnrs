#include "RnrsPlatform.h"
#include <cstdarg>
#include <cstdio>
#include <ctime>

#if defined(__APPLE__)
#include <dispatch/dispatch.h>
#include <os/log.h>
#include <pthread.h>
#else
#include <fstream>
#include <unistd.h>
#if defined(__ANDROID__)
#include <android/log.h>
#endif
#endif

namespace rnrs::platform {

#if defined(__APPLE__)

ThreadId currentThread() {
  uint64_t id = 0;
  pthread_threadid_np(nullptr, &id);
  return id;
}

std::string currentThreadName() {
  char name[64] = {0};
  pthread_getname_np(pthread_self(), name, sizeof name);
  if (name[0]) return name;
  const char* label = dispatch_queue_get_label(DISPATCH_CURRENT_QUEUE_LABEL);
  return label && *label ? std::string("queue:") + label : std::string();
}

bool threadEntryLingering(ThreadId, const std::string&) { return false; }

#else

namespace {
std::string threadName(pid_t tid) {
  std::ifstream comm("/proc/self/task/" + std::to_string(tid) + "/comm");
  std::string name;
  std::getline(comm, name);
  return name;
}
}  // namespace

ThreadId currentThread() { return static_cast<ThreadId>(gettid()); }

std::string currentThreadName() { return threadName(gettid()); }

bool threadEntryLingering(ThreadId thread, const std::string& name) {
  return thread != 0 && !name.empty() && threadName(static_cast<pid_t>(thread)) == name;
}

#endif

uint64_t realtimeMs() {
  timespec ts{};
  clock_gettime(CLOCK_REALTIME, &ts);
  return static_cast<uint64_t>(ts.tv_sec) * 1000 + static_cast<uint64_t>(ts.tv_nsec) / 1000000;
}

void log(LogLevel level, const char* format, ...) {
  char message[1024];
  va_list args;
  va_start(args, format);
  vsnprintf(message, sizeof message, format, args);
  va_end(args);
#if defined(__APPLE__)
  static os_log_t handle = os_log_create("dev.rustjsilab.rnrs", "rnrs");
  os_log_with_type(handle, level == LogLevel::Info ? OS_LOG_TYPE_INFO : level == LogLevel::Error ? OS_LOG_TYPE_ERROR : OS_LOG_TYPE_FAULT,
                   "%{public}s", message);
#elif defined(__ANDROID__)
  __android_log_print(level == LogLevel::Info ? ANDROID_LOG_INFO : level == LogLevel::Error ? ANDROID_LOG_ERROR : ANDROID_LOG_FATAL, "rnrs",
                      "%s", message);
#else
  std::fprintf(stderr, "rnrs%s: %s\n", level == LogLevel::Info ? "" : " error", message);
#endif
}

}  // namespace rnrs::platform
