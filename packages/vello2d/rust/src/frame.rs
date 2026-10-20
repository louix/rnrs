//! The frame format written by `frame.ts`: little-endian `f32` values.
//!
//! ```text
//! [0] version (1)   [1] n = number of payload values that follow
//! payload: commands, each an opcode followed by its operands
//!   1 CLEAR       r g b a
//!   2 RECT        x y w h            r g b a
//!   3 CIRCLE      cx cy radius       r g b a
//!   4 ROUND_RECT  x y w h radius     r g b a
//!   5 LINE        x0 y0 x1 y1 width  r g b a
//! ```
//!
//! Coordinates are layout units (density-independent pixels, as React Native layout); the
//! renderer scales them to raster pixels. Colours are straight (not premultiplied) sRGB
//! components from 0 to 1. Values after the payload (unused buffer capacity) are ignored.
//! Decoding runs on the render thread; a malformed frame is rejected whole.

/// Largest accepted frame, checked synchronously by `submit`.
pub const MAX_FRAME_BYTES: usize = 1 << 20;
pub const VERSION: f32 = 1.0;
/// Bounds the decoded command list (and raster work) per frame.
pub const MAX_COMMANDS: usize = 65_536;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba(pub [f32; 4]);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Cmd {
    Clear(Rgba),
    Rect { x: f32, y: f32, w: f32, h: f32, color: Rgba },
    Circle { cx: f32, cy: f32, radius: f32, color: Rgba },
    RoundRect { x: f32, y: f32, w: f32, h: f32, radius: f32, color: Rgba },
    Line { x0: f32, y0: f32, x1: f32, y1: f32, width: f32, color: Rgba },
}

/// The synchronous check done by `submit` before copying the frame into the pending slot.
pub fn check_size(len: usize) -> Result<(), String> {
    if len > MAX_FRAME_BYTES {
        return Err(format!("frame is {len} bytes; the limit is {MAX_FRAME_BYTES}"));
    }
    if len % 4 != 0 || len < 8 {
        return Err(format!("frame is {len} bytes; it must hold whole f32 values and a two-value header"));
    }
    Ok(())
}

/// Decodes `bytes` into `out` (cleared first).
pub fn parse(bytes: &[u8], out: &mut Vec<Cmd>) -> Result<(), String> {
    out.clear();
    check_size(bytes.len())?;
    let value = |i: usize| f32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().expect("4 bytes"));
    if value(0) != VERSION {
        return Err(format!("unsupported frame version {}", value(0)));
    }
    let n = value(1);
    let available = bytes.len() / 4 - 2;
    if !(n >= 0.0 && n.fract() == 0.0 && (n as usize) <= available) {
        return Err(format!("payload length {n} does not fit the {available} values after the header"));
    }
    let payload: Vec<f32> = (0..n as usize).map(|i| value(i + 2)).collect();
    let mut p = &payload[..];
    while let Some((&op, rest)) = p.split_first() {
        if out.len() == MAX_COMMANDS {
            return Err(format!("more than {MAX_COMMANDS} commands"));
        }
        let arity = match op {
            1.0 => 4,
            2.0 => 8,
            3.0 => 7,
            4.0 | 5.0 => 9,
            _ => return Err(format!("unknown opcode {op} at command {}", out.len())),
        };
        if rest.len() < arity {
            return Err(format!("command {} (opcode {op}) is truncated", out.len()));
        }
        let (a, next) = rest.split_at(arity);
        if let Some(bad) = a.iter().find(|v| !v.is_finite()) {
            return Err(format!("command {} has a non-finite operand {bad}", out.len()));
        }
        let color = |c: &[f32]| -> Result<Rgba, String> {
            if c.iter().all(|v| (0.0..=1.0).contains(v)) {
                Ok(Rgba([c[0], c[1], c[2], c[3]]))
            } else {
                Err(format!("command {}: colour components must be between 0 and 1", out.len()))
            }
        };
        let nonneg = |v: f32, what: &str| if v >= 0.0 { Ok(v) } else { Err(format!("command {}: {what} must not be negative", out.len())) };
        let cmd = match op {
            1.0 => Cmd::Clear(color(a)?),
            2.0 => Cmd::Rect { x: a[0], y: a[1], w: nonneg(a[2], "width")?, h: nonneg(a[3], "height")?, color: color(&a[4..])? },
            3.0 => Cmd::Circle { cx: a[0], cy: a[1], radius: nonneg(a[2], "radius")?, color: color(&a[3..])? },
            4.0 => Cmd::RoundRect { x: a[0], y: a[1], w: nonneg(a[2], "width")?, h: nonneg(a[3], "height")?, radius: nonneg(a[4], "radius")?, color: color(&a[5..])? },
            _ => Cmd::Line { x0: a[0], y0: a[1], x1: a[2], y1: a[3], width: nonneg(a[4], "width")?, color: color(&a[5..])? },
        };
        out.push(cmd);
        p = next;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn encode(values: &[f32]) -> Vec<u8> {
    let mut all = vec![VERSION, values.len() as f32];
    all.extend_from_slice(values);
    all.extend_from_slice(&[0.0, 0.0]); // unused capacity is ignored
    all.iter().flat_map(|v| v.to_le_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_every_command() {
        let bytes = encode(&[
            1.0, 0.1, 0.2, 0.3, 1.0, //
            2.0, 1.0, 2.0, 3.0, 4.0, 1.0, 0.0, 0.0, 1.0, //
            3.0, 5.0, 6.0, 7.0, 0.0, 1.0, 0.0, 0.5, //
            4.0, 1.0, 2.0, 3.0, 4.0, 0.5, 0.0, 0.0, 1.0, 1.0, //
            5.0, 0.0, 0.0, 10.0, 10.0, 2.0, 1.0, 1.0, 1.0, 1.0,
        ]);
        let mut out = Vec::new();
        parse(&bytes, &mut out).unwrap();
        assert_eq!(out.len(), 5);
        assert_eq!(out[0], Cmd::Clear(Rgba([0.1, 0.2, 0.3, 1.0])));
        assert_eq!(out[2], Cmd::Circle { cx: 5.0, cy: 6.0, radius: 7.0, color: Rgba([0.0, 1.0, 0.0, 0.5]) });
        assert!(matches!(out[4], Cmd::Line { width, .. } if width == 2.0));
    }

    #[test]
    fn rejects_malformed_frames() {
        let mut out = Vec::new();
        let err = |values: &[f32]| parse(&encode(values), &mut Vec::new()).unwrap_err();
        assert!(err(&[9.0]).contains("unknown opcode 9"));
        assert!(err(&[2.0, 1.0, 2.0]).contains("truncated"));
        assert!(err(&[2.0, 0.0, 0.0, -1.0, 1.0, 0.0, 0.0, 0.0, 1.0]).contains("width must not be negative"));
        assert!(err(&[1.0, 2.0, 0.0, 0.0, 1.0]).contains("between 0 and 1"));
        assert!(err(&[3.0, f32::NAN, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]).contains("non-finite"));
        let mut bad_version = encode(&[]);
        bad_version[..4].copy_from_slice(&2.0f32.to_le_bytes());
        assert!(parse(&bad_version, &mut out).unwrap_err().contains("version"));
        let mut too_long = encode(&[]);
        too_long[4..8].copy_from_slice(&100.0f32.to_le_bytes());
        assert!(parse(&too_long, &mut out).unwrap_err().contains("does not fit"));
        assert!(check_size(MAX_FRAME_BYTES + 4).is_err());
        assert!(check_size(6).is_err());
        assert!(check_size(8).is_ok());
    }
}
