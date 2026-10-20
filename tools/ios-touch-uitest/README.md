# iOS touch injection (lab tooling, simulator only)

An XCUITest UI-test bundle with no host app: it attaches to an already running app by bundle
id (`XCUIApplication(bundleIdentifier:)`) and performs one gesture. XCUITest synthesizes the
touches through the simulator's HID path, so they reach the app as ordinary `UITouch` events
(`UIApplication sendEvent:` → hit test → `touchesBegan:` …). Nothing calls Rust directly.

Used by `scripts/consumer/ios-touch-sim-test.mjs`:

    xcodebuild build-for-testing -project TouchUITests.xcodeproj -scheme TouchUITests \
      -destination id=<sim> -derivedDataPath <dir>
    TEST_RUNNER_RNR_BUNDLE_ID=<id> TEST_RUNNER_RNR_GESTURE=drag TEST_RUNNER_RNR_FRAME=x,y,w,h \
      xcodebuild test-without-building … -only-testing:TouchUITests/TouchUITests/testGesture

`RNR_FRAME` is the surface's window frame in points (from the app's `measureInWindow`).
Gestures: `drag` (press 0.3 s, drag across the surface), `hold` (press `RNR_HOLD_S` seconds,
then drag: the driver cancels, detaches or backgrounds meanwhile), `pinch` (two touches,
`XCUIElement.pinch` on the app, centered on the screen), `tap` (one tap at `RNR_POINT=x,y`).
Not for devices: a runner on a device is a second app install.
