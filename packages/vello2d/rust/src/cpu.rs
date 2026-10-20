//! CPU rasterization shared by platform presenters. No window, GPU or scheduler state.
use vello_cpu::color::{AlphaColor, Srgb};
use vello_cpu::kurbo::{Affine, Circle, Line, Rect, RoundedRect, Shape, Stroke};
use vello_cpu::{Level, Pixmap, RasterizerSettings, RenderContext, RenderMode, RenderSettings, Resources};

use crate::frame::{Cmd, Rgba};

/// Raster dimensions are u16 in vello_cpu; also bounds memory (4096² × 4 bytes = 64 MiB).
pub(crate) const MAX_RASTER: u32 = 4096;

pub(crate) struct CpuRaster {
    ctx: RenderContext,
    resources: Resources,
    pixmap: Pixmap,
}

impl CpuRaster {
    pub(crate) fn new(width: u16, height: u16) -> Self {
        let settings = RenderSettings { level: Level::try_detect().unwrap_or(Level::baseline()), num_threads: 0 };
        Self {
            ctx: RenderContext::new_with(width, height, settings),
            resources: Resources::new(),
            pixmap: Pixmap::new(width, height),
        }
    }

    pub(crate) fn size(&self) -> (u32, u32) {
        (u32::from(self.pixmap.width()), u32::from(self.pixmap.height()))
    }

    pub(crate) fn render(&mut self, cmds: &[Cmd], scale: f64) {
        let (width, height) = self.size();
        draw(&mut self.ctx, cmds, width, height, scale);
        let settings = RasterizerSettings { render_mode: RenderMode::OptimizeSpeed, ..Default::default() };
        self.ctx.render_with(&mut self.pixmap, &mut self.resources, settings);
    }

    pub(crate) fn pixels(&self) -> &[u8] {
        self.pixmap.data_as_u8_slice()
    }
}

/// Raster size and the raster pixels per layout unit for the physical extent: `resolution_scale` of the
/// window, reduced uniformly (aspect preserved) so neither side exceeds [`MAX_RASTER`].
pub(crate) fn raster_geometry(width: u32, height: u32, scale: f32, resolution_scale: f32) -> ((u32, u32), f64) {
    let (w, h) = (f64::from(width.max(1)), f64::from(height.max(1)));
    let limit = f64::from(MAX_RASTER);
    let s = f64::from(resolution_scale).min(limit / w).min(limit / h);
    let dim = |v: f64| ((v * s).round() as u32).clamp(1, MAX_RASTER);
    ((dim(w), dim(h)), f64::from(scale) * s)
}

fn color(c: Rgba) -> AlphaColor<Srgb> {
    AlphaColor::new(c.0)
}

/// Draws `cmds` (layout units) into `ctx` with `scale` raster pixels per layout unit.
pub(crate) fn draw(ctx: &mut RenderContext, cmds: &[Cmd], w: u32, h: u32, scale: f64) {
    ctx.reset();
    ctx.set_transform(Affine::IDENTITY);
    ctx.set_paint(AlphaColor::<Srgb>::from_rgb8(0, 0, 0));
    ctx.fill_rect(&Rect::new(0.0, 0.0, w.into(), h.into()));
    let t = Affine::scale(scale);
    let tolerance = 0.1 / scale.max(1e-3);
    for cmd in cmds {
        match *cmd {
            Cmd::Clear(c) => {
                ctx.set_transform(Affine::IDENTITY);
                ctx.set_paint(color(c));
                ctx.fill_rect(&Rect::new(0.0, 0.0, w.into(), h.into()));
            }
            Cmd::Rect { x, y, w, h, color: c } => {
                ctx.set_transform(t);
                ctx.set_paint(color(c));
                ctx.fill_rect(&Rect::new(x.into(), y.into(), (x + w).into(), (y + h).into()));
            }
            Cmd::Circle { cx, cy, radius, color: c } => {
                ctx.set_transform(t);
                ctx.set_paint(color(c));
                ctx.fill_path(&Circle::new((f64::from(cx), f64::from(cy)), radius.into()).to_path(tolerance));
            }
            Cmd::RoundRect { x, y, w, h, radius, color: c } => {
                ctx.set_transform(t);
                ctx.set_paint(color(c));
                ctx.fill_path(&RoundedRect::new(x.into(), y.into(), (x + w).into(), (y + h).into(), f64::from(radius)).to_path(tolerance));
            }
            Cmd::Line { x0, y0, x1, y1, width, color: c } => {
                ctx.set_transform(t);
                ctx.set_paint(color(c));
                ctx.set_stroke(Stroke::new(width.into()));
                ctx.stroke_path(&Line::new((f64::from(x0), f64::from(y0)), (f64::from(x1), f64::from(y1))).to_path(tolerance));
            }
        }
    }
    ctx.flush();
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{encode, parse};

    /// The CPU raster path alone (no GPU): commands land at the scaled pixel positions.
    #[test]
    fn rasterizes_scaled_commands() {
        let bytes = encode(&[
            1.0, 0.0, 0.0, 1.0, 1.0, // clear blue
            2.0, 10.0, 10.0, 20.0, 20.0, 1.0, 0.0, 0.0, 1.0, // red rect 10..30 (layout units)
            3.0, 80.0, 20.0, 10.0, 0.0, 1.0, 0.0, 1.0, // green circle
        ]);
        let mut cmds = Vec::new();
        parse(&bytes, &mut cmds).unwrap();
        let (w, h) = (200u32, 100u32);
        let settings = RenderSettings { level: Level::try_detect().unwrap_or(Level::baseline()), num_threads: 0 };
        let mut ctx = RenderContext::new_with(w as u16, h as u16, settings);
        let mut pixmap = Pixmap::new(w as u16, h as u16);
        draw(&mut ctx, &cmds, w, h, 2.0);
        ctx.render_with(&mut pixmap, &mut Resources::new(), RasterizerSettings::default());
        let px = |x: u32, y: u32| {
            let i = ((y * w + x) * 4) as usize;
            pixmap.data_as_u8_slice()[i..i + 4].to_vec()
        };
        assert_eq!(px(1, 1), [0, 0, 255, 255]);
        assert_eq!(px(40, 40), [255, 0, 0, 255], "rect scaled to 20..60 px");
        assert_eq!(px(70, 70), [0, 0, 255, 255]);
        assert_eq!(px(160, 40), [0, 255, 0, 255], "circle centre at (160, 40) px");
    }

    #[test]
    fn raster_geometry_scales_uniformly_when_clamped() {
        let e = (2000, 1000, 2.0);
        assert_eq!(raster_geometry(e.0, e.1, e.2, 1.0), ((2000, 1000), 2.0));
        assert_eq!(raster_geometry(e.0, e.1, e.2, 0.5), ((1000, 500), 1.0));
        // 8192 wide at full scale: clamped to 4096 and the drawing scale halved with it.
        let wide = (8192, 1024, 3.0);
        assert_eq!(raster_geometry(wide.0, wide.1, wide.2, 1.0), ((4096, 512), 1.5));
        let zero = (0, 0, 1.0);
        assert_eq!(raster_geometry(zero.0, zero.1, zero.2, 1.0).0, (1, 1));
    }
}
