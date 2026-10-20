// One gesture on a running app (README.md). Positions are window points.
import XCTest

final class TouchUITests: XCTestCase {
  func testGesture() throws {
    let env = ProcessInfo.processInfo.environment
    let app = XCUIApplication(bundleIdentifier: try XCTUnwrap(env["RNR_BUNDLE_ID"]))
    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    let gesture = try XCTUnwrap(env["RNR_GESTURE"])
    let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
    let point = { (x: Double, y: Double) in origin.withOffset(CGVector(dx: x, dy: y)) }
    let numbers = { (name: String) throws -> [Double] in
      try XCTUnwrap(env[name]).split(separator: ",").map { Double($0)! }
    }
    switch gesture {
    case "drag", "hold":
      let f = try numbers("RNR_FRAME")
      let at = { (u: Double, v: Double) in point(f[0] + u * f[2], f[1] + v * f[3]) }
      let hold = gesture == "hold" ? Double(env["RNR_HOLD_S"] ?? "5")! : 0.3
      at(0.4, 0.5).press(forDuration: hold, thenDragTo: at(0.8, 0.8))
    case "pinch":
      app.pinch(withScale: 2.0, velocity: 1.0)
    case "tap":
      let p = try numbers("RNR_POINT")
      point(p[0], p[1]).tap()
    default:
      XCTFail("unknown gesture \(gesture)")
    }
    print("RNR-GESTURE-DONE \(gesture)")
  }
}
