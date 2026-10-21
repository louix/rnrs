// Apple unified-logging writer for rnrs-log (src/sink.rs). One log object for the whole
// process (subsystem "rnr", category "rust"), so nothing is cached per target. The message is
// written as a single %{private}s or %{public}s argument (os_log needs a literal format).
#include <os/log.h>
#include <stdbool.h>
#include <stdint.h>

static os_log_t rnr_log_handle(void) {
  static os_log_t handle;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    handle = os_log_create("rnr", "rust");
  });
  return handle;
}

// level: 0 trace, 1 debug, 2 info, 3 warn, 4 error.
void rnr_log_apple(uint8_t level, const char *text, bool public_text) {
  os_log_type_t type = level >= 4 ? OS_LOG_TYPE_ERROR
                     : level == 3 ? OS_LOG_TYPE_DEFAULT
                     : level == 2 ? OS_LOG_TYPE_INFO
                                  : OS_LOG_TYPE_DEBUG;
  if (public_text) {
    os_log_with_type(rnr_log_handle(), type, "%{public}s", text);
  } else {
    os_log_with_type(rnr_log_handle(), type, "%{private}s", text);
  }
}
