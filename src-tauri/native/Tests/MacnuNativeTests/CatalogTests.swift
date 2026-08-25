import ApplicationServices
import CoreGraphics
import XCTest
@testable import MacnuNative

final class CatalogTests: XCTestCase {
    private let element = AXUIElementCreateSystemWide()
    private let display = CGRect(x: 0, y: 0, width: 1440, height: 900)

    private func candidate(
        pid: pid_t = 100,
        bundle: String = "example.status",
        label: String = "Status",
        identifier: String? = nil,
        role: String? = kAXMenuBarItemRole as String,
        frame: CGRect,
        actions: Set<String> = [kAXPressAction as String]
    ) -> AccessibilityCandidate {
        AccessibilityCandidate(
            element: element,
            pid: pid,
            appName: "Example",
            bundleIdentifier: bundle,
            label: label,
            identifier: identifier,
            role: role,
            frame: frame,
            actions: actions
        )
    }

    func testDistinctItemsWithTheSameLabelArePreserved() {
        let items = [
            candidate(frame: CGRect(x: 1200, y: 0, width: 24, height: 24)),
            candidate(frame: CGRect(x: 1240, y: 0, width: 24, height: 24))
        ]

        let result = catalogCandidates(
            items,
            targetDisplay: display,
            displays: [display]
        )

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result.map(\.frame.minX), [1200, 1240])
    }

    func testProcessesSharingABundleAreNeverCollapsed() {
        let items = [
            candidate(
                pid: 100,
                frame: CGRect(x: 1200, y: 0, width: 24, height: 24)
            ),
            candidate(
                pid: 200,
                frame: CGRect(x: 1240, y: 0, width: 24, height: 24)
            )
        ]

        let result = catalogCandidates(
            items,
            targetDisplay: display,
            displays: [display]
        )

        XCTAssertEqual(Set(result.map(\.pid)), [100, 200])
    }

    func testTargetDisplayCopiesWinEvenWhenLabelsAreDynamic() {
        let secondDisplay = CGRect(x: 1440, y: 0, width: 1920, height: 1080)
        let items = [
            candidate(
                label: "CPU 18%",
                frame: CGRect(x: 1300, y: 0, width: 52, height: 24)
            ),
            candidate(
                label: "CPU 21%",
                frame: CGRect(x: 3240, y: 0, width: 52, height: 24)
            )
        ]

        let result = catalogCandidates(
            items,
            targetDisplay: secondDisplay,
            displays: [display, secondDisplay]
        )

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].label, "CPU 21%")
        XCTAssertEqual(result[0].frame.minX, 3240)
    }

    func testWrapperAndLabelNodeBecomeOneStatusItem() {
        let wrapper = candidate(
            label: "Example",
            frame: CGRect(x: 1200, y: 0, width: 32, height: 24)
        )
        let label = candidate(
            label: "Connected",
            identifier: "connection-state",
            role: kAXStaticTextRole as String,
            frame: CGRect(x: 1206, y: 4, width: 20, height: 16),
            actions: []
        )

        let result = consolidatedStatusCandidates([wrapper, label])

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].label, "Connected")
        XCTAssertEqual(result[0].identifier, "connection-state")
        XCTAssertTrue(result[0].actions.contains(kAXPressAction as String))
    }

    func testDirectTargetHitDoesNotDependOnProjectedSourceGeometry() {
        // Candidate 0 may have come from a source display whose menu-bar layout
        // is horizontally different. The actual target-window hit remains
        // authoritative and is assigned without consulting that source frame.
        let assignments = uniqueDirectHitAssignments([nil, 0, nil])

        XCTAssertEqual(assignments, [0: 1])
    }

    func testAmbiguousDirectTargetHitsAreRejected() {
        // If two target windows resolve to the same AX identity, choosing the
        // first would be order-based guessing. Neither window is assigned.
        let assignments = uniqueDirectHitAssignments([0, 0, 1])

        XCTAssertNil(assignments[0])
        XCTAssertEqual(assignments[1], 2)
    }

    func testProjectedCandidatesRemainAvailableForDirectTargetAssociation() {
        let secondDisplay = CGRect(x: 1440, y: 0, width: 1920, height: 1080)
        let sourceOnlyItems = [
            candidate(
                pid: 100,
                label: "First",
                identifier: "first",
                frame: CGRect(x: 1240, y: 0, width: 24, height: 24)
            ),
            candidate(
                pid: 200,
                bundle: "example.other",
                label: "Second",
                identifier: "second",
                frame: CGRect(x: 1280, y: 0, width: 32, height: 24)
            )
        ]

        let result = catalogCandidates(
            sourceOnlyItems,
            targetDisplay: secondDisplay,
            displays: [display, secondDisplay]
        )

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(Set(result.compactMap(\.identifier)), ["first", "second"])
    }

    func testInstallationIdentifierNormalizationRejectsNonUUIDValues() {
        XCTAssertNil(normalizedInstallationIdentifier(nil))
        XCTAssertNil(normalizedInstallationIdentifier("not-a-device-identifier"))
    }

    func testInstallationIdentifierNormalizationIsStableAndLowercase() {
        let identifier = "47596AD9-A811-4EBF-AC8A-03FC7B6D2A17"

        XCTAssertEqual(
            normalizedInstallationIdentifier(identifier),
            "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17"
        )
    }
}
