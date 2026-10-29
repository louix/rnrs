//! Choose the browser's preferred canvas format for efficient presentation.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

/// The browser's preferred canvas format (first in `formats`), if the blit can write it
/// (8-bit, non-sRGB RGBA or BGRA). None otherwise: no other format is tried.
pub fn preferred_canvas_format(formats: &[wgpu::TextureFormat]) -> Option<wgpu::TextureFormat> {
    formats.first().copied().filter(|f| matches!(f, wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Bgra8Unorm))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wgpu::TextureFormat::{Bgra8Unorm, Rgba16Float, Rgba8Unorm};

    #[test]
    fn uses_the_preferred_format_even_when_another_is_listed() {
        // Order as wgpu reports it for a browser preferring bgra8unorm (Firefox on Linux).
        assert_eq!(preferred_canvas_format(&[Bgra8Unorm, Rgba8Unorm, Rgba16Float]), Some(Bgra8Unorm));
        assert_eq!(preferred_canvas_format(&[Rgba8Unorm, Bgra8Unorm]), Some(Rgba8Unorm));
    }

    #[test]
    fn refuses_rather_than_choosing_a_non_preferred_format() {
        assert_eq!(preferred_canvas_format(&[Rgba16Float, Bgra8Unorm, Rgba8Unorm]), None);
        assert_eq!(preferred_canvas_format(&[]), None);
    }
}
