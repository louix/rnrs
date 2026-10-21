//! Browser: keeps the probe's surface attachable. The browser host attaches only surfaces with a
//! registered producer, so this registers one that never draws (Canvas 2D presentation; every
//! render is "unchanged", nothing is rasterized and no GPU is used). [`Hold::close`] releases the
//! registration (one of rnrs-surface's four browser producer slots) without waiting for the probe
//! to be dropped.
use std::cell::RefCell;
use std::sync::Arc;

use rnrs_surface::web_producer::{self, Pixels, Producer, Registration};
use rnrs_surface::{Extent, Surface};

struct Blank;

impl Producer for Blank {
    fn render(&self, _extent: Extent, _redraw: bool) -> Result<Option<Pixels>, String> {
        Ok(None)
    }
}

pub struct Hold {
    /// The registration is dropped before the producer it names.
    slot: RefCell<Option<(Registration, Arc<dyn Producer>)>>,
}

impl Hold {
    pub fn new(surface: &Surface) -> Result<Self, String> {
        let producer: Arc<dyn Producer> = Arc::new(Blank);
        let registration = web_producer::register(surface, &producer)?;
        Ok(Self { slot: RefCell::new(Some((registration, producer))) })
    }

    /// Releases the producer slot. Idempotent.
    pub fn close(&self) {
        let taken = self.slot.borrow_mut().take();
        drop(taken); // no RefCell borrow held while the registration unregisters
    }
}
