import ApplicationServices
import CoreGraphics
import XCTest
@testable import MacnuNative

final class CatalogTests: XCTestCase {
    func testPinnedArtworkCacheReusesPixelsAndInvalidatesChangedFiles() {
        var cache = PinnedArtworkCache(lifetime: 60, capacity: 2)
        var loads = 0
        func load() -> String { loads += 1; return "image-\(loads)" }
        let modified = Date(timeIntervalSince1970: 1)
        XCTAssertEqual(cache.image(identifier: "example.app", path: "/A.app",
            modifiedAt: modified, now: 0, load: load), "image-1")
        XCTAssertEqual(cache.image(identifier: "example.app", path: "/A.app",
            modifiedAt: modified, now: 59, load: load), "image-1")
        XCTAssertEqual(loads, 1)
        XCTAssertEqual(cache.image(identifier: "example.app", path: "/A.app",
            modifiedAt: modified, now: 60, load: load), "image-2")
        XCTAssertEqual(cache.image(identifier: "example.app", path: "/B.app",
            modifiedAt: modified, now: 61, load: load), "image-3")
        XCTAssertEqual(cache.image(identifier: "example.app", path: "/B.app",
            modifiedAt: nil, now: 62, load: load), "image-4")
        XCTAssertEqual(cache.image(identifier: "example.other", path: "/B.app",
            modifiedAt: nil, now: 63, load: load), "image-5")
        _ = cache.image(identifier: "example.third", path: "/C.app",
            modifiedAt: nil, now: 64, load: load)
        XCTAssertEqual(cache.image(identifier: "example.app", path: "/B.app",
            modifiedAt: nil, now: 65, load: load), "image-7", "Oldest artwork is evicted")
    }

    func testPinnedArtworkCacheDoesNotRetainFailedLoads() {
        var cache = PinnedArtworkCache()
        XCTAssertEqual(cache.image(identifier: "example.app", path: "/A.app",
            modifiedAt: nil, now: 0, load: { "" }), "")
        XCTAssertEqual(cache.image(identifier: "example.app", path: "/A.app",
            modifiedAt: nil, now: 1, load: { "recovered" }), "recovered")
    }

    func testDifferentMonitorOrderCannotBindProtonToMolesWindow() {
        let builtIn = CGRect(x: 0, y: 0, width: 1512, height: 982)
        let external = CGRect(x: 1512, y: -98, width: 1920, height: 1080)
        let proton = candidate(label: "Proton Drive",
            frame: CGRect(x: 842, y: 4.5, width: 24, height: 24))
        let mole = MenuWindow(id: 77320, pid: 1073, owner: "Control Centre",
            bounds: CGRect(x: 2753, y: -98, width: 126, height: 30), isOnScreen: true)
        let matches = activationWindowMatches(
            windows: [mole], candidates: [proton], targetDisplay: external,
            displays: [builtIn, external], strictMatches: [:],
            hasTopSafeArea: { _ in false },
            hitWindow: { _, _ in XCTFail("Source geometry must not be projected for activation"); return mole.id }
        )
        XCTAssertTrue(matches.isEmpty)
        // Discovery keeps the identity available during the focus transition.
        XCTAssertEqual(catalogCandidates([proton], targetDisplay: external,
            displays: [builtIn, external]).count, 1)
        // An actual AX identity match on the destination remains valid.
        let strict = activationWindowMatches(
            windows: [mole], candidates: [proton], targetDisplay: external,
            displays: [builtIn, external], strictMatches: [0: mole],
            hasTopSafeArea: { _ in false }, hitWindow: { _, _ in nil }
        )
        XCTAssertEqual(strict[0]?.id, mole.id)
    }

    func testCachedElementSurvivesChangingMetricsAndWidth() {
        let frame = CGRect(x: 748, y: 4.5, width: 128, height: 24)
        let original = candidate(label: "CPU 18% Memory 42%", frame: frame)
        let current = candidate(label: "CPU 76% Memory 43%",
            frame: CGRect(x: 738, y: 4.5, width: 138, height: 24))
        let refreshed = uniqueLiveElementCandidate(original,
            preferredAction: kAXPressAction as String, in: [current])

        XCTAssertEqual(refreshed?.label, current.label)
        XCTAssertEqual(refreshed?.frame, current.frame)
        // Without the retained AX identity, a changed label/position remains
        // insufficient evidence to select an item from a fresh global scan.
        XCTAssertNil(resolvedAccessibilityCandidate(
            pid: original.pid, bundleIdentifier: original.bundleIdentifier,
            identifier: nil, label: original.label, frame: original.frame,
            preferredAction: kAXPressAction as String, in: [current]
        ))
    }

    func testCachedElementValidationRejectsDuplicatesAndReplacementElements() {
        let frame = CGRect(x: 1200, y: 4, width: 24, height: 24)
        let original = candidate(label: "Menu", frame: frame)
        // Distinct synthetic AX objects model two items owned by the same app.
        let replacement = candidate(element: AXUIElementCreateApplication(999),
            label: "Menu", frame: frame)
        let resolve: ([AccessibilityCandidate]) -> AccessibilityCandidate? = {
            uniqueLiveElementCandidate(original,
                preferredAction: kAXPressAction as String, in: $0)
        }

        XCTAssertNil(resolve([original, original]))
        XCTAssertNil(resolve([replacement]))
        XCTAssertNil(resolve([]))
        XCTAssertTrue(CFEqual(resolve([replacement, original])?.element, original.element))
    }

    func testCachedElementRefreshPreservesDisplayBoundary() {
        let frame = CGRect(x: 1200, y: 4, width: 24, height: 24)
        let external = display.offsetBy(dx: 1440, dy: 0)
        let original = candidate(label: "CPU 18%", frame: frame)
        let moved = candidate(label: "CPU 76%", frame: frame.offsetBy(dx: 1440, dy: 0))
        let refreshed = uniqueLiveElementCandidate(original,
            preferredAction: kAXPressAction as String, in: [moved])

        XCTAssertNotNil(refreshed)
        XCTAssertFalse(activationFramesShareDisplay(requested: original.frame,
            target: refreshed!.frame, displays: [display, external]))
    }

    func testStalePositionCannotSelectAReplacementItem() {
        let frame = CGRect(x: 1200, y: 0, width: 24, height: 24)
        let replacement = candidate(label: "Different menu", frame: frame)
        let result = resolvedAccessibilityCandidate(
            pid: 100, bundleIdentifier: "example.status", identifier: nil,
            label: "Original menu", frame: frame,
            preferredAction: kAXPressAction as String, in: [replacement]
        )
        XCTAssertNil(result)
    }

    func testLabelResolutionAcceptsSmallMovesButRejectsAmbiguity() {
        let frame = CGRect(x: 1200, y: 0, width: 24, height: 24)
        let same = candidate(label: "Original menu", frame: frame.offsetBy(dx: 4, dy: 0))
        let replacement = candidate(label: "Different menu", frame: frame)
        let resolve: ([AccessibilityCandidate]) -> AccessibilityCandidate? = {
            resolvedAccessibilityCandidate(
                pid: 100, bundleIdentifier: "example.status", identifier: nil,
                label: "Original menu", frame: frame,
                preferredAction: kAXPressAction as String, in: $0
            )
        }
        XCTAssertEqual(resolve([replacement, same])?.label, "Original menu")
        XCTAssertNil(resolve([same, same]))
        XCTAssertNil(resolve([candidate(pid: 999, label: "Original menu", frame: frame)]))
        XCTAssertNil(resolve([candidate(bundle: "other.app", label: "Original menu", frame: frame)]))
    }

    func testIdentifierResolutionStillAllowsChangingStatusLabels() {
        let frame = CGRect(x: 1200, y: 0, width: 24, height: 24)
        let current = candidate(label: "CPU 76%", identifier: "stable-status", frame: frame)
        let resolve: ([AccessibilityCandidate]) -> AccessibilityCandidate? = {
            resolvedAccessibilityCandidate(
                pid: 100, bundleIdentifier: "example.status", identifier: "stable-status",
                label: "CPU 18%", frame: frame,
                preferredAction: kAXPressAction as String, in: $0
            )
        }
        XCTAssertEqual(resolve([current])?.label, "CPU 76%")
        XCTAssertNil(resolve([current, current]))
        XCTAssertNil(resolve([candidate(label: "CPU 18%", identifier: "other", frame: frame)]))
    }

    func testCachedElementRejectsChangedIdentityRoleAndRequestedAction() {
        let frame = CGRect(x: 1200, y: 0, width: 24, height: 24)
        let original = candidate(label: "Original menu", frame: frame)
        for changed in [
            candidate(pid: 999, label: "Original menu", frame: frame),
            candidate(bundle: "other.app", label: "Original menu", frame: frame),
            candidate(label: "Original menu", role: kAXStaticTextRole as String, frame: frame),
            candidate(label: "Original menu", frame: frame, actions: [])
        ] {
            XCTAssertNil(uniqueLiveElementCandidate(original,
                preferredAction: kAXPressAction as String, in: [changed]))
        }
        let stable = candidate(label: "CPU 18%", identifier: "stable", frame: frame)
        XCTAssertNotNil(uniqueLiveElementCandidate(
            stable, preferredAction: kAXPressAction as String,
            in: [candidate(label: "CPU 76%", identifier: "stable", frame: frame)]
        ))
        XCTAssertNil(uniqueLiveElementCandidate(
            stable, preferredAction: kAXPressAction as String,
            in: [candidate(label: "CPU 18%", identifier: "replacement", frame: frame)]
        ))
    }

    func testFallbackNeverCrossesDisplaysIncludingNegativeCoordinates() {
        let monitors = [
            display,
            display.offsetBy(dx: -1440, dy: 0),
            display.offsetBy(dx: 1440, dy: 0),
            display.offsetBy(dx: 0, dy: -900)
        ]
        for requestedDisplay in monitors {
            let requested = CGRect(x: requestedDisplay.minX + 100,
                                   y: requestedDisplay.minY, width: 24, height: 24)
            for candidateDisplay in monitors {
                let target = CGRect(x: candidateDisplay.minX + 120,
                                    y: candidateDisplay.minY, width: 24, height: 24)
                XCTAssertEqual(activationFramesShareDisplay(
                    requested: requested, target: target, displays: monitors
                ), requestedDisplay == candidateDisplay)
            }
        }
    }

    func testDisconnectedAndInvalidDisplayTargetsFailClosed() {
        let local = CGRect(x: 1200, y: 0, width: 24, height: 24)
        let disconnected = local.offsetBy(dx: 1440, dy: 0)
        XCTAssertFalse(activationFramesShareDisplay(
            requested: disconnected, target: local, displays: [display]
        ))
        XCTAssertFalse(activationFramesShareDisplay(
            requested: local, target: disconnected, displays: [display]
        ))
        XCTAssertFalse(activationFramesShareDisplay(
            requested: local, target: local, displays: []
        ))
        for invalid in [CGRect.zero, CGRect.infinite, CGRect.null] {
            XCTAssertNil(activationTargetDisplay(for: invalid, in: [display]))
        }
    }

    func testActivationWindowConflictsAreRejectedOnEveryDisplayType() {
        let frame = CGRect(x: 1200, y: 0, width: 24, height: 24)
        let window = MenuWindow(id: 42, pid: 100, owner: "Host",
                                bounds: frame, isOnScreen: true)
        let icons = [candidate(pid: 101, frame: frame),
                     candidate(pid: 202, frame: frame)]
        for notch in [false, true] {
            for strict: [Int: MenuWindow] in [[:], [0: window]] {
                let matches = activationWindowMatches(
                    windows: [window], candidates: icons, targetDisplay: display,
                    displays: [display], strictMatches: strict,
                    hasTopSafeArea: { _ in notch }, hitWindow: { _, _ in 42 }
                )
                XCTAssertTrue(matches.isEmpty, "Conflicting target accepted, notch=\(notch)")
            }
        }
    }

    func testAmbiguousStrictMatchesAreFilteredEvenWithoutDiscoveryResults() {
        let frame = CGRect(x: 1200, y: 0, width: 24, height: 24)
        let duplicate = MenuWindow(id: 42, pid: 100, owner: "Host",
                                   bounds: frame, isOnScreen: true)
        let unique = MenuWindow(id: 43, pid: 100, owner: "Host",
                                bounds: frame.offsetBy(dx: 40, dy: 0), isOnScreen: true)
        let matches = activationWindowMatches(
            windows: [], candidates: [], targetDisplay: display, displays: [display],
            strictMatches: [0: duplicate, 1: duplicate, 2: unique],
            hasTopSafeArea: { _ in XCTFail("Empty input should not query the display"); return false },
            hitWindow: { _, _ in XCTFail("Empty input should not hit-test"); return nil }
        )
        XCTAssertEqual(matches.count, 1)
        XCTAssertEqual(matches[2]?.id, 43)
    }

    func testUniqueActivationWindowsRemainAvailableOnEveryDisplayType() {
        let frames = [CGRect(x: 1200, y: 0, width: 24, height: 24),
                      CGRect(x: 1240, y: 0, width: 24, height: 24)]
        let windows = frames.enumerated().map {
            MenuWindow(id: CGWindowID($0.offset + 42), pid: 100, owner: "Host",
                       bounds: $0.element, isOnScreen: true)
        }
        for notch in [false, true] {
            let matches = activationWindowMatches(
                windows: windows, candidates: frames.map { candidate(frame: $0) },
                targetDisplay: display, displays: [display], strictMatches: [:],
                hasTopSafeArea: { _ in notch },
                hitWindow: { point, _ in windows.first { $0.bounds.contains(point) }?.id }
            )
            XCTAssertEqual(matches[0]?.id, 42)
            XCTAssertEqual(matches[1]?.id, 43)
        }
    }

    func testHiddenNotchGeometryRequiresOneUniqueCandidate() {
        let frame = CGRect(x: 1200, y: 0, width: 24, height: 24)
        let window = MenuWindow(id: 42, pid: 100, owner: "Host",
                                bounds: frame, isOnScreen: false)
        for notch in [false, true] {
            for count in [1, 2] {
                let matches = activationWindowMatches(
                    windows: [window],
                    candidates: (0..<count).map { candidate(pid: pid_t(100 + $0), frame: frame) },
                    targetDisplay: display, displays: [display], strictMatches: [:],
                    hasTopSafeArea: { _ in notch }, hitWindow: { _, _ in nil }
                )
                XCTAssertEqual(matches.count, notch && count == 1 ? 1 : 0)
            }
        }
    }

    func testMenuClicksClearShortcutModifiersWithoutChangingTheirTarget() throws {
        for type in [CGEventType.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(CGEvent(
                mouseEventSource: nil,
                mouseType: type,
                mouseCursorPosition: CGPoint(x: 1200, y: 12),
                mouseButton: .left
            ))
            event.flags = [.maskCommand, .maskAlternate, .maskControl, .maskShift]
            event.setIntegerValueField(.eventTargetUnixProcessID, value: 123)
            event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: 456)
            event.setIntegerValueField(.mouseEventClickState, value: 2)
            configurePlainMenuClick(event)
            XCTAssertTrue(event.flags.isEmpty)
            XCTAssertEqual(event.type, type)
            XCTAssertEqual(event.location, CGPoint(x: 1200, y: 12))
            XCTAssertEqual(event.getIntegerValueField(.eventTargetUnixProcessID), 123)
            XCTAssertEqual(event.getIntegerValueField(.mouseEventWindowUnderMousePointer), 456)
            XCTAssertEqual(event.getIntegerValueField(.mouseEventClickState), 1)
        }
    }

    func testMissingPinnedApplicationLookupDoesNotInventState() throws {
        let identifier = "com.macnu.tests.definitely-not-installed"
        let json = "[\"\(identifier)\"]"
        let pointer = try XCTUnwrap(json.withCString { macnuCopyPinnedAppsJSON($0) })
        defer { free(pointer) }
        let data = try XCTUnwrap(String(cString: pointer).data(using: .utf8))
        let states = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: [String: Any]])
        XCTAssertEqual(states[identifier]?["installed"] as? Bool, false)
        XCTAssertEqual(states[identifier]?["running"] as? Bool, false)
        XCTAssertEqual(states[identifier]?["image"] as? String, "")
    }

    func testReopeningMissingApplicationReturnsRecoverableFailure() {
        let finished = expectation(description: "Missing app is rejected")
        DispatchQueue.global().async {
            let result = "com.macnu.tests.definitely-not-installed".withCString { macnuReopenPinnedApp($0) }
            XCTAssertEqual(result, 1)
            finished.fulfill()
        }
        wait(for: [finished], timeout: 20)
    }
    func testReopenIdentifiersRejectSystemAppsPathsAndCommands() {
        XCTAssertTrue(validReopenBundleIdentifier("com.example.Status-App"))
        for invalid in ["", "App", "com.apple.controlcenter", "/Applications/App.app",
                        "com.app;open", "com.app\n", "com.app/other"] {
            XCTAssertFalse(validReopenBundleIdentifier(invalid), invalid)
        }
    }
    private let element = AXUIElementCreateSystemWide()
    private let display = CGRect(x: 0, y: 0, width: 1440, height: 900)

    private func candidate(
        element: AXUIElement? = nil,
        pid: pid_t = 100,
        bundle: String = "example.status",
        label: String = "Status",
        identifier: String? = nil,
        role: String? = kAXMenuBarItemRole as String,
        frame: CGRect,
        actions: Set<String> = [kAXPressAction as String]
    ) -> AccessibilityCandidate {
        AccessibilityCandidate(
            element: element ?? self.element,
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
private func action(
        _ title: String,
        enabled: Bool = true,
        actionable: Bool = true,
        shortcut: String? = nil,
        children: [MenuActionSnapshot] = []
    ) -> MenuActionSnapshot {
        MenuActionSnapshot(
            title: title,
            enabled: enabled,
            actionable: actionable,
            shortcut: shortcut,
            children: children
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

    func testCachedWrapperRefreshUsesConsolidatedChildMetadata() {
        let wrapper = candidate(label: "Example",
            frame: CGRect(x: 1200, y: 0, width: 32, height: 24))
        let labelElement = AXUIElementCreateApplication(999)
        func status(_ label: String) -> AccessibilityCandidate {
            consolidatedStatusCandidates([
                wrapper,
                candidate(element: labelElement, label: label,
                    identifier: "connection-state", role: kAXStaticTextRole as String,
                    frame: CGRect(x: 1206, y: 4, width: 20, height: 16), actions: [])
            ])[0]
        }
        let original = status("Connected")
        let current = status("Synchronizing")
        let refreshed = uniqueLiveElementCandidate(original,
            preferredAction: kAXPressAction as String, in: [current])

        XCTAssertNil(wrapper.identifier)
        XCTAssertEqual(refreshed?.identifier, "connection-state")
        XCTAssertEqual(refreshed?.label, "Synchronizing")
        XCTAssertTrue(CFEqual(refreshed?.element, wrapper.element))
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
func testNestedMenuActionsKeepTheirFullPath() {
        let descriptors = menuActionDescriptors(from: [
            action(
                "Preferences",
                actionable: false,
                children: [
                    action("Appearance", actionable: false, children: [
                        action("Dark")
                    ])
                ]
            )
        ])

        XCTAssertEqual(descriptors.count, 1)
        XCTAssertEqual(
            descriptors[0].path,
            [
                MenuActionPathSegment(title: "Preferences", occurrence: 0),
                MenuActionPathSegment(title: "Appearance", occurrence: 0),
                MenuActionPathSegment(title: "Dark", occurrence: 0)
            ]
        )
    }

    func testDuplicateMenuTitlesReceiveStableOccurrences() {
        let descriptors = menuActionDescriptors(from: [
            action("Connect"),
            action("Connect"),
            action("Disconnect")
        ])

        XCTAssertEqual(descriptors.map(\.path.last?.occurrence), [0, 1, 0])
        XCTAssertEqual(Set(descriptors.map(\.id)).count, 3)
    }

    func testSubmenuParentsAreNotExposedAsRunnableActions() {
        let descriptors = menuActionDescriptors(from: [
            action(
                "Account",
                actionable: true,
                children: [action("Sign Out")]
            )
        ])

        XCTAssertEqual(descriptors.map(\.title), ["Sign Out"])
    }

    func testDisabledActionsRemainVisibleButDisabled() {
        let descriptors = menuActionDescriptors(from: [
            action("Install Update", enabled: false, shortcut: "⌘U")
        ])

        XCTAssertEqual(descriptors.count, 1)
        XCTAssertFalse(descriptors[0].enabled)
        XCTAssertEqual(descriptors[0].shortcut, "⌘U")
    }

    func testAmbiguousDuplicateActionPathsAreEntirelyOmitted() {
        let descriptor = menuActionDescriptors(from: [action("Open")])[0]

        XCTAssertTrue(
            unambiguousMenuActionDescriptors([
                descriptor,
                descriptor
            ]).isEmpty
        )
    }

    func testSingleUnidentifiedItemUsesItsLabelAndRoleIdentity() {
        let first = candidate(
            pid: 101,
            label: "CPU 18%",
            frame: CGRect(x: 1_200, y: 0, width: 52, height: 24)
        )
        let moved = candidate(
            pid: 909,
            label: "CPU 18%",
            frame: CGRect(x: 3_240, y: 0, width: 68, height: 24)
        )
        let relabeled = candidate(
            pid: 909,
            label: "CPU 76%",
            frame: CGRect(x: 3_240, y: 0, width: 68, height: 24)
        )

        let firstIdentity = stableMenuItemIdentities([first])[0]
        let movedIdentity = stableMenuItemIdentities([moved])[0]
        let relabeledIdentity = stableMenuItemIdentities([relabeled])[0]

        XCTAssertNotNil(firstIdentity)
        XCTAssertEqual(firstIdentity, movedIdentity)
        XCTAssertNotEqual(firstIdentity, relabeledIdentity)
        XCTAssertTrue(firstIdentity?.hasPrefix("v1.item-label-role.") == true)
        XCTAssertFalse(firstIdentity?.contains(".item-single.") ?? true)
    }

    func testUniqueAccessibilityIdentifierIgnoresLabelAndTopology() {
        let identified = candidate(
            pid: 100,
            label: "Connected",
            identifier: "primary-status-item",
            frame: CGRect(x: 1_200, y: 0, width: 24, height: 24)
        )
        let changed = candidate(
            pid: 800,
            label: "Disconnected",
            identifier: "primary-status-item",
            frame: CGRect(x: 3_220, y: 0, width: 40, height: 24)
        )
        let sibling = candidate(
            label: "Account",
            frame: CGRect(x: 1_240, y: 0, width: 24, height: 24)
        )

        let aloneIdentity = stableMenuItemIdentities([identified])[0]
        let identifiedAmongMany = stableMenuItemIdentities([
            identified,
            sibling
        ])[0]
        let changedAmongMany = stableMenuItemIdentities([
            changed,
            sibling
        ])[0]

        XCTAssertEqual(aloneIdentity, identifiedAmongMany)
        XCTAssertEqual(identifiedAmongMany, changedAmongMany)
        XCTAssertTrue(
            identifiedAmongMany?.hasPrefix("v1.item-identifier.") == true
        )
        XCTAssertEqual(
            identifiedAmongMany,
            [
                "v1",
                "item-identifier",
                "1aac1c7c667291710cb5e0350f8ab4d9e1cfb1554e08768d7b522ef6be4b6d43",
                "1782c8298b130d3980c676c7f8e60a36e913f13a54edbd4c1ecdbb9930efe387"
            ].joined(separator: ".")
        )
    }

    func testDuplicateAccessibilityIdentifiersFailClosed() {
        let identities = stableMenuItemIdentities([
            candidate(
                label: "Connected",
                identifier: "status-item",
                frame: CGRect(x: 1_200, y: 0, width: 24, height: 24)
            ),
            candidate(
                label: "Account",
                identifier: "status-item",
                frame: CGRect(x: 1_240, y: 0, width: 24, height: 24)
            )
        ])

        XCTAssertEqual(identities.count, 2)
        XCTAssertTrue(identities.allSatisfy { $0 == nil })
    }

    func testLabelRoleIdentityFailsClosedWhenTopologyBecomesAmbiguous() {
        let original = candidate(
            label: "Status",
            frame: CGRect(x: 1_200, y: 0, width: 24, height: 24)
        )
        let singleIdentity = stableMenuItemIdentities([original])[0]
        let identities = stableMenuItemIdentities([
            original,
            candidate(
                label: "Status",
                frame: CGRect(x: 1_240, y: 0, width: 24, height: 24)
            )
        ])

        XCTAssertNotNil(singleIdentity)
        XCTAssertEqual(identities.count, 2)
        XCTAssertTrue(identities.allSatisfy { $0 == nil })
    }

    func testLabelAndRoleComponentsAreSHA256HashedAndRemainDistinct() {
        let identities = stableMenuItemIdentities([
            candidate(
                label: "Secret account label",
                frame: CGRect(x: 1_200, y: 0, width: 24, height: 24)
            ),
            candidate(
                label: "Account",
                frame: CGRect(x: 1_240, y: 0, width: 24, height: 24)
            )
        ])

        XCTAssertNotNil(identities[0])
        XCTAssertNotNil(identities[1])
        XCTAssertNotEqual(identities[0], identities[1])
        XCTAssertTrue(
            identities.compactMap { $0 }.allSatisfy {
                $0.hasPrefix("v1.item-label-role.")
            }
        )
        guard let identity = identities[0] else {
            XCTFail("Expected a stable label/role identity.")
            return
        }
        XCTAssertFalse(identity.contains("example.status"))
        XCTAssertFalse(identity.contains("Secret account label"))
        XCTAssertFalse(identity.contains(kAXMenuBarItemRole as String))
        XCTAssertEqual(
            identity,
            [
                "v1",
                "item-label-role",
                "1aac1c7c667291710cb5e0350f8ab4d9e1cfb1554e08768d7b522ef6be4b6d43",
                "4e7a1e2fa5dd3a388a4e3c19d90922c4a2e3b13df015d9c84222e894ecb6d125",
                "1d9de1f46636b2201f7ed3ca44f42fb811fc5fc913ddf34bc9757886795ae3c4"
            ].joined(separator: ".")
        )
    }

    func testLabelRoleIdentityRequiresEverySemanticComponent() {
        let identities = stableMenuItemIdentities([
            candidate(
                bundle: " ",
                label: "Status",
                frame: CGRect(x: 1_200, y: 0, width: 24, height: 24)
            ),
            candidate(
                label: " ",
                frame: CGRect(x: 1_240, y: 0, width: 24, height: 24)
            ),
            candidate(
                label: "Status",
                role: nil,
                frame: CGRect(x: 1_280, y: 0, width: 24, height: 24)
            )
        ])

        XCTAssertTrue(identities.allSatisfy { $0 == nil })
    }

    func testDisplayKeyUsesNormalizedUUIDAndIgnoresBounds() {
        let uuid = "47596AD9-A811-4EBF-AC8A-03FC7B6D2A17"
        let first = stableDisplayKey(
            uuidString: uuid,
            bounds: CGRect(x: 0, y: 0, width: 1_440, height: 900)
        )
        let moved = stableDisplayKey(
            uuidString: uuid.lowercased(),
            bounds: CGRect(x: 1_440, y: 0, width: 1_920, height: 1_080)
        )

        XCTAssertEqual(first, moved)
        XCTAssertTrue(first.hasPrefix("v1.display-uuid."))
        XCTAssertEqual(
            first,
            "v1.display-uuid."
                + "8d3531667134ef6351fff2bb821aeeb00b6f2f0e4b072283de77d385246638b4"
        )
    }

    func testDisplayKeyHasDeterministicSafeBoundsFallback() {
        let bounds = CGRect(
            x: -1_920,
            y: 0,
            width: 1_920,
            height: 1_080
        )
        let missingUUID = stableDisplayKey(
            uuidString: nil,
            bounds: bounds
        )
        let invalidUUID = stableDisplayKey(
            uuidString: "not/a uuid+value",
            bounds: bounds
        )
        let otherBounds = stableDisplayKey(
            uuidString: nil,
            bounds: CGRect(x: 0, y: 0, width: 1_440, height: 900)
        )

        XCTAssertEqual(missingUUID, invalidUUID)
        XCTAssertNotEqual(missingUUID, otherBounds)
        XCTAssertTrue(missingUUID.hasPrefix("v1.display-bounds."))
        XCTAssertNil(
            missingUUID.range(
                of: "[^A-Za-z0-9._-]",
                options: .regularExpression
            )
        )
        let digestComponents = missingUUID.split(separator: ".").dropFirst(2)
        XCTAssertEqual(digestComponents.count, 4)
        XCTAssertTrue(digestComponents.allSatisfy { component in
            component.count == 64
                && String(component).range(
                    of: "[^0-9a-f]",
                    options: .regularExpression
                ) == nil
        })
        XCTAssertFalse(missingUUID.contains("-1920"))
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
