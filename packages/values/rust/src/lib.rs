//! Implementation of the Values fixture spec (packages/values/values.spec.ts): plain Rust
//! over the generated records, arrays, strings and options.
use std::sync::Mutex;
use std::time::Duration;

use rnrs_core::{CancelToken, Native};

pub mod rnr_interface;
use rnr_interface as spec;
use spec::{Blob, Event, Labeled, Point, Shape, Size, Slot, Tagged};

#[derive(Default)]
pub struct Values;

#[derive(Default)]
pub struct PointBag(Mutex<Vec<Point>>);

impl spec::Bag for PointBag {
    fn add(&self, p: Point) -> Result<f64, String> {
        let mut points = self.0.lock().unwrap_or_else(|e| e.into_inner());
        points.push(p);
        Ok(points.len() as f64)
    }

    fn count(&self) -> Result<f64, String> {
        Ok(self.0.lock().unwrap_or_else(|e| e.into_inner()).len() as f64)
    }
}

impl spec::ValuesModule for Values {
    type BagImpl = PointBag;

    fn echo_number(&self, x: f64) -> Result<f64, String> {
        Ok(x)
    }
    fn echo_bool(&self, b: bool) -> Result<bool, String> {
        Ok(b)
    }
    fn echo_string(&self, s: String) -> Result<String, String> {
        Ok(s)
    }
    fn utf8_length(&self, s: String) -> Result<f64, String> {
        Ok(s.len() as f64)
    }
    fn echo_numbers(&self, xs: Vec<f64>) -> Result<Vec<f64>, String> {
        Ok(xs)
    }
    fn sum(&self, xs: Vec<f64>) -> Result<f64, String> {
        Ok(xs.iter().sum())
    }
    fn nested_sum(&self, xs: Vec<Vec<f64>>) -> Result<f64, String> {
        Ok(xs.iter().flatten().sum())
    }
    fn echo_strings(&self, xs: Vec<String>) -> Result<Vec<String>, String> {
        Ok(xs)
    }
    fn echo_point(&self, p: Point) -> Result<Point, String> {
        Ok(p)
    }
    fn echo_labeled(&self, l: Labeled) -> Result<Labeled, String> {
        Ok(l)
    }
    fn describe(&self, l: Labeled) -> Result<String, String> {
        let parent = l.parent.map_or("null".into(), |p| format!("({},{})", p.x, p.y));
        let points: Vec<String> = l.points.iter().map(|p| format!("({},{})", p.x, p.y)).collect();
        Ok(format!("{}|{}|{}|{}|{}", l.label, l.tags.join(","), l.note.as_deref().unwrap_or("<none>"), parent, points.join(";")))
    }
    fn maybe(&self, x: Option<f64>) -> Result<Option<f64>, String> {
        Ok(x.map(|x| x * 2.0))
    }
    fn maybe_string(&self, s: Option<String>) -> Result<Option<String>, String> {
        Ok(s.map(|s| s.to_uppercase()))
    }
    fn maybe_point(&self, p: Option<Point>) -> Result<Option<Point>, String> {
        Ok(p.map(|p| Point { x: p.y, y: p.x }))
    }
    fn optional_arg(&self, a: f64, b: Option<f64>) -> Result<String, String> {
        Ok(match b {
            Some(b) => format!("{a}+{b}"),
            None => format!("{a}+none"),
        })
    }
    fn points(&self, n: f64) -> Result<Vec<Point>, String> {
        if !(0.0..=1000.0).contains(&n) || n.fract() != 0.0 {
            return Err("n must be an integer from 0 to 1000".into());
        }
        Ok((0..n as usize).map(|i| Point { x: i as f64, y: -(i as f64) }).collect())
    }
    async fn echo_labeled_later(&self, l: Labeled, ms: f64, _cancel: CancelToken) -> Result<Labeled, String> {
        sleep(Duration::from_secs_f64(ms.clamp(0.0, 1000.0) / 1000.0)).await;
        Ok(l)
    }
    fn echo_shape(&self, s: Shape) -> Result<Shape, String> {
        Ok(s)
    }
    fn area(&self, s: Shape) -> Result<f64, String> {
        Ok(match s {
            Shape::Circle { radius } => std::f64::consts::PI * radius * radius,
            Shape::Rect { width, height } => width * height,
            Shape::Empty => 0.0,
        })
    }
    fn echo_tagged(&self, t: Tagged) -> Result<Tagged, String> {
        Ok(t)
    }
    fn echo_event(&self, e: Event) -> Result<Event, String> {
        Ok(e)
    }
    fn all_shapes(&self) -> Result<Vec<Shape>, String> {
        Ok(vec![Shape::Circle { radius: 1.0 }, Shape::Rect { width: 2.0, height: 3.0 }, Shape::Empty])
    }
    fn maybe_shape(&self, s: Option<Shape>) -> Result<Option<Shape>, String> {
        Ok(s)
    }
    async fn scale_later(&self, s: Shape, factor: f64, _cancel: CancelToken) -> Result<Shape, String> {
        sleep(Duration::from_millis(1)).await;
        Ok(match s {
            Shape::Circle { radius } => Shape::Circle { radius: radius * factor },
            Shape::Rect { width, height } => Shape::Rect { width: width * factor, height: height * factor },
            Shape::Empty => Shape::Empty,
        })
    }
    fn size_area(&self, s: Size) -> Result<f64, String> {
        Ok(s.width * s.height)
    }
    fn echo_slot(&self, slot: Slot) -> Result<Slot, String> {
        Ok(slot)
    }
    fn echo_bytes(&self, b: Vec<u8>) -> Result<Vec<u8>, String> {
        Ok(b)
    }
    fn byte_sum(&self, b: Vec<u8>) -> Result<f64, String> {
        Ok(b.iter().map(|&x| x as f64).sum())
    }
    fn make_bytes(&self, n: f64) -> Result<Vec<u8>, String> {
        if !(0.0..=16_777_216.0).contains(&n) || n.fract() != 0.0 {
            return Err("n must be an integer from 0 to 16777216".into());
        }
        Ok((0..n as usize).map(|i| i as u8).collect())
    }
    fn maybe_bytes(&self, b: Option<Vec<u8>>) -> Result<Option<Vec<u8>>, String> {
        Ok(b)
    }
    fn byte_lengths(&self, xs: Vec<Vec<u8>>) -> Result<Vec<f64>, String> {
        Ok(xs.iter().map(|x| x.len() as f64).collect())
    }
    fn echo_blob(&self, b: Blob) -> Result<Blob, String> {
        Ok(b)
    }
    async fn bytes_later(&self, b: Vec<u8>, ms: f64, _cancel: CancelToken) -> Result<Vec<u8>, String> {
        sleep(Duration::from_secs_f64(ms.clamp(0.0, 1000.0) / 1000.0)).await;
        Ok(b)
    }
    async fn double_later(&self, x: f64, _cancel: CancelToken) -> Result<f64, String> {
        sleep(Duration::from_millis(1)).await;
        Ok(x * 2.0)
    }
    fn mix(&self, env: f64, receiver: String, result: bool) -> Result<String, String> {
        Ok(format!("{env}|{receiver}|{result}"))
    }
    fn bag(&self) -> Result<Native<PointBag>, String> {
        Ok(Native::new(PointBag::default()))
    }
}

#[cfg(not(target_arch = "wasm32"))]
async fn sleep(delay: Duration) {
    tokio::time::sleep(delay).await
}

#[cfg(target_arch = "wasm32")]
async fn sleep(delay: Duration) {
    gloo_timers::future::sleep(delay).await
}
