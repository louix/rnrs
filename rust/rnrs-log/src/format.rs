//! Bounded, escaping line formatting. Output is limited while it is written (never formatted
//! in full and cut afterwards): once a buffer is full it refuses further input, which also
//! stops `Debug` implementations early.
use std::fmt::{self, Write};

use tracing::field::{Field, Visit};

/// Bytes of one log line (scope, message and fields), not counting the truncation marker.
pub const MAX_LINE: usize = 4000;
/// Bytes of the stored fields of one span (creation fields plus later `record` calls).
pub const MAX_SPAN_FIELDS: usize = 512;
/// Appended when a line or a span's fields were cut.
pub const TRUNCATED: &str = "…[truncated]";

/// A string that accepts at most `limit` bytes, cut at a character boundary. Control
/// characters are escaped as they are written: NUL as `\0`, newline `\n`, carriage return
/// `\r`, others (except tab) as `\u{..}`; so a line never contains NUL or line breaks.
pub struct Bounded {
    buf: String,
    limit: usize,
    truncated: bool,
}

impl Bounded {
    pub fn new(limit: usize) -> Self {
        Bounded { buf: String::new(), limit, truncated: false }
    }

    pub fn clear(&mut self) {
        self.buf.clear();
        self.truncated = false;
    }

    pub fn is_full(&self) -> bool {
        self.truncated
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Appends one piece whole, or marks the buffer truncated and appends nothing.
    fn push_piece(&mut self, piece: &str) -> bool {
        if self.truncated {
            return false;
        }
        if self.buf.len() + piece.len() > self.limit {
            self.truncated = true;
            return false;
        }
        self.buf.push_str(piece);
        true
    }

    /// Appends text, escaping control characters, character by character.
    pub fn push_escaped(&mut self, s: &str) -> bool {
        let mut tmp = [0u8; 4];
        for c in s.chars() {
            let ok = match c {
                '\0' => self.push_piece("\\0"),
                '\n' => self.push_piece("\\n"),
                '\r' => self.push_piece("\\r"),
                '\t' => self.push_piece("\t"),
                c if c.is_control() => {
                    let mut esc = String::with_capacity(10);
                    let _ = write!(esc, "\\u{{{:x}}}", c as u32);
                    self.push_piece(&esc)
                }
                c => self.push_piece(c.encode_utf8(&mut tmp)),
            };
            if !ok {
                return false;
            }
        }
        true
    }

    /// Appends a string field value, quoted when it is empty or contains a space, `=`, a quote,
    /// a backslash or a control character.
    pub fn push_value_str(&mut self, s: &str) -> bool {
        let needs_quotes = s.is_empty() || s.chars().any(|c| c == ' ' || c == '=' || c == '"' || c == '\\' || c.is_control());
        if !needs_quotes {
            return self.push_escaped(s);
        }
        if !self.push_piece("\"") {
            return false;
        }
        for c in s.chars() {
            let ok = match c {
                '"' => self.push_piece("\\\""),
                '\\' => self.push_piece("\\\\"),
                c => {
                    let mut tmp = [0u8; 4];
                    self.push_escaped(c.encode_utf8(&mut tmp))
                }
            };
            if !ok {
                return false;
            }
        }
        self.push_piece("\"")
    }

    /// Appends another bounded buffer's content (already escaped) and its truncation state.
    pub fn push_bounded(&mut self, other: &Bounded) -> bool {
        if !self.push_piece_prefix(&other.buf) {
            return false;
        }
        if other.truncated {
            return self.push_piece(TRUNCATED);
        }
        true
    }

    /// Appends a separately formatted field list (a span's `record` update), space-separated.
    pub fn append_fields(&mut self, update: &Bounded) {
        if self.truncated {
            return;
        }
        if !self.buf.is_empty() && !update.buf.is_empty() && !self.push_piece(" ") {
            return;
        }
        self.push_piece_prefix(&update.buf);
        if update.truncated {
            self.truncated = true;
        }
    }

    /// Appends as much of already-escaped text as fits, at a character boundary.
    fn push_piece_prefix(&mut self, s: &str) -> bool {
        if self.truncated {
            return false;
        }
        let room = self.limit.saturating_sub(self.buf.len());
        if s.len() <= room {
            self.buf.push_str(s);
            return true;
        }
        let mut end = room;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        self.buf.push_str(&s[..end]);
        self.truncated = true;
        false
    }

    /// The text, with the truncation marker if anything was cut.
    pub fn finish(&mut self) -> &str {
        if self.truncated && !self.buf.ends_with(TRUNCATED) {
            self.buf.push_str(TRUNCATED);
        }
        &self.buf
    }

    pub fn as_str(&self) -> &str {
        &self.buf
    }
}

impl Write for Bounded {
    /// Escapes like `push_escaped`. Returns an error once full, so formatting stops early.
    fn write_str(&mut self, s: &str) -> fmt::Result {
        if self.push_escaped(s) {
            Ok(())
        } else {
            Err(fmt::Error)
        }
    }
}

/// Writes the `message` field of an event (or a `log` record's message).
pub struct MessageVisitor<'a>(pub &'a mut Bounded);

impl Visit for MessageVisitor<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.0.push_escaped(value);
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.0, "{value:?}");
        }
    }
}

/// Writes every other field as ` name=value`. With `skip_log_fields` (bridged `log` records)
/// the `log.*` fields are skipped: their target and level come from the normalized metadata.
pub struct FieldsVisitor<'a> {
    pub out: &'a mut Bounded,
    /// Whether to write a separating space before the first field.
    pub leading_space: bool,
    /// Set only for bridged `log` records; a native event keeps its own `log.*` fields.
    pub skip_log_fields: bool,
}

impl FieldsVisitor<'_> {
    fn name(&mut self, field: &Field) -> bool {
        if self.out.is_full() {
            return false;
        }
        if self.leading_space && !self.out.push_piece(" ") {
            return false;
        }
        self.leading_space = true;
        self.out.push_escaped(field.name()) && self.out.push_piece("=")
    }

    fn skip(&self, field: &Field) -> bool {
        field.name() == "message" || (self.skip_log_fields && field.name().starts_with("log."))
    }
}

impl Visit for FieldsVisitor<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        if !self.skip(field) && self.name(field) {
            self.out.push_value_str(value);
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if !self.skip(field) && self.name(field) {
            let _ = write!(self.out, "{value:?}");
        }
    }
}

/// The longest prefix of `s` of at most `max` bytes that ends at a character boundary.
pub fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_nul_and_line_breaks() {
        let mut b = Bounded::new(100);
        b.push_escaped("a\0b\nc\rd\te\u{7}");
        assert_eq!(b.finish(), "a\\0b\\nc\\rd\te\\u{7}");
    }

    #[test]
    fn truncates_at_a_character_boundary_and_marks_it() {
        let mut b = Bounded::new(5);
        b.push_escaped("abcé€"); // 'é' (2 bytes) fits up to 5; '€' (3 bytes) does not
        assert_eq!(b.finish(), "abcé…[truncated]");
        let mut c = Bounded::new(4);
        c.push_escaped("abcé"); // 'é' would end at byte 5
        assert_eq!(c.finish(), "abc…[truncated]");
    }

    #[test]
    fn stops_accepting_once_full_so_debug_formatting_ends_early() {
        struct Counting<'a>(&'a std::cell::Cell<usize>);
        impl fmt::Debug for Counting<'_> {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                for _ in 0..1000 {
                    self.0.set(self.0.get() + 1);
                    f.write_str("xxxxxxxxxx")?;
                }
                Ok(())
            }
        }
        let n = std::cell::Cell::new(0);
        let mut b = Bounded::new(25);
        let _ = write!(b, "{:?}", Counting(&n));
        assert!(n.get() <= 3, "kept formatting after the buffer was full: {}", n.get());
        assert_eq!(b.finish(), format!("{}…[truncated]", "x".repeat(25)));
    }

    #[test]
    fn quotes_string_values_when_needed() {
        let mut b = Bounded::new(100);
        b.push_value_str("plain");
        b.push_escaped(" ");
        b.push_value_str("two words");
        b.push_escaped(" ");
        b.push_value_str("a=\"b\"\\");
        b.push_escaped(" ");
        b.push_value_str("");
        assert_eq!(b.finish(), r#"plain "two words" "a=\"b\"\\" """#);
    }

    #[test]
    fn truncation_keeps_character_boundaries() {
        assert_eq!(truncate_utf8("ééééééééééééé", 23), "ééééééééééé"); // 22 bytes, not 23
        assert_eq!(truncate_utf8("abc", 2), "ab");
    }
}
