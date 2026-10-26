// See RnrsSurfaceViewComponentView.h. Everything here runs on the main thread.
//
// The content view's standalone CAMetalLayer sublayer is the surface's window. It is attached while the view has a
// key, is in a window, has a nonzero size and the app is active (applicationState read live,
// so a cold launch that mounts while inactive waits for didBecomeActive). It is revoked,
// without waiting, on key change, removal from the window, will-resign-active, invalidate
// (unmount) and dealloc: the Rust side retains the view and the layer, so the renderer may finish an
// operation already in flight after the revoke returns. A busy attach (the surface shown in
// another view, or this layer still owned by a retiring attachment) retries with backoff
// (16 ms doubling to 1 s), one pending retry per view.
//
// The window is a standalone CAMetalLayer, not the view's backing layer: UIKit forbids off-main
// writes to a view's backing layer (C1 S3 run 2), and the render thread writes the Metal
// properties. RnrsMetalView keeps its default backing layer and owns `metalLayer`, created here on
// the main thread with delegate nil, opaque YES once and implicit actions disabled, and added as a
// sublayer. Single-writer protocol: the main thread owns the layer tree and writes only the
// sublayer's geometry (frame) and contentsScale, in a transaction with actions disabled; the
// render thread writes only the Metal properties, in its own explicit transaction with actions
// disabled. presentsWithTransaction is never set.
//
// Touch input (opt-in, touchInput="rust"; docs/surface.md, "Touch input"): UIKit touch phases go
// straight to Rust (rnrs_surface_touch) on the main thread, never through JS. The content view
// does not override the touch methods, so its touches reach this view through the responder
// chain. Ownership is per UITouch: a began touch is owned only if Rust accepts its down; every
// other touch, in the same NSSet or later, goes to super (the next responder). An owned touch
// stays owned until its own ended or cancelled, even after a revoke, a reattach or an opt-out:
// its remaining phases are then swallowed (stale), never forwarded to super and never sent to the
// new attachment. Slots (0..9) name the touches of the current attachment only: a revoke marks
// every owned touch stale and frees all slots, so a slot names a new pointer only after a new
// accepted down. Owned touches are retained (strong map keys, at most kMaxOwned) and removed at
// their end; touches UIKit ended without telling this view are purged (canceled in Rust if still
// forwarding) at the next began. RN children of this view do not consume touches in UIKit: a
// touch on a child that does not handle it travels up the responder chain to this view and, when
// opted in, is captured for Rust like a touch on the surface.
// Positions are view-local points times the attachment's scale (physical pixels); the time is
// UITouch.timestamp (system uptime) in milliseconds. multipleTouchEnabled is set on the content
// view only while opted in. No gesture recognizer is added and no parent is prevented from
// recognizing: a parent that takes the touches (a UIScrollView pan) cancels them here, which
// cancels them in Rust. React Native's own touch handler (a root-view recognizer that does not
// cancel touches in views) still delivers JS events for this view.
#import "RnrsSurfaceViewComponentView.h"

#import <QuartzCore/CAMetalLayer.h>
#import <UIKit/UIKit.h>

#import <react/renderer/components/RnrsSurfaceSpec/ComponentDescriptors.h>
#import <react/renderer/components/RnrsSurfaceSpec/Props.h>
#import <react/renderer/components/RnrsSurfaceSpec/RCTComponentViewHelpers.h>

#import <RnrsRuntime/RnrsSurfaceEntry.h>

using namespace facebook::react;

static const double kMaxSafeInteger = 9007199254740991.0;
static const double kRetryFirst = 0.016;
static const double kRetryMax = 1.0;
// rnrs_surface_touch phases (rnrs-surface touch.rs Phase::from_code).
static const int32_t kTouchDown = 0;
static const int32_t kTouchMove = 1;
static const int32_t kTouchUp = 2;
static const int32_t kTouchCancel = 3;
static const int32_t kTouchCancelAll = 4;
/// Slots per attachment: rnrs-surface touch.rs MAX_POINTERS.
static const int kTouchSlots = 10;
/// Owned touches retained at most (current slots plus stale touches still down).
static const NSUInteger kMaxOwned = 20;
/// The value of an owned touch that no longer forwards (revoked, reattached or opted out).
static const int kStale = -1;

static int64_t TouchTimeMs(NSTimeInterval seconds)
{
  return (int64_t)llround(seconds * 1000.0);
}

/// A UIView (default backing layer) hosting a standalone CAMetalLayer sublayer.
@interface RnrsMetalView : UIView
@property (nonatomic, readonly) CAMetalLayer *metalLayer;
@end

@implementation RnrsMetalView

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    _metalLayer = [CAMetalLayer layer];
    _metalLayer.delegate = nil;
    _metalLayer.opaque = YES; // once, before any attach
    NSNull *none = [NSNull null];
    _metalLayer.actions = @{@"bounds" : none, @"position" : none, @"frame" : none, @"contentsScale" : none, @"contents" : none};
    [self.layer addSublayer:_metalLayer];
  }
  return self;
}

// Geometry and scale of the sublayer, on the main thread, without implicit animations.
- (void)layoutSubviews
{
  [super layoutSubviews];
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  _metalLayer.frame = self.layer.bounds;
  _metalLayer.contentsScale = self.contentScaleFactor;
  [CATransaction commit];
}

- (void)setContentScaleFactor:(CGFloat)contentScaleFactor
{
  [super setContentScaleFactor:contentScaleFactor];
  [self setNeedsLayout];
}

@end

@implementation RnrsSurfaceViewComponentView {
  RnrsMetalView *_metalView;
  uint64_t _key;
  // Nonzero while attached: Rust's number for this attachment, and the key it belongs to.
  uint64_t _attachment;
  uint64_t _attachedKey;
  double _retryDelay;
  uint64_t _retryGeneration;
  // The scale passed with the current attachment's last attach or resize (Rust's extent).
  float _attachedScale;
  BOOL _touchInput;
  // Owned touches: UITouch (retained, by identity) -> slot of the current attachment, or kStale.
  NSMapTable<UITouch *, NSNumber *> *_owned;
  // Slots of the current attachment in use (bit i: slot i).
  uint32_t _slots;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<RnrsSurfaceViewComponentDescriptor>();
}

// Not recycled: a view is never reused for another surface key (the registry invalidates it).
+ (BOOL)shouldBeRecycled
{
  return NO;
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const RnrsSurfaceViewProps>();
    _props = defaultProps;
    _metalView = [[RnrsMetalView alloc] initWithFrame:self.bounds];
    self.contentView = _metalView;
    _owned = [[NSMapTable alloc] initWithKeyOptions:NSPointerFunctionsStrongMemory | NSPointerFunctionsObjectPointerPersonality
                                       valueOptions:NSPointerFunctionsStrongMemory
                                           capacity:kMaxOwned];
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserver:self selector:@selector(appWillResignActive) name:UIApplicationWillResignActiveNotification object:nil];
    [center addObserver:self selector:@selector(appDidBecomeActive) name:UIApplicationDidBecomeActiveNotification object:nil];
  }
  return self;
}

- (void)dealloc
{
  [NSNotificationCenter.defaultCenter removeObserver:self];
  [self revoke];
}

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps
{
  const auto &newProps = *std::static_pointer_cast<const RnrsSurfaceViewProps>(props);
  const double value = newProps.surfaceKey;
  const uint64_t next = (value >= 1.0 && value <= kMaxSafeInteger) ? (uint64_t)value : 0;
  [super updateProps:props oldProps:oldProps];
  [self setTouchInput:newProps.touchInput == RnrsSurfaceViewTouchInput::Rust];
  if (next != _key) {
    [self revoke];
    [self cancelRetry];
    _key = next;
    [self evaluate];
  }
}

// Fabric sets the content view's frame here; the attach condition and the extent are
// re-evaluated after every layout change (including rotation).
- (void)updateLayoutMetrics:(const LayoutMetrics &)layoutMetrics oldLayoutMetrics:(const LayoutMetrics &)oldLayoutMetrics
{
  [super updateLayoutMetrics:layoutMetrics oldLayoutMetrics:oldLayoutMetrics];
  // The sublayer takes its frame and scale now, before an attach or resize reads the extent.
  [_metalView layoutIfNeeded];
  [self evaluate];
}

- (void)didMoveToWindow
{
  [super didMoveToWindow];
  if (self.window != nil) {
    // A view without drawRect: defaults to scale 1; the drawable needs the screen's scale.
    _metalView.contentScaleFactor = self.window.screen.scale;
    [self evaluate];
  } else {
    [self revoke];
    [self cancelRetry];
  }
}

// Unmount (the registry invalidates non-recycled views). The sublayer leaves the layer tree only
// after the revoke; a retiring renderer may still configure or present to the detached layer
// (retained by Rust), inside admission only.
- (void)invalidate
{
  [self revoke];
  [self cancelRetry];
  _key = 0;
  [_metalView.metalLayer removeFromSuperlayer];
}

- (void)appWillResignActive
{
  NSLog(@"RnrsSurface: surface %llu: will resign active", _key);
  [self revoke];
  [self cancelRetry];
}

- (void)appDidBecomeActive
{
  NSLog(@"RnrsSurface: surface %llu: did become active", _key);
  [self evaluate];
}

/// Attaches, resizes or revokes as the current state requires; also the entry point of a retry.
- (void)evaluate
{
  const CGFloat scale = _metalView.contentScaleFactor;
  const CGSize size = _metalView.bounds.size;
  const uint32_t width = (uint32_t)MAX(0, lround(size.width * scale));
  const uint32_t height = (uint32_t)MAX(0, lround(size.height * scale));
  const BOOL active = UIApplication.sharedApplication.applicationState == UIApplicationStateActive;
  const BOOL wanted = _key != 0 && self.window != nil && width > 0 && height > 0 && active;
  if (_attachment != 0) {
    if (!wanted || _attachedKey != _key) {
      [self revoke];
    } else if (rnrs_surface_resize(_attachedKey, _attachment, width, height, (float)scale)) {
      _attachedScale = (float)scale;
      return;
    } else {
      // The surface was disposed while attached: nothing is retained for it any more.
      _attachment = 0;
      _attachedKey = 0;
      [self touchEpochEnded];
    }
  }
  if (!wanted) {
    if (_key != 0 && self.window != nil && width > 0 && height > 0 && !active) {
      NSLog(@"RnrsSurface: surface %llu: not attached while the app is inactive (applicationState %ld)", _key, (long)UIApplication.sharedApplication.applicationState);
    }
    return;
  }
  const int64_t result = rnrs_surface_attach(_key, (__bridge void *)_metalView, (__bridge void *)_metalView.metalLayer, width, height, (float)scale);
  if (result > 0) {
    _attachment = (uint64_t)result;
    _attachedKey = _key;
    _attachedScale = (float)scale;
    [self cancelRetry];
    NSLog(@"RnrsSurface: surface %llu: attached #%lld %ux%u @%.3f", _key, result, width, height, scale);
  } else if (result == -1) {
    if (_retryDelay == 0) {
      NSLog(@"RnrsSurface: surface %llu: busy (shown in another view, or the layer is still retiring); retrying", _key);
    }
    [self scheduleRetry];
  } else {
    NSLog(@"RnrsSurface: surface %llu: attach refused (unknown or closed key)", _key);
  }
}

- (void)revoke
{
  if (_attachment == 0) {
    return;
  }
  const int32_t status = rnrs_surface_revoke(_attachedKey, _attachment);
  NSLog(@"RnrsSurface: surface %llu: revoked #%llu (%s)", _attachedKey, _attachment, status == 0 ? "released" : status == 1 ? "retiring" : "stale");
  _attachment = 0;
  _attachedKey = 0;
  [self touchEpochEnded];
}

#pragma mark - Touch input

- (void)setTouchInput:(BOOL)enabled
{
  if (enabled == _touchInput) {
    return;
  }
  _touchInput = enabled;
  _metalView.multipleTouchEnabled = enabled;
  if (!enabled) {
    // Opt-out mid-gesture: cancel in Rust; the owned touches stay owned (swallowed) to their end.
    if (_slots != 0 && _attachment != 0) {
      rnrs_surface_touch(_attachedKey, _attachment, kTouchCancelAll, -1, 0, 0, TouchTimeMs(NSProcessInfo.processInfo.systemUptime));
    }
    [self touchEpochEnded];
  }
}

/// The current attachment's touches end (revoke, disposal, opt-out): Rust has reset or refuses
/// them. Owned touches stay owned but stale, and every slot is free for the next attachment.
- (void)touchEpochEnded
{
  for (UITouch *touch in _owned.keyEnumerator.allObjects) {
    [_owned setObject:@(kStale) forKey:touch];
  }
  _slots = 0;
}

/// Drops owned touches that UIKit ended without telling this view (bounded retention). One still
/// forwarding is canceled in Rust first, so its pointer does not stay down there.
- (void)purgeEndedTouches
{
  for (UITouch *touch in _owned.keyEnumerator.allObjects) {
    if (touch.phase == UITouchPhaseEnded || touch.phase == UITouchPhaseCancelled) {
      const int slot = [_owned objectForKey:touch].intValue;
      if (slot != kStale) {
        [self sendTouch:touch phase:kTouchCancel slot:slot];
      }
      [self releaseTouch:touch];
    }
  }
}

- (void)releaseTouch:(UITouch *)touch
{
  const int slot = [_owned objectForKey:touch].intValue;
  if (slot != kStale) {
    _slots &= ~(1u << slot);
  }
  [_owned removeObjectForKey:touch];
}

- (BOOL)sendTouch:(UITouch *)touch phase:(int32_t)phase slot:(int)slot
{
  const CGPoint p = [touch locationInView:_metalView];
  return rnrs_surface_touch(_attachedKey, _attachment, phase, slot, (float)(p.x * _attachedScale), (float)(p.y * _attachedScale), TouchTimeMs(touch.timestamp));
}

/// A began touch: owned if Rust accepts its down in a free slot of the current attachment.
- (BOOL)acceptTouch:(UITouch *)touch
{
  if (!_touchInput || _attachment == 0 || _owned.count >= kMaxOwned) {
    return NO;
  }
  int slot = 0;
  while (slot < kTouchSlots && (_slots & (1u << slot)) != 0) {
    slot++;
  }
  if (slot == kTouchSlots || ![self sendTouch:touch phase:kTouchDown slot:slot]) {
    return NO;
  }
  _slots |= 1u << slot;
  [_owned setObject:@(slot) forKey:touch];
  return YES;
}

- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event
{
  [self purgeEndedTouches];
  NSMutableSet<UITouch *> *others = [NSMutableSet set];
  for (UITouch *touch in touches) {
    if ([_owned objectForKey:touch] == nil && ![self acceptTouch:touch]) {
      [others addObject:touch];
    }
  }
  if (others.count > 0) {
    [super touchesBegan:others withEvent:event];
  }
}

- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event
{
  NSMutableSet<UITouch *> *others = [NSMutableSet set];
  for (UITouch *touch in touches) {
    NSNumber *slot = [_owned objectForKey:touch];
    if (slot == nil) {
      [others addObject:touch];
    } else if (slot.intValue != kStale) {
      [self sendTouch:touch phase:kTouchMove slot:slot.intValue];
    }
  }
  if (others.count > 0) {
    [super touchesMoved:others withEvent:event];
  }
}

/// Ends the owned touches of `touches` (sent as `phase` unless stale) and returns the others.
- (NSSet<UITouch *> *)finishTouches:(NSSet<UITouch *> *)touches phase:(int32_t)phase
{
  NSMutableSet<UITouch *> *others = [NSMutableSet set];
  for (UITouch *touch in touches) {
    NSNumber *slot = [_owned objectForKey:touch];
    if (slot == nil) {
      [others addObject:touch];
      continue;
    }
    if (slot.intValue != kStale) {
      [self sendTouch:touch phase:phase slot:slot.intValue];
    }
    [self releaseTouch:touch];
  }
  return others;
}

- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event
{
  NSSet<UITouch *> *others = [self finishTouches:touches phase:kTouchUp];
  if (others.count > 0) {
    [super touchesEnded:others withEvent:event];
  }
}

- (void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event
{
  NSSet<UITouch *> *others = [self finishTouches:touches phase:kTouchCancel];
  if (others.count > 0) {
    [super touchesCancelled:others withEvent:event];
  }
}

#pragma mark - Retry

- (void)scheduleRetry
{
  _retryDelay = _retryDelay == 0 ? kRetryFirst : MIN(_retryDelay * 2, kRetryMax);
  const uint64_t generation = ++_retryGeneration;
  __weak RnrsSurfaceViewComponentView *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(_retryDelay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    RnrsSurfaceViewComponentView *strongSelf = weakSelf;
    if (strongSelf != nil && strongSelf->_retryGeneration == generation) {
      [strongSelf evaluate];
    }
  });
}

- (void)cancelRetry
{
  _retryGeneration++;
  _retryDelay = 0;
}

@end

Class<RCTComponentViewProtocol> RnrsSurfaceViewCls(void)
{
  return RnrsSurfaceViewComponentView.class;
}
