import ApplicationServices
import CoreGraphics
import XCTest
@testable import MacnuNative

final class StatusClickValidationTests: XCTestCase {
    private let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
    private let frame = CGRect(x: 470, y: 4.5, width: 34, height: 24)

    func testHitMustBelongToSelectedAppAndExactControl() {
        func point(pid: pid_t = 42, bounds: CGRect? = nil) -> CGPoint? {
            verifiedStatusClickPoint(hitPID: pid, hitFrame: bounds ?? frame,
                targetPID: 42, targetFrame: frame, requestedFrame: frame, displays: [display])
        }
        XCTAssertEqual(point(), CGPoint(x: 487, y: 16.5))
        XCTAssertNil(point(pid: 99), "A foreground app covering the icon must never be clicked")
        XCTAssertNil(point(bounds: frame.offsetBy(dx: 36, dy: 0)), "A neighbouring icon from the same app is not the target")
        XCTAssertNil(point(bounds: CGRect(x: 470, y: 4.5, width: 68, height: 24)))
    }

    func testMovedAndDisconnectedDisplayTargetsAreRejected() {
        let external = CGRect(x: 1512, y: 0, width: 1920, height: 1080)
        let moved = frame.offsetBy(dx: 1512, dy: 0)
        XCTAssertNil(verifiedStatusClickPoint(hitPID: 42, hitFrame: moved, targetPID: 42,
            targetFrame: moved, requestedFrame: frame, displays: [display, external]))
        XCTAssertNil(verifiedStatusClickPoint(hitPID: 42, hitFrame: moved, targetPID: 42,
            targetFrame: moved, requestedFrame: moved, displays: [display]))
    }

    func testInvalidFramesCannotAuthorizeClicks() {
        for invalid in [CGRect.zero, .null, .infinite, CGRect(x: CGFloat.nan, y: 0, width: 24, height: 24)] {
            XCTAssertFalse(statusFramesMatch(invalid, invalid))
        }
    }

    func testPointerRestorationDoesNotOverrideUserMovement() {
        let original = CGPoint(x: 700, y: 400)
        let clicked = CGPoint(x: 487, y: 16.5)
        XCTAssertEqual(statusClickRestorationPoint(original: original, current: clicked, posted: clicked), original)
        XCTAssertNil(statusClickRestorationPoint(original: original, current: CGPoint(x: 800, y: 500), posted: clicked))
        XCTAssertNil(statusClickRestorationPoint(original: original, current: original, posted: clicked))
    }

    func testCollapsedItemsStackedUnderTheOverflowControlAreRevealed() {
        // Frames reported by macOS 27 with the menu bar collapsed.
        let control = CGRect(x: 871, y: 1, width: 17.5, height: 30)
        for hidden in [
            CGRect(x: 837, y: 4.5, width: 52, height: 24),
            CGRect(x: 853, y: 4.5, width: 36, height: 24),
            CGRect(x: 857, y: 4.5, width: 24, height: 24),
            // Earlier layouts end entirely to the control's left.
            CGRect(x: 700, y: 4.5, width: 24, height: 24)
        ] {
            XCTAssertTrue(statusItemIsBehindOverflowControl(item: hidden, control: control))
        }
        for visible in [
            CGRect(x: 895, y: 4.5, width: 32, height: 24),
            CGRect(x: 1267, y: 5.5, width: 22, height: 22),
            control
        ] {
            XCTAssertFalse(statusItemIsBehindOverflowControl(item: visible, control: control))
        }
        for invalid in [CGRect.zero, CGRect.infinite, CGRect.null] {
            XCTAssertFalse(statusItemIsBehindOverflowControl(item: invalid, control: control))
            XCTAssertFalse(statusItemIsBehindOverflowControl(
                item: CGRect(x: 837, y: 4.5, width: 52, height: 24), control: invalid
            ))
        }
    }

    func testRepeatedReferencesAreDeduplicatedButDifferentTargetsAreRejected() {
        let wrapper = AXUIElementCreateApplication(100)
        let child = AXUIElementCreateApplication(42)
        let target = HostedStatusTarget(wrapper: wrapper, child: child, window: wrapper, hostPID: 100)
        let duplicate = HostedStatusTarget(wrapper: AXUIElementCreateApplication(100),
            child: AXUIElementCreateApplication(42), window: wrapper, hostPID: 100)
        XCTAssertNotNil(uniqueHostedStatusTarget([target, duplicate]))
        let ambiguous = HostedStatusTarget(wrapper: AXUIElementCreateApplication(101),
            child: child, window: wrapper, hostPID: 100)
        XCTAssertNil(uniqueHostedStatusTarget([target, ambiguous]))
        XCTAssertNil(uniqueHostedStatusTarget([]))
    }
}
