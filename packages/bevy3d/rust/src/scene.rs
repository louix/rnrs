//! The Bevy side, shared by every platform: a headless Bevy app (no winit, no window, no event
//! loop) on our device, updated by the render loop (the native render thread, or the browser's
//! frame callback in `web.rs`). Its camera renders into an offscreen texture we own, registered
//! as a `ManualTextureView`; the platform presenter blits that texture onto its surface.
//!
//! Limits of this example:
//! - **No file assets.** Bevy's Android file reader needs an activity Bevy owns; here the
//!   default asset source is replaced by one that fails every read with an error naming this
//!   limit. The scene uses only in-code meshes and materials and Bevy's embedded shaders.
//! - No Bevy windows, audio or logging plugin; controls arrive as [`Controls`].
//! - **Touch** (Android): rnr-surface's touch records ([`BevyScene::feed_touch`]) become real
//!   Bevy `TouchInput` messages, so Bevy's own `touch_screen_input_system` maintains the
//!   `Touches` resource. Positions are logical pixels (physical ÷ scale), as bevy_winit would
//!   send. `TouchInput::window` is a [`SurfaceTouchTarget`] marker entity, **not** a Bevy
//!   `Window`: systems that look the window up (picking, UI focus, cursor) are unsupported.
//! - Single-threaded Bevy (no `multi_threaded`): simulation, extraction and rendering all run
//!   in `update()` on the render thread.
//! - **Render errors end rendering.** Bevy logs a render (wgpu validation or out-of-memory) error
//!   and then asks its `RenderErrorHandler`. Ours ([`on_render_error`]) stops rendering, like
//!   Bevy's default, and records the error; [`BevyScene::update`] then returns it, so the render
//!   thread fails the attachment instead of presenting a texture Bevy no longer writes. (Bevy's
//!   default also requests `AppExit`, which nothing here runs.)
use std::collections::HashMap;
use std::path::Path;

use bevy::app::{PanicHandlerPlugin, PluginGroupBuilder, PluginsState};
// Bevy has no SIGINT handler plugin in the browser.
#[cfg(not(target_arch = "wasm32"))]
use bevy::app::TerminalCtrlCHandlerPlugin;
use bevy::asset::io::{AssetReader, AssetReaderError, AssetSourceBuilder, AssetSourceId, PathStream, VecReader};
use bevy::camera::{ManualTextureViewHandle, RenderTarget};
use bevy::input::touch::{TouchInput, TouchPhase as BevyTouchPhase, Touches};
use bevy::prelude::*;
use bevy::render::error_handler::{RenderError, RenderErrorHandler, RenderErrorPolicy};
use bevy::render::renderer::{RenderAdapter, RenderAdapterInfo, RenderDevice, RenderInstance, RenderQueue};
use bevy::render::settings::RenderCreation;
use bevy::render::texture::{ManualTextureView, ManualTextureViews};
use bevy::render::view::{Msaa, Tonemapping};
use bevy::render::RenderPlugin;
use bevy::render::render_resource::{CachedPipelineState, PipelineCache, PipelineDescriptor};
use bevy::render::RenderApp;
use bevy::time::TimeUpdateStrategy;
use bevy::window::{ExitCondition, WindowPlugin};
use rnr_surface::touch::{TouchPhase, TouchRecord};

/// Latest-value controls from TypeScript, applied before the next update.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Controls {
    pub paused: bool,
    pub color: [f32; 3],
    pub speed: f32,
    pub rotation: Option<(u64, f32)>,
}

impl Default for Controls {
    fn default() -> Self {
        Self { paused: false, color: [0.9, 0.45, 0.1], speed: 1.0, rotation: None }
    }
}

/// The wgpu objects the platform created and hands to Bevy (`RenderCreation::Manual`).
pub struct Device<'a> {
    pub instance: &'a wgpu::Instance,
    pub adapter: &'a wgpu::Adapter,
    pub device: &'a wgpu::Device,
    pub queue: &'a wgpu::Queue,
}

/// Whether Bevy's pipeline for the lit cube (`opaque_mesh_pipeline`) exists yet. Where shaders
/// load asynchronously (the browser), the first frames are cleared without the cube.
#[derive(Debug, PartialEq)]
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))] // browser only (web.rs)
pub enum CubePipeline {
    Pending,
    Ready,
    Failed(String),
}

/// The label Bevy 0.20's mesh pipeline specialization gives opaque meshes.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))] // browser only (web.rs)
const CUBE_PIPELINE_LABEL: &str = "opaque_mesh_pipeline";

/// Bevy writes sRGB-encoded bytes into this format; the presenter reads them raw.
const TARGET_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;
const TARGET_HANDLE: ManualTextureViewHandle = ManualTextureViewHandle(0);
/// Updates run by [`BevyScene::new`] before any window is leased: Bevy compiles and
/// specializes its pipelines in the first updates, which can take seconds, and a held lease
/// would make a platform detach wait for that.
const WARM_UP_UPDATES: u32 = 3;
/// Bound on the plugin-readiness loop (manual device creation is ready at once).
const MAX_READY_SPINS: u32 = 10_000;

const NO_FILES: &str = "file assets are not supported by @rnrs/example-bevy3d (Bevy's Android asset reader needs an activity Bevy owns)";

/// The default asset source: every file read fails with [`NO_FILES`] instead of reaching
/// Bevy's Android reader (which would panic, and panics abort the app).
struct NoFiles;

impl AssetReader for NoFiles {
    async fn read<'a>(&'a self, path: &'a Path) -> Result<VecReader, AssetReaderError> {
        Err(no_files(path))
    }
    async fn read_meta<'a>(&'a self, path: &'a Path) -> Result<VecReader, AssetReaderError> {
        Err(no_files(path))
    }
    async fn read_directory<'a>(&'a self, path: &'a Path) -> Result<Box<PathStream>, AssetReaderError> {
        Err(no_files(path))
    }
    async fn is_directory<'a>(&'a self, path: &'a Path) -> Result<bool, AssetReaderError> {
        Err(no_files(path))
    }
}

fn no_files(path: &Path) -> AssetReaderError {
    log::error!("rnr-bevy3d: {NO_FILES}: {}", path.display());
    AssetReaderError::Io(std::sync::Arc::new(std::io::Error::new(std::io::ErrorKind::Unsupported, NO_FILES)))
}

#[derive(Resource, Default)]
struct Sim {
    controls: Controls,
    applied_color: Option<[f32; 3]>,
    angle: f32,
    applied_rotation: u64,
    /// Last x (logical px) applied per pressed touch id. Bevy's `Touch::delta` is not reset in
    /// frames without touch events (bevy#12442), so the drag uses its own last position.
    drag: HashMap<u64, f32>,
}

/// Cube rotation per logical pixel of horizontal drag.
const DRAG_RADIANS_PER_POINT: f32 = 0.01;

/// The entity named by every `TouchInput::window`: a marker for the rnr surface, not a Bevy
/// `Window` (there is none).
#[derive(Component)]
pub struct SurfaceTouchTarget;

/// Touch diagnostics of the adapter (counted when fed, before Bevy's next update).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TouchStats {
    pub started: u64,
    pub ended: u64,
    pub canceled: u64,
    /// Resets applied (each cancels every touch still down).
    pub resets: u64,
    /// Touches down as fed (Bevy's `Touches` matches after the next update).
    pub active: u64,
    /// Last fed position, logical pixels.
    pub last_x: f32,
    pub last_y: f32,
    /// Records dropped because rendering failed for their attachment (no update would read them).
    pub dropped_failed: u64,
}

/// Feeds rnr-surface touch records into the app as `TouchInput` messages and remembers which
/// ids are down, so a reset (or a new attachment) can cancel them.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))] // no touch input in the browser
struct TouchFeed {
    target: Entity,
    /// id → (attachment, last logical position).
    down: HashMap<u64, (u64, Vec2)>,
    stats: TouchStats,
    /// Rendering failed for this attachment: no update runs until a new one, so its records are
    /// dropped instead of written (Bevy keeps unread messages until an update).
    failed: Option<u64>,
}

#[cfg_attr(target_arch = "wasm32", allow(dead_code))] // no touch input in the browser
impl TouchFeed {
    fn new(world: &mut World) -> Self {
        Self { target: world.spawn(SurfaceTouchTarget).id(), down: HashMap::new(), stats: TouchStats::default(), failed: None }
    }

    /// Rendering failed for `attachment`: cancels every touch down (at most one message each)
    /// and drops that attachment's further records, so nothing accumulates while no update runs.
    fn fail(&mut self, world: &mut World, attachment: u64) {
        self.failed = Some(attachment);
        self.cancel(world, |_| true);
    }

    fn feed(&mut self, world: &mut World, records: &[TouchRecord]) {
        for record in records {
            if let Some(failed) = self.failed {
                match *record {
                    TouchRecord::Event(e) if e.attachment != failed => self.failed = None, // a new attachment
                    _ => {
                        // Resets have nothing to cancel (fail() did); events are dropped.
                        self.stats.dropped_failed += 1;
                        continue;
                    }
                }
            }
            match *record {
                TouchRecord::Reset { .. } => {
                    self.stats.resets += 1;
                    self.cancel(world, |_| true);
                }
                TouchRecord::Event(e) => {
                    let (x, y) = e.logical();
                    let position = Vec2::new(x, y);
                    let phase = match e.phase {
                        TouchPhase::Down => {
                            self.down.insert(e.id, (e.attachment, position));
                            self.stats.started += 1;
                            BevyTouchPhase::Started
                        }
                        TouchPhase::Move => match self.down.get_mut(&e.id) {
                            Some(entry) => {
                                entry.1 = position;
                                BevyTouchPhase::Moved
                            }
                            None => continue,
                        },
                        TouchPhase::Up | TouchPhase::Cancel => {
                            if self.down.remove(&e.id).is_none() {
                                continue;
                            }
                            if e.phase == TouchPhase::Up {
                                self.stats.ended += 1;
                                BevyTouchPhase::Ended
                            } else {
                                self.stats.canceled += 1;
                                BevyTouchPhase::Canceled
                            }
                        }
                    };
                    (self.stats.last_x, self.stats.last_y) = (x, y);
                    world.write_message(TouchInput { phase, position, window: self.target, force: None, id: e.id });
                }
            }
        }
        self.stats.active = self.down.len() as u64;
    }

    fn cancel(&mut self, world: &mut World, mut stale: impl FnMut(u64) -> bool) {
        let ids: Vec<(u64, Vec2)> = self.down.iter().filter(|(_, (a, _))| stale(*a)).map(|(id, (_, p))| (*id, *p)).collect();
        for (id, position) in ids {
            self.down.remove(&id);
            self.stats.canceled += 1;
            world.write_message(TouchInput { phase: BevyTouchPhase::Canceled, position, window: self.target, force: None, id });
        }
        self.stats.active = self.down.len() as u64;
    }
}

#[derive(Component)]
struct Spinner;

/// Set by [`on_render_error`]: Bevy has stopped rendering after this error.
#[derive(Resource)]
struct RenderFailed(String);

/// This example's `RenderErrorHandler` (Bevy has already logged the error): stop rendering and
/// record why, for [`BevyScene::update`]. No recovery is attempted.
fn on_render_error(error: &RenderError, main_world: &mut World, _render_world: &mut World) -> RenderErrorPolicy {
    main_world.insert_resource(RenderFailed(format!("Bevy stopped rendering after a {:?} error: {}", error.ty, error.description)));
    RenderErrorPolicy::StopRendering
}

/// The recorded render error, if Bevy has stopped rendering.
fn render_failure(world: &World) -> Option<String> {
    world.get_resource::<RenderFailed>().map(|f| f.0.clone())
}

fn spin(time: Res<Time>, touches: Res<Touches>, mut sim: ResMut<Sim>, mut cubes: Query<(&mut Transform, &MeshMaterial3d<StandardMaterial>), With<Spinner>>, mut materials: ResMut<Assets<StandardMaterial>>) {
    if let Some((sequence, angle)) = sim.controls.rotation {
        if sequence != sim.applied_rotation {
            sim.angle = angle;
            sim.applied_rotation = sequence;
        }
    }
    // A horizontal drag rotates the cube; auto-rotation waits while any touch is down.
    let mut dragging = false;
    for touch in touches.iter() {
        dragging = true;
        let x = touch.position().x;
        if let Some(last) = sim.drag.insert(touch.id(), x) {
            sim.angle = (sim.angle + (x - last) * DRAG_RADIANS_PER_POINT).rem_euclid(std::f32::consts::TAU);
        }
    }
    sim.drag.retain(|id, _| touches.get_pressed(*id).is_some());
    if !sim.controls.paused && !dragging {
        sim.angle = (sim.angle + sim.controls.speed * time.delta_secs()).rem_euclid(std::f32::consts::TAU);
    }
    let color = sim.controls.color;
    let recolor = sim.applied_color != Some(color);
    for (mut transform, material) in &mut cubes {
        transform.rotation = Quat::from_rotation_y(sim.angle) * Quat::from_rotation_x(0.45);
        if recolor {
            if let Some(mut m) = materials.get_mut(&material.0) {
                m.base_color = Color::srgb(color[0], color[1], color[2]);
            }
        }
    }
    sim.applied_color = Some(color);
}

fn setup(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut materials: ResMut<Assets<StandardMaterial>>) {
    commands.spawn((
        Mesh3d(meshes.add(Cuboid::new(1.4, 1.4, 1.4))),
        MeshMaterial3d(materials.add(StandardMaterial::from(Color::srgb(0.9, 0.45, 0.1)))),
        Transform::default(),
        Spinner,
    ));
    commands.spawn((DirectionalLight { illuminance: 8_000.0, ..default() }, Transform::from_xyz(3.0, 5.0, 4.0).looking_at(Vec3::ZERO, Vec3::Y)));
    commands.spawn((
        Camera3d::default(),
        RenderTarget::TextureView(TARGET_HANDLE),
        Tonemapping::None,
        Msaa::Off,
        Camera { clear_color: ClearColorConfig::Custom(Color::srgb(0.06, 0.07, 0.1)), ..default() },
        Transform::from_xyz(0.0, 1.2, 4.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
}

/// `DefaultPlugins` for the enabled Bevy features, minus the process-global ones (Bevy's panic
/// hook and its SIGINT handler; the host app owns those), with no primary window and our
/// device. Which plugins the group contains depends on features and target (Bevy panics when
/// disabling an absent one), so each is disabled only if present.
fn plugins(creation: RenderCreation) -> PluginGroupBuilder {
    let mut group = DefaultPlugins.build();
    if group.contains::<PanicHandlerPlugin>() {
        group = group.disable::<PanicHandlerPlugin>();
    }
    #[cfg(not(target_arch = "wasm32"))]
    if group.contains::<TerminalCtrlCHandlerPlugin>() {
        group = group.disable::<TerminalCtrlCHandlerPlugin>();
    }
    group
        .set(WindowPlugin { primary_window: None, exit_condition: ExitCondition::DontExit, close_when_requested: false, ..default() })
        .set(RenderPlugin { render_creation: creation, synchronous_pipeline_compilation: true, ..default() })
}

/// The offscreen texture Bevy renders into, with the raw (non-sRGB) view the blit reads.
struct Offscreen {
    _texture: wgpu::Texture,
    raw: wgpu::TextureView,
    size: (u32, u32),
}

pub struct BevyScene {
    app: App,
    offscreen: Offscreen,
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))] // no touch input in the browser
    touch: TouchFeed,
}

impl BevyScene {
    pub fn new(gpu: Device<'_>, size: (u32, u32)) -> Result<Self, String> {
        let creation = RenderCreation::manual(
            RenderDevice::from(gpu.device.clone()),
            RenderQueue::new(gpu.queue.clone()),
            RenderAdapterInfo::new(gpu.adapter.get_info()),
            RenderAdapter::new(gpu.adapter.clone()),
            RenderInstance::new(gpu.instance.clone()),
        );
        let mut app = App::new();
        app.register_asset_source(AssetSourceId::Default, AssetSourceBuilder::new(|| Box::new(NoFiles)));
        app.add_plugins(plugins(creation));
        app.init_resource::<Sim>().add_systems(Startup, setup).add_systems(Update, spin);
        let mut spins = 0;
        while app.plugins_state() == PluginsState::Adding {
            spins += 1;
            if spins > MAX_READY_SPINS {
                return Err("Bevy plugins did not become ready".into());
            }
            std::thread::yield_now();
        }
        app.finish();
        app.cleanup();
        // After the plugins, which insert Bevy's default handler.
        app.insert_resource(RenderErrorHandler(on_render_error));
        let offscreen = Self::offscreen(&mut app, gpu.device, size)?;
        let touch = TouchFeed::new(app.world_mut());
        let mut scene = Self { app, offscreen, touch };
        for _ in 0..WARM_UP_UPDATES {
            scene.update(Controls::default())?;
        }
        Ok(scene)
    }

    /// Recreates the offscreen texture at `size` (if it changed).
    pub fn resize(&mut self, device: &wgpu::Device, size: (u32, u32)) -> Result<(), String> {
        if self.offscreen.size != size {
            self.offscreen = Self::offscreen(&mut self.app, device, size)?;
        }
        Ok(())
    }

    /// Creates an offscreen texture at `size` and points the camera's target at it.
    fn offscreen(app: &mut App, device: &wgpu::Device, size: (u32, u32)) -> Result<Offscreen, String> {
        let max = device.limits().max_texture_dimension_2d;
        if size.0 == 0 || size.1 == 0 || size.0 > max || size.1 > max {
            return Err(format!("offscreen size {}x{} outside 1..={max}", size.0, size.1));
        }
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("rnr-bevy3d offscreen"),
            size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: TARGET_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[TARGET_FORMAT.remove_srgb_suffix()],
        });
        let srgb = texture.create_view(&Default::default());
        let raw = texture.create_view(&wgpu::TextureViewDescriptor { format: Some(TARGET_FORMAT.remove_srgb_suffix()), ..Default::default() });
        app.world_mut().resource_mut::<ManualTextureViews>().insert(
            TARGET_HANDLE,
            ManualTextureView { texture_view: srgb.into(), size: UVec2::new(size.0, size.1), view_format: TARGET_FORMAT },
        );
        Ok(Offscreen { _texture: texture, raw, size })
    }

    /// One simulation and render step with the latest controls; returns the cube's angle, or the
    /// render error after which Bevy stopped rendering (then the offscreen texture is stale).
    pub fn update(&mut self, controls: Controls) -> Result<f32, String> {
        self.app.world_mut().resource_mut::<Sim>().controls = controls;
        self.app.update();
        match render_failure(self.app.world()) {
            Some(error) => Err(error),
            None => Ok(self.app.world().resource::<Sim>().angle),
        }
    }

    /// Writes drained touch records as Bevy `TouchInput` messages, read by Bevy's touch system
    /// in the next update. A reset cancels every touch still down. Call for every drain, also
    /// while paused or detached, so no touch stays pressed.
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))] // no touch input in the browser
    pub fn feed_touch(&mut self, records: &[TouchRecord]) {
        self.touch.feed(self.app.world_mut(), records);
    }

    /// Cancels touches that belong to another attachment than `attachment`. The render thread
    /// calls it when it binds a new attachment, before updating (normally a no-op: detach
    /// already queued a reset that was fed first).
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))] // no touch input in the browser
    pub fn begin_attachment(&mut self, attachment: u64) {
        if self.touch.failed.is_some_and(|a| a != attachment) {
            self.touch.failed = None;
        }
        self.touch.cancel(self.app.world_mut(), |a| a != attachment);
    }

    /// Rendering failed for `attachment` (the render thread will not update until a new
    /// attachment): cancels the touches down and drops that attachment's further input.
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))] // no touch input in the browser
    pub fn fail_touch(&mut self, attachment: u64) {
        self.touch.fail(self.app.world_mut(), attachment);
    }

    /// Counted since this Bevy app was created.
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))] // no touch input in the browser
    pub fn touch_stats(&self) -> TouchStats {
        self.touch.stats
    }

    /// Touches Bevy's `Touches` resource holds pressed (as of the last update).
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))] // no touch input in the browser
    pub fn touches_pressed(&self) -> usize {
        self.app.world().resource::<Touches>().iter().count()
    }

    /// The finished frame, for the presenter's blit.
    pub fn view(&self) -> &wgpu::TextureView {
        &self.offscreen.raw
    }

    /// Sets the simulated angle (radians), e.g. carried over from an earlier Bevy app.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))] // browser only (web.rs)
    pub fn restore_angle(&mut self, angle: f32) {
        self.app.world_mut().resource_mut::<Sim>().angle = angle;
    }

    /// Makes the next updates advance Bevy's clock by exactly `step` (the caller's clamped frame
    /// delta) instead of the wall-clock time since the previous update. Unset (native), Bevy's
    /// own clock applies.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))] // browser only (web.rs)
    pub fn set_time_step(&mut self, step: std::time::Duration) {
        self.app.insert_resource(TimeUpdateStrategy::ManualDuration(step));
    }

    /// The state of the cube's pipeline in Bevy's render-world pipeline cache.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))] // browser only (web.rs)
    pub fn cube_pipeline(&self) -> CubePipeline {
        let Some(cache) = self.app.get_sub_app(RenderApp).and_then(|render| render.world().get_resource::<PipelineCache>()) else {
            return CubePipeline::Pending;
        };
        cube_pipeline_state(cache.pipelines().filter_map(|p| match &p.descriptor {
            PipelineDescriptor::RenderPipelineDescriptor(d) => Some((d.label.as_deref(), &p.state)),
            _ => None,
        }))
    }
}

/// Ready once any `opaque_mesh_pipeline` is created; failed if one failed to compile.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))] // browser only (web.rs)
fn cube_pipeline_state<'a>(pipelines: impl Iterator<Item = (Option<&'a str>, &'a CachedPipelineState)>) -> CubePipeline {
    let mut ready = false;
    for (label, state) in pipelines {
        if label != Some(CUBE_PIPELINE_LABEL) {
            continue;
        }
        match state {
            CachedPipelineState::Ok(_) => ready = true,
            CachedPipelineState::Err(error) => return CubePipeline::Failed(format!("Bevy's {CUBE_PIPELINE_LABEL} failed: {error}")),
            CachedPipelineState::Queued | CachedPipelineState::Creating(_) => {}
        }
    }
    if ready { CubePipeline::Ready } else { CubePipeline::Pending }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The plugin set is built without a GPU (nothing is added to an app): no global hooks, no
    /// winit, and the render, window (no primary window) and PBR plugins present.
    #[test]
    fn plugin_group_has_no_global_hooks_and_no_winit() {
        let group = plugins(RenderCreation::default());
        assert!(!group.enabled::<PanicHandlerPlugin>());
        assert!(!group.enabled::<TerminalCtrlCHandlerPlugin>());
        assert!(group.enabled::<RenderPlugin>() && group.enabled::<WindowPlugin>() && group.enabled::<bevy::pbr::PbrPlugin>());
    }

    /// The handler stops rendering and records the error, which is then reported; without an
    /// error nothing is reported. (No GPU: the handler is called as Bevy would call it.)
    #[test]
    fn render_error_stops_rendering_and_is_reported() {
        let (mut main_world, mut render_world) = (World::new(), World::new());
        assert_eq!(render_failure(&main_world), None);
        let error = RenderError { ty: bevy::render::error_handler::ErrorType::Validation, description: "binding 2: R16Float".into(), source: None };
        let policy = on_render_error(&error, &mut main_world, &mut render_world);
        assert!(matches!(policy, RenderErrorPolicy::StopRendering));
        let reported = render_failure(&main_world).expect("reported");
        assert!(reported.contains("Validation") && reported.contains("binding 2: R16Float"), "{reported}");
    }

    fn touch(attachment: u64, id: u64, phase: TouchPhase, x_px: f32) -> TouchRecord {
        let extent = rnr_surface::Extent { width: 1440, height: 1000, scale: 2.0 };
        TouchRecord::Event(rnr_surface::touch::TouchEvent { attachment, id, phase, x_px, y_px: 40.0, extent, time_ms: 0 })
    }

    /// A GPU-free app with Bevy's real input and time plugins and this scene's `spin` system:
    /// fed records reach Bevy's `Touches`, a drag rotates the (paused) simulation, and resets and
    /// new attachments cancel every touch, so none stays pressed.
    #[test]
    fn fed_touches_drive_bevy_touches_and_the_simulation() {
        let mut app = App::new();
        app.add_plugins((bevy::time::TimePlugin, bevy::input::InputPlugin));
        app.init_resource::<Assets<StandardMaterial>>();
        app.insert_resource(Sim { controls: Controls { paused: true, ..Controls::default() }, ..Sim::default() });
        app.add_systems(Update, spin);
        let mut feed = TouchFeed::new(app.world_mut());
        let pressed = |app: &App| app.world().resource::<Touches>().iter().map(|t| (t.id(), t.position())).collect::<Vec<_>>();
        let angle = |app: &App| app.world().resource::<Sim>().angle;

        feed.feed(app.world_mut(), &[touch(1, 1, TouchPhase::Down, 0.0)]);
        app.update();
        assert_eq!(pressed(&app), vec![(1, Vec2::new(0.0, 20.0))], "logical = physical / scale");
        assert!(app.world().resource::<Touches>().just_pressed(1));
        feed.feed(app.world_mut(), &[touch(1, 1, TouchPhase::Move, 100.0)]);
        app.update();
        assert!((angle(&app) - 50.0 * DRAG_RADIANS_PER_POINT).abs() < 1e-5, "{}", angle(&app));
        app.update(); // no events: no further rotation (bevy#12442 does not apply)
        assert!((angle(&app) - 0.5).abs() < 1e-5);

        feed.feed(app.world_mut(), &[touch(1, 2, TouchPhase::Down, 10.0), touch(1, 1, TouchPhase::Up, 100.0)]);
        app.update();
        assert!(app.world().resource::<Touches>().just_released(1));
        assert_eq!(pressed(&app).len(), 1);

        // Detach: a reset cancels touch 2, even with no frame in between the next attachment.
        feed.feed(app.world_mut(), &[TouchRecord::Reset { attachment: 1, reason: rnr_surface::touch::ResetReason::Detached }, touch(2, 3, TouchPhase::Down, 0.0)]);
        app.update();
        assert!(app.world().resource::<Touches>().just_canceled(2));
        assert_eq!(pressed(&app).iter().map(|t| t.0).collect::<Vec<_>>(), vec![3]);
        // A late move for a canceled id is ignored.
        feed.feed(app.world_mut(), &[touch(1, 2, TouchPhase::Move, 500.0)]);
        // Binding attachment 3 cancels what attachment 2 still had down.
        feed.cancel(app.world_mut(), |a| a != 3);
        app.update();
        assert!(pressed(&app).is_empty());
        assert!(app.world().resource::<Sim>().drag.is_empty());
        assert_eq!(feed.stats, TouchStats { started: 3, ended: 1, canceled: 2, resets: 1, active: 0, last_x: 0.0, last_y: 20.0, dropped_failed: 0 });
    }

    /// A failed attachment gets no updates, so its input must not pile up as unread Bevy
    /// messages: failing cancels what is down (one message per touch), then any number of its
    /// records adds nothing until a new attachment's input arrives. A per-pointer cancel maps to
    /// Bevy's `Canceled`.
    #[test]
    fn failed_attachment_input_stays_bounded_and_cancel_maps_to_canceled() {
        use bevy::ecs::message::Messages;
        let mut app = App::new();
        app.add_plugins(bevy::input::InputPlugin);
        let mut feed = TouchFeed::new(app.world_mut());
        let queued = |app: &App| app.world().resource::<Messages<TouchInput>>().len();

        feed.feed(app.world_mut(), &[touch(1, 1, TouchPhase::Down, 0.0), touch(1, 2, TouchPhase::Down, 0.0), touch(1, 2, TouchPhase::Cancel, 0.0)]);
        app.update();
        assert!(app.world().resource::<Touches>().just_canceled(2), "per-pointer cancel → Canceled");
        assert_eq!(queued(&app), 3);

        feed.fail(app.world_mut(), 1);
        let after_fail = queued(&app);
        assert_eq!(after_fail, 3 + 1, "one Canceled for the touch still down");
        let reset = TouchRecord::Reset { attachment: 1, reason: rnr_surface::touch::ResetReason::Overflow };
        for i in 0..10_000u64 {
            let id = 10 + i / 3;
            let record = match i % 4 {
                0 => touch(1, id, TouchPhase::Down, 0.0),
                1 => touch(1, id, TouchPhase::Move, i as f32),
                2 => touch(1, id, TouchPhase::Up, 0.0),
                _ => reset,
            };
            feed.feed(app.world_mut(), &[record]);
        }
        assert_eq!(queued(&app), after_fail, "nothing accumulates while failed");
        assert_eq!((feed.stats.active, feed.stats.dropped_failed), (0, 10_000));

        feed.feed(app.world_mut(), &[touch(2, 50_000, TouchPhase::Down, 0.0)]);
        app.update();
        let pressed: Vec<u64> = app.world().resource::<Touches>().iter().map(|t| t.id()).collect();
        assert_eq!(pressed, vec![50_000], "a new attachment's input resumes; touch 1 was canceled");
    }

    /// Without a GPU only the pending states can be built: no pipeline, other labels, or a cube
    /// pipeline still queued are all not ready.
    #[test]
    fn cube_pipeline_is_pending_until_created() {
        assert_eq!(cube_pipeline_state(std::iter::empty()), CubePipeline::Pending);
        let queued = CachedPipelineState::Queued;
        let states = [(Some("tonemapping"), &queued), (None, &queued), (Some(CUBE_PIPELINE_LABEL), &queued)];
        assert_eq!(cube_pipeline_state(states.into_iter()), CubePipeline::Pending);
    }
}
