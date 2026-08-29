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
