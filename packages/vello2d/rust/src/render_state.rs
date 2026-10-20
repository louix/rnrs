/// Per-frame timings reported by a presenter, in milliseconds (CPU time on the render thread).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Timings {
    pub raster_ms: f64,
    pub upload_ms: f64,
    pub acquire_ms: f64,
    pub present_ms: f64,
}


#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum GpuState {
    #[default]
    None,
    Ready,
    Recovering,
    Failed,
}

impl GpuState {
    pub fn name(self) -> &'static str {
        match self {
            GpuState::None => "none",
            GpuState::Ready => "ready",
            GpuState::Recovering => "recovering",
            GpuState::Failed => "failed",
        }
    }
}


#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub frames_submitted: u64,
    pub frames_presented: u64,
    pub frames_replaced: u64,
    pub frames_invalid: u64,
    pub surface_errors: u64,
    pub surface_recreations: u64,
    pub device_losses: u64,
    pub recovery_attempts: u64,
    pub gpu: GpuState,
    pub last: Timings,
    pub last_submit_to_present_ms: f64,
    pub device_init_ms: f64,
    pub bound: Option<(u32, u32)>,
    pub presentation: String,
    pub last_error: Option<String>,
}

