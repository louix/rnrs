//! Measurement-only module for the conversion pilot (docs/pilot.md). Each method's work
//! depends on its input, so results are verifiable and the call cannot be skipped.
use rnrs_core::{CancelToken, Native};

pub mod rnr_interface;
use rnr_interface as spec;

#[derive(Default)]
pub struct Bench;

pub struct Cell(f64);

impl spec::Cell for Cell {
    fn get(&self) -> Result<f64, String> {
        Ok(self.0)
    }
}

impl spec::BenchModule for Bench {
    type CellImpl = Cell;

    fn scalar(&self, a: f64, b: f64) -> Result<f64, String> {
        Ok(a + b)
    }

    fn str_len(&self, s: String) -> Result<f64, String> {
        Ok(s.len() as f64)
    }

    fn str_echo(&self, s: String) -> Result<String, String> {
        Ok(s)
    }

    fn record(&self, p: spec::Point8) -> Result<f64, String> {
        Ok(p.a + p.b + p.c + p.d + p.e + p.f + p.g + p.h)
    }

    fn array(&self, xs: Vec<f64>) -> Result<f64, String> {
        Ok(xs.iter().sum())
    }

    fn union(&self, s: spec::Shape) -> Result<f64, String> {
        Ok(match s {
            spec::Shape::Circle { r } => 3.0 * r * r,
            spec::Shape::Rect { w, h } => w * h,
            spec::Shape::Tri { b, h } => b * h / 2.0,
        })
    }

    fn cell(&self, x: f64) -> Result<Native<Cell>, String> {
        Ok(Native::new(Cell(x)))
    }

    fn bytes_sum(&self, b: Vec<u8>) -> Result<f64, String> {
        Ok(b.iter().map(|&x| x as u64).sum::<u64>() as f64)
    }

    fn bytes_make(&self, n: f64) -> Result<Vec<u8>, String> {
        if !(n.fract() == 0.0 && (0.0..=8.0 * 1024.0 * 1024.0).contains(&n)) {
            return Err("n must be an integer from 0 to 8388608".into());
        }
        Ok((0..n as usize).map(|i| (i % 251) as u8).collect())
    }

    async fn later(&self, x: f64, _cancel: CancelToken) -> Result<f64, String> {
        Ok(x + 1.0)
    }

    fn nop(&self) -> Result<f64, String> {
        Ok(0.0)
    }
}
