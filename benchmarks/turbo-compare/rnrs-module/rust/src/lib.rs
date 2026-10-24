//! Benchmark-only module: the rnrs side of the rnrs vs C++ TurboModule comparison. Each method
//! uses the same algorithm as its counterpart in ../../cxx-module/cpp/RnrsCmpCxx.cpp.
pub mod rnrs_interface;
use rnrs_interface as spec;

/// Fixture string sizes in UTF-8 bytes: short, 1 KiB, 64 KiB.
pub const SIZES: [usize; 3] = [16, 1024, 65536];
const UNICODE: [&str; 4] = ["a", "\u{e9}", "\u{4e2d}", "\u{1f600}"];

/// `'a' + (i % 26)` for `bytes` bytes.
pub fn ascii_string(bytes: usize) -> String {
    (0..bytes)
        .map(|i| (b'a' + (i % 26) as u8) as char)
        .collect()
}

/// Cycles a, é, 中, 😀 (1-4 UTF-8 bytes) while the next one fits, then pads with 'z' to exactly
/// `bytes` UTF-8 bytes.
pub fn unicode_string(bytes: usize) -> String {
    let mut s = String::with_capacity(bytes);
    let mut k = 0;
    while s.len() + UNICODE[k % 4].len() <= bytes {
        s.push_str(UNICODE[k % 4]);
        k += 1;
    }
    while s.len() < bytes {
        s.push('z');
    }
    s
}

pub struct TurboCompare {
    /// Fixture strings by id: ASCII 16 B, 1 KiB, 64 KiB, then Unicode at the same sizes.
    strings: Vec<String>,
}

impl Default for TurboCompare {
    fn default() -> Self {
        let mut strings: Vec<String> = SIZES.iter().map(|&n| ascii_string(n)).collect();
        strings.extend(SIZES.iter().map(|&n| unicode_string(n)));
        Self { strings }
    }
}

fn point_sum(p: &spec::Point8) -> f64 {
    p.a + p.b + p.c + p.d + p.e + p.f + p.g + p.h
}

impl spec::TurboCompareModule for TurboCompare {
    fn nop(&self) -> Result<(), String> {
        Ok(())
    }

    fn add(&self, a: f64, b: f64) -> Result<f64, String> {
        Ok(a + b)
    }

    fn flip(&self, b: bool) -> Result<bool, String> {
        Ok(!b)
    }

    fn str_len(&self, s: String) -> Result<f64, String> {
        Ok(s.len() as f64)
    }

    fn str_get(&self, id: f64) -> Result<String, String> {
        if !(id.fract() == 0.0 && id >= 0.0 && id < self.strings.len() as f64) {
            return Err("id must be an integer from 0 to 5".into());
        }
        Ok(self.strings[id as usize].clone())
    }

    fn point_sum(&self, p: spec::Point8) -> Result<f64, String> {
        Ok(point_sum(&p))
    }

    fn point_make(&self, x: f64) -> Result<spec::Point8, String> {
        Ok(spec::Point8 {
            a: x,
            b: x + 1.0,
            c: x + 2.0,
            d: x + 3.0,
            e: x + 4.0,
            f: x + 5.0,
            g: x + 6.0,
            h: x + 7.0,
        })
    }

    fn nested_sum(&self, n: spec::Nested) -> Result<f64, String> {
        let visible = if n.visible { 1.0 } else { 0.0 };
        Ok(n.id
            + visible
            + n.frame.origin.x
            + n.frame.origin.y
            + n.frame.size.x
            + n.frame.size.y
            + n.tint.r
            + n.tint.g
            + n.tint.b
            + n.tint.a)
    }

    fn nested_make(&self, x: f64) -> Result<spec::Nested, String> {
        Ok(spec::Nested {
            id: x,
            visible: true,
            frame: spec::Frame {
                origin: spec::Vec2 {
                    x: x + 1.0,
                    y: x + 2.0,
                },
                size: spec::Vec2 {
                    x: x + 3.0,
                    y: x + 4.0,
                },
            },
            tint: spec::Rgba {
                r: x + 5.0,
                g: x + 6.0,
                b: x + 7.0,
                a: x + 8.0,
            },
        })
    }

    fn arr_sum(&self, xs: Vec<f64>) -> Result<f64, String> {
        let mut sum = 0.0;
        for x in xs {
            sum += x;
        }
        Ok(sum)
    }

    fn arr_make(&self, len: f64, x: f64) -> Result<Vec<f64>, String> {
        if !(len.fract() == 0.0 && (0.0..=1048576.0).contains(&len)) {
            return Err("len must be an integer from 0 to 1048576".into());
        }
        let n = len as usize;
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            out.push(x + i as f64);
        }
        Ok(out)
    }

    fn point_sum_batch(&self, ps: Vec<spec::Point8>) -> Result<f64, String> {
        let mut sum = 0.0;
        for p in &ps {
            sum += point_sum(p);
        }
        Ok(sum)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_strings_have_exact_utf8_sizes() {
        for &n in &SIZES {
            assert_eq!(ascii_string(n).len(), n);
            assert_eq!(unicode_string(n).len(), n);
        }
        assert_eq!(
            unicode_string(16),
            "a\u{e9}\u{4e2d}\u{1f600}a\u{e9}\u{4e2d}"
        );
        assert_eq!(unicode_string(15), "a\u{e9}\u{4e2d}\u{1f600}a\u{e9}zz");
        assert_eq!(&ascii_string(28)[24..], "yzab");
    }
}
