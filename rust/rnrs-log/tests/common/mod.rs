//! A capturing sink for the integration tests.
#![allow(dead_code)]
use std::sync::{Arc, Mutex};

use rnrs_log::{Line, Sink};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Captured {
    pub level: tracing::Level,
    pub target: String,
    pub text: String,
}

#[derive(Clone, Default)]
pub struct Capture(pub Arc<Mutex<Vec<Captured>>>);

impl Capture {
    pub fn sink(&self) -> Sink {
        let lines = self.0.clone();
        Sink::Custom(Arc::new(move |line: Line<'_>| {
            lines.lock().unwrap().push(Captured { level: line.level, target: line.target.to_owned(), text: line.text.to_owned() });
        }))
    }

    pub fn take(&self) -> Vec<Captured> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }

    pub fn texts(&self) -> Vec<String> {
        self.take().into_iter().map(|c| c.text).collect()
    }
}
