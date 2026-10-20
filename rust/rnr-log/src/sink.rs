//! Where formatted lines go. The platform sink writes synchronously on the calling thread and
//! never touches JSI or the JS runtime:
//! - Android: `__android_log_write` (liblog), tag = the target's crate (at most 23 bytes).
//! - Apple (iOS, macOS): unified logging, subsystem `rnr`, one fixed category `rust`; the
//!   target is part of the message. `%{private}s` unless `Privacy::Public`.
//! - Browser Wasm: `console.error|warn|info|debug` (main-thread instance only).
//! - Other hosts: standard error.
use std::fmt;
use std::sync::Arc;

use tracing::Level;

use crate::format::{truncate_utf8, Bounded, TRUNCATED};

/// Android limits tags to 23 bytes on older releases.
#[cfg_attr(not(any(target_os = "android", test)), allow(dead_code))]
pub const ANDROID_TAG_MAX: usize = 23;
/// Targets are prefixed to messages where the platform has no per-target tag.
pub const TARGET_MAX: usize = 128;

/// Apple unified-logging privacy of the whole message (scope, message and fields).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Privacy {
    /// `%{private}s`: redacted in logs collected without developer tooling.
    Private,
    /// `%{public}s`: readable by anyone who can read the device's logs.
    Public,
}

/// One formatted line handed to a sink.
#[derive(Clone, Copy, Debug)]
pub struct Line<'a> {
    pub level: Level,
    /// The original target (for `log` records, the record's target).
    pub target: &'a str,
    /// Scope, message and fields; bounded, without NUL or line breaks.
    pub text: &'a str,
}

/// A custom destination (tests, or an app-owned writer).
pub type CustomSink = Arc<dyn Fn(Line<'_>) + Send + Sync>;

#[derive(Clone)]
pub enum Sink {
    Platform(Privacy),
    Custom(CustomSink),
}

impl fmt::Debug for Sink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Sink::Platform(p) => write!(f, "Platform({p:?})"),
            Sink::Custom(_) => f.write_str("Custom"),
        }
    }
}

impl PartialEq for Sink {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Sink::Platform(a), Sink::Platform(b)) => a == b,
            (Sink::Custom(a), Sink::Custom(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }
}

impl Sink {
    pub fn write(&self, line: Line<'_>) {
        match self {
            Sink::Platform(privacy) => platform::write(line, *privacy),
            Sink::Custom(f) => f(line),
        }
    }
}

/// The Apple format string for a privacy choice (also what the C shim selects).
pub fn apple_format(privacy: Privacy) -> &'static str {
    match privacy {
        Privacy::Private => "%{private}s",
        Privacy::Public => "%{public}s",
    }
}

/// Bytes of the whole message handed to the platform (target prefix, text and truncation
/// marker). Android's logcat payload limit is a little above this; Apple unified logging and
/// browsers may keep less, so this bounds what rnr produces, not what a platform retains.
pub const MAX_MESSAGE: usize = 4000;

/// A raw target (from a `log` record it can be any string) escaped like message text and cut
/// to `TARGET_MAX` bytes.
fn escaped_target(target: &str) -> String {
    let mut out = Bounded::new(TARGET_MAX);
    out.push_escaped(target);
    out.finish().to_owned()
}

/// `prefix` followed by `text`, at most `MAX_MESSAGE` bytes: the text is cut at a character
/// boundary and marked when it does not fit.
pub fn compose(prefix: &str, text: &str) -> String {
    let mut s = String::with_capacity((prefix.len() + text.len()).min(MAX_MESSAGE));
    s.push_str(prefix);
    let room = MAX_MESSAGE.saturating_sub(s.len());
    if text.len() <= room {
        s.push_str(text);
    } else {
        let body = text.strip_suffix(TRUNCATED).unwrap_or(text);
        s.push_str(truncate_utf8(body, room.saturating_sub(TRUNCATED.len())));
        s.push_str(TRUNCATED);
    }
    s
}

/// `target: text` for platforms without a per-target tag.
fn with_target(line: Line<'_>) -> String {
    compose(&format!("{}: ", escaped_target(line.target)), line.text)
}

/// The Android tag for a target (its crate, control characters replaced, at most 23 bytes)
/// and the message (`target: text` when the target is longer than its crate, so `a::b` stays
/// visible), bounded like every platform message.
#[cfg_attr(not(any(target_os = "android", test)), allow(dead_code))]
pub fn android_tag_and_message(line: Line<'_>) -> (String, String) {
    let krate: String = line.target.split("::").next().unwrap_or("").chars().map(|c| if c.is_control() { '?' } else { c }).collect();
    let tag = truncate_utf8(&krate, ANDROID_TAG_MAX).to_owned();
    let text = if line.target.split("::").count() > 1 { with_target(line) } else { compose("", line.text) };
    (tag, text)
}

#[cfg(target_os = "android")]
mod platform {
    use super::*;
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int};

    #[link(name = "log")]
    extern "C" {
        fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
    }

    pub fn write(line: Line<'_>, _privacy: Privacy) {
        let prio = match line.level {
            Level::TRACE => 2,
            Level::DEBUG => 3,
            Level::INFO => 4,
            Level::WARN => 5,
            Level::ERROR => 6,
        };
        let (tag, text) = android_tag_and_message(line);
        // Lines carry no NUL (escaped while formatting); targets are sanitized above.
        let tag = CString::new(tag).unwrap_or_default();
        let text = CString::new(text.replace('\0', "\\0")).unwrap_or_default();
        unsafe { __android_log_write(prio, tag.as_ptr(), text.as_ptr()) };
    }
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
mod platform {
    use super::*;
    use std::ffi::CString;
    use std::os::raw::c_char;

    extern "C" {
        // src/apple_log.c
        fn rnr_log_apple(level: u8, text: *const c_char, public: bool);
    }

    pub fn write(line: Line<'_>, privacy: Privacy) {
        let level = match line.level {
            Level::TRACE => 0,
            Level::DEBUG => 1,
            Level::INFO => 2,
            Level::WARN => 3,
            Level::ERROR => 4,
        };
        let text = CString::new(with_target(line).replace('\0', "\\0")).unwrap_or_default();
        unsafe { rnr_log_apple(level, text.as_ptr(), privacy == Privacy::Public) };
    }
}

#[cfg(target_arch = "wasm32")]
mod platform {
    use super::*;
    use wasm_bindgen::prelude::wasm_bindgen;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = console, js_name = error)]
        fn console_error(s: &str);
        #[wasm_bindgen(js_namespace = console, js_name = warn)]
        fn console_warn(s: &str);
        #[wasm_bindgen(js_namespace = console, js_name = info)]
        fn console_info(s: &str);
        #[wasm_bindgen(js_namespace = console, js_name = debug)]
        fn console_debug(s: &str);
    }

    pub fn write(line: Line<'_>, _privacy: Privacy) {
        let text = with_target(line);
        match line.level {
            Level::ERROR => console_error(&text),
            Level::WARN => console_warn(&text),
            Level::INFO => console_info(&text),
            Level::DEBUG | Level::TRACE => console_debug(&text),
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios", target_os = "macos", target_arch = "wasm32")))]
mod platform {
    use super::*;

    pub fn write(line: Line<'_>, _privacy: Privacy) {
        eprintln!("[{} {}", line.level, with_target(line).replacen(": ", "] ", 1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn android_tags_are_crates_and_keep_the_full_target_in_the_message() {
        let (tag, text) = android_tag_and_message(Line { level: Level::INFO, target: "sled::tree", text: "flushed" });
        assert_eq!((tag.as_str(), text.as_str()), ("sled", "sled::tree: flushed"));
        let (tag, text) = android_tag_and_message(Line { level: Level::INFO, target: "kv", text: "open" });
        assert_eq!((tag.as_str(), text.as_str()), ("kv", "open"));
        let long = "a_crate_name_longer_than_twenty_three";
        let (tag, _) = android_tag_and_message(Line { level: Level::INFO, target: long, text: "" });
        assert_eq!(tag.len(), 23);
    }

    #[test]
    fn apple_privacy_selects_the_format_string() {
        assert_eq!(apple_format(Privacy::Private), "%{private}s");
        assert_eq!(apple_format(Privacy::Public), "%{public}s");
    }
}

#[cfg(test)]
mod target_tests {
    use super::*;

    #[test]
    fn raw_targets_are_escaped_in_tags_and_prefixes() {
        let line = Line { level: Level::INFO, target: "evil\0crate\n::sub\u{7}", text: "msg" };
        let (tag, text) = android_tag_and_message(line);
        assert_eq!(tag, "evil?crate?");
        assert_eq!(text, "evil\\0crate\\n::sub\\u{7}: msg");
        assert!(!text.contains('\0') && !tag.contains('\0'));
        let long = "x".repeat(TARGET_MAX + 50);
        let prefixed = with_target(Line { level: Level::INFO, target: &long, text: "m" });
        assert!(prefixed.starts_with(&"x".repeat(TARGET_MAX)) && prefixed.contains(&format!("{TRUNCATED}: m")));
    }
}
