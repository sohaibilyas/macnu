import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Security
import ServiceManagement

private struct MenuWindow {
    let id: CGWindowID
    let pid: pid_t
    let owner: String
    let bounds: CGRect
    let isOnScreen: Bool
}

private struct OnScreenWindow {
    let id: CGWindowID
    let pid: pid_t
    let bounds: CGRect
}

struct AccessibilityCandidate {
    let element: AXUIElement
    let pid: pid_t
    let appName: String
    let bundleIdentifier: String?
    let label: String
    let identifier: String?
    let role: String?
    let frame: CGRect
    let actions: Set<String>
}

private struct MenuIcon: Codable {
    let windowId: UInt32
    let owner: String
    let label: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let image: String
    let activationPid: Int32?
    let activationBundleId: String?
    let activationIdentifier: String?
    let activationX: Double?
    let activationY: Double?
    let activationWidth: Double?
    let activationHeight: Double?
    let activationAction: String?
}

private struct ActivationRequest: Codable {
    let windowId: UInt32
    let owner: String
    let label: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let activationPid: Int32?
    let activationBundleId: String?
    let activationIdentifier: String?
    let activationX: Double?
    let activationY: Double?
    let activationWidth: Double?
    let activationHeight: Double?
    let activationAction: String?
}

private struct ActivationSession {
    let menuWindowID: CGWindowID?
    let anchor: CGPoint
    let baselineWindowIDs: Set<CGWindowID>
    let accessibilityCandidate: AccessibilityCandidate?
    let accessibilityAction: String?
    let usesProcessTargetedClick: Bool
}

private struct AccessibilityActivationResult {
    let action: String?
    let usedProcessTargetedClick: Bool
}

private struct CachedIconImage {
    let pid: pid_t
    let x: CGFloat
    let y: CGFloat
    let width: Int
    let height: Int
    let identity: String
    let dataURL: String
    let capturedAt: TimeInterval
}

private struct CachedActivationTarget {
    let candidate: AccessibilityCandidate
    let menuWindow: MenuWindow?
    let capturedAt: TimeInterval
}

private let activationSessionLock = NSLock()
private var lastActivationSession: ActivationSession?
private let iconImageCacheLock = NSLock()
private var iconImageCache: [CGWindowID: CachedIconImage] = [:]
private let applicationIconCacheLock = NSLock()
private var applicationIconCache: [String: String] = [:]
private let activationTargetCacheLock = NSLock()
private var activationTargetCache: [String: CachedActivationTarget] = [:]
private let iconImageCacheLifetime: TimeInterval = 30
private let iconImageCacheRetention: TimeInterval = 120
private let activationTargetCacheRetention: TimeInterval = 120
private let catalogAXMessagingTimeout: Float = 0.35
private let activationAXMessagingTimeout: Float = 0.9
private let maximumAXNodesPerApplication = 256
private let maximumAXTraversalDepth = 8
private let accessibilityCatalogQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.name = "com.qoest.macnu.accessibility-catalog"
    queue.qualityOfService = .userInitiated
    queue.maxConcurrentOperationCount = 6
    return queue
}()
private let diagnosticsEnabled = ProcessInfo.processInfo.environment[
    "MACNU_DIAGNOSTICS"
] == "1" || ProcessInfo.processInfo.arguments.contains("--diagnostics")

// License credentials and the installation identifier are generic-password
// items in the encrypted, file-based login Keychain. Its application ACL is
// tied to Macnu's signing requirement. Nothing here is bridged to WebKit; Rust
// exposes only a redacted status. We intentionally do not opt into the Data
// Protection Keychain, which requires provisioning-profile access groups that
// a directly distributed Developer ID app does not have.
private let licensingKeychainService = "com.qoest.macnu.licensing.v1"
private let installationIdentifierAccount = "installation-id"
private let licenseRecordAccount = "license-record"
private let maximumLicenseRecordBytes = 64 * 1024
private let installationIdentifierLock = NSLock()

private func keychainQuery(account: String) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: licensingKeychainService,
        kSecAttrAccount as String: account
    ]
}

private func keychainData(account: String) -> Data? {
    var query = keychainQuery(account: account)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else {
        return nil
    }
    return item as? Data
}

private func keychainItemStatus(account: String) -> Int32 {
    var query = keychainQuery(account: account)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    let status = SecItemCopyMatching(query as CFDictionary, nil)
    if status == errSecSuccess { return 0 }
    if status == errSecItemNotFound { return 1 }
    return 2
}

@discardableResult
private func saveKeychainData(_ data: Data, account: String) -> Bool {
    let query = keychainQuery(account: account)
    let attributes: [String: Any] = [
        kSecValueData as String: data
    ]
    let updateStatus = SecItemUpdate(
        query as CFDictionary,
        attributes as CFDictionary
    )
    if updateStatus == errSecSuccess {
        return true
    }
    guard updateStatus == errSecItemNotFound else { return false }

    var newItem = query
    for (key, value) in attributes {
        newItem[key] = value
    }
    return SecItemAdd(newItem as CFDictionary, nil) == errSecSuccess
}

@discardableResult
private func deleteKeychainData(account: String) -> Bool {
    let status = SecItemDelete(keychainQuery(account: account) as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
}

func normalizedInstallationIdentifier(_ candidate: String?) -> String? {
    guard let candidate,
          let identifier = UUID(uuidString: candidate) else {
        return nil
    }
    return identifier.uuidString.lowercased()
}

private func installationIdentifier() -> String? {
    installationIdentifierLock.lock()
    defer { installationIdentifierLock.unlock() }

    if let data = keychainData(account: installationIdentifierAccount),
       let stored = String(data: data, encoding: .utf8),
       let identifier = normalizedInstallationIdentifier(stored) {
        return identifier
    }

    _ = deleteKeychainData(account: installationIdentifierAccount)
    let identifier = UUID().uuidString.lowercased()
    var newItem = keychainQuery(account: installationIdentifierAccount)
    newItem[kSecValueData as String] = Data(identifier.utf8)
    let status = SecItemAdd(newItem as CFDictionary, nil)
    guard status == errSecSuccess || status == errSecDuplicateItem else {
        return nil
    }
    // Re-read after insertion so concurrent callers converge on the same ID.
    guard let data = keychainData(account: installationIdentifierAccount),
          let stored = String(data: data, encoding: .utf8) else {
        return nil
    }
    return normalizedInstallationIdentifier(stored)
}

private struct CaptureResponse: Codable {
    let icons: [MenuIcon]
    let displayId: UInt32
    let screenCaptureDenied: Bool
    let accessibilityDenied: Bool
    let error: String?
}

private final class CaptureBox: @unchecked Sendable {
    var response: CaptureResponse?
}

private extension CGEventField {
    static let windowID = CGEventField(rawValue: 0x33)!
}

private func activeDisplayBounds() -> [CGRect] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
        return []
    }

    var displayIds = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &displayIds, &count) == .success else {
        return []
    }
    return displayIds.prefix(Int(count)).map(CGDisplayBounds)
}

private func containingDisplay(
    for frame: CGRect,
    in displays: [CGRect]
) -> CGRect? {
    let midpoint = CGPoint(x: frame.midX, y: frame.midY)
    if let containing = displays.first(where: { $0.contains(midpoint) }) {
        return containing
    }
    return displays.max {
        $0.intersection(frame).width * $0.intersection(frame).height
            < $1.intersection(frame).width * $1.intersection(frame).height
    }
}

private func activeDisplayIdUnderPointer() -> CGDirectDisplayID {
    guard let location = CGEvent(source: nil)?.location else {
        return CGMainDisplayID()
    }

    var displayId = CGMainDisplayID()
    var count: UInt32 = 0
    guard CGGetDisplaysWithPoint(
        location,
        1,
        &displayId,
        &count
    ) == .success, count > 0 else {
        return CGMainDisplayID()
    }
    return displayId
}

private func menuWindows(
    in displays: [CGRect] = activeDisplayBounds(),
    collapseCopies: Bool = true
) -> [MenuWindow] {
    // Menu extras obscured by the notch are not considered on-screen by
    // CoreGraphics, so the complete window list is required here.
    let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
    guard let info = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    let statusWindowLevel = Int(CGWindowLevelForKey(.statusWindow))

    let windows = info.compactMap { window -> MenuWindow? in
        guard
            let boundsDictionary = window[kCGWindowBounds as String] as? [String: Any],
            let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary),
            let layer = window[kCGWindowLayer as String] as? Int,
            let number = window[kCGWindowNumber as String] as? Int,
            let pid = window[kCGWindowOwnerPID as String] as? Int,
            let owner = window[kCGWindowOwnerName as String] as? String,
            layer == statusWindowLevel,
            displays.isEmpty || displays.contains(where: { display in
                abs(bounds.minY - display.minY) <= 4
                    && bounds.maxX > display.minX
                    && bounds.minX < display.maxX
                    && bounds.width < display.width
            }),
            bounds.height >= 8,
            bounds.height <= 64,
            bounds.width >= 1
        else {
            return nil
        }

        return MenuWindow(
            id: CGWindowID(number),
            pid: pid_t(pid),
            owner: owner,
            bounds: bounds,
            isOnScreen: window[kCGWindowIsOnscreen as String] as? Bool ?? false
        )
    }

    // Activation hit-testing needs every WindowServer ID because an item
    // obscured by the notch can have no copy marked on-screen. Image capture
    // callers use the default collapsed list to avoid duplicate thumbnails.
    let preferred = windows.sorted { left, right in
        if left.isOnScreen != right.isOnScreen {
            return left.isOnScreen
        }
        if left.bounds.minX == right.bounds.minX {
            return left.id < right.id
        }
        return left.bounds.minX < right.bounds.minX
    }

    guard collapseCopies else { return preferred }

    var seen: Set<String> = []
    return preferred.filter { window in
        let bounds = window.bounds
        let key = [
            String(window.pid),
            String(format: "%.1f", bounds.minX),
            String(format: "%.1f", bounds.minY),
            String(format: "%.1f", bounds.width),
            String(format: "%.1f", bounds.height)
        ].joined(separator: ":")
        return seen.insert(key).inserted
    }
    .sorted { left, right in
        if left.bounds.minX == right.bounds.minX {
            return left.id < right.id
        }
        return left.bounds.minX < right.bounds.minX
    }
}

private func menuSignature(for displayID: CGDirectDisplayID) -> UInt64 {
    let displays = activeDisplayBounds()
    let targetDisplay = CGDisplayBounds(displayID)
    let windows = menuWindows(in: displays).filter { window in
        containingDisplay(for: window.bounds, in: displays) == targetDisplay
    }

    var hash: UInt64 = 14_695_981_039_346_656_037
    func mix(_ value: UInt64) {
        hash ^= value
        hash &*= 1_099_511_628_211
    }

    mix(UInt64(displayID))
    for window in windows {
        mix(UInt64(window.id))
        mix(UInt64(bitPattern: Int64(window.pid)))
        mix(Double(window.bounds.minX).bitPattern)
        mix(Double(window.bounds.minY).bitPattern)
        mix(Double(window.bounds.width).bitPattern)
        mix(Double(window.bounds.height).bitPattern)
        for byte in window.owner.utf8 {
            mix(UInt64(byte))
        }
    }
    return hash
}

private func attribute(
    _ name: String,
    from element: AXUIElement
) -> CFTypeRef? {
    // Messaging timeouts are scoped to one AX object, not inherited by its
    // descendants. Apply the catalog budget to every object before querying.
    AXUIElementSetMessagingTimeout(element, catalogAXMessagingTimeout)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        element,
        name as CFString,
        &value
    ) == .success else {
        return nil
    }
    return value
}

private func frame(of element: AXUIElement) -> CGRect? {
    guard
        let positionValue = attribute(kAXPositionAttribute, from: element),
        let sizeValue = attribute(kAXSizeAttribute, from: element),
        CFGetTypeID(positionValue) == AXValueGetTypeID(),
        CFGetTypeID(sizeValue) == AXValueGetTypeID()
    else {
        return nil
    }

    var position = CGPoint.zero
    var size = CGSize.zero
    guard
        AXValueGetValue(positionValue as! AXValue, .cgPoint, &position),
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    else {
        return nil
    }
    return CGRect(origin: position, size: size)
}

private func actionNames(of element: AXUIElement) -> Set<String> {
    AXUIElementSetMessagingTimeout(element, catalogAXMessagingTimeout)
    var rawActions: CFArray?
    guard AXUIElementCopyActionNames(element, &rawActions) == .success,
          let actions = rawActions as? [String] else {
        return []
    }
    return Set(actions)
}

private func accessibilityText(
    from element: AXUIElement,
    fallback: String
) -> String {
    for name in [
        kAXDescriptionAttribute,
        kAXTitleAttribute,
        kAXHelpAttribute,
        kAXValueAttribute,
        kAXIdentifierAttribute
    ] {
        if let value = attribute(name, from: element) as? String {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            let parts = trimmed.split(separator: " ")
            let isDisplayContainerName = parts.count == 2
                && parts[0].caseInsensitiveCompare("Mac") == .orderedSame
                && Int(parts[1]) != nil
            if !trimmed.isEmpty && !isDisplayContainerName {
                return trimmed
            }
        }
    }
    return fallback
}

private func descendants(of root: AXUIElement) -> [AXUIElement] {
    // Custom AppKit, SwiftUI, Catalyst, and Electron items may add wrappers.
    // Breadth-first traversal with hard node/depth budgets supports those
    // shapes without walking an unbounded menu or popover tree.
    var queue: [(element: AXUIElement, depth: Int)] = [(root, 0)]
    var cursor = 0
    var result: [AXUIElement] = []

    while cursor < queue.count,
          result.count < maximumAXNodesPerApplication {
        let current = queue[cursor]
        cursor += 1
        guard current.depth < maximumAXTraversalDepth,
              let rawChildren = attribute(
                  kAXChildrenAttribute,
                  from: current.element
              ),
              CFGetTypeID(rawChildren) == CFArrayGetTypeID() else {
            continue
        }

        let children = (rawChildren as! [AnyObject]).compactMap {
            value -> AXUIElement? in
            let rawValue = value as CFTypeRef
            guard CFGetTypeID(rawValue) == AXUIElementGetTypeID() else {
                return nil
            }
            return unsafeBitCast(rawValue, to: AXUIElement.self)
        }
        for child in children where
            !result.contains(where: { CFEqual($0, child) }) {
            AXUIElementSetMessagingTimeout(child, catalogAXMessagingTimeout)
            result.append(child)
            if result.count >= maximumAXNodesPerApplication { break }
            queue.append((child, current.depth + 1))
        }
    }
    return result
}

private func samePhysicalStatusRegion(
    _ left: AccessibilityCandidate,
    _ right: AccessibilityCandidate
) -> Bool {
    guard left.pid == right.pid else { return false }
    let overlap = left.frame.intersection(right.frame)
    let smallerArea = min(
        left.frame.width * left.frame.height,
        right.frame.width * right.frame.height
    )
    guard smallerArea > 0 else { return false }
    let overlapRatio = (overlap.width * overlap.height) / smallerArea
    return overlapRatio >= 0.85
        && abs(left.frame.midX - right.frame.midX)
            <= max(2, min(left.frame.width, right.frame.width) * 0.35)
        && abs(left.frame.midY - right.frame.midY) <= 4
}

private func candidateActivationScore(
    _ candidate: AccessibilityCandidate
) -> Int {
    var score = 0
    if candidate.actions.contains(kAXShowMenuAction as String) { score += 400 }
    if candidate.actions.contains(kAXPressAction as String) { score += 300 }
    if candidate.actions.contains(kAXPickAction as String) { score += 200 }
    if candidate.role == kAXMenuBarItemRole as String { score += 80 }
    if candidate.role == kAXButtonRole as String { score += 60 }
    if candidate.identifier != nil { score += 20 }
    if candidate.label.caseInsensitiveCompare(candidate.appName) != .orderedSame {
        score += 10
    }
    return score
}

func consolidatedStatusCandidates(
    _ candidates: [AccessibilityCandidate]
) -> [AccessibilityCandidate] {
    var clusters: [[AccessibilityCandidate]] = []
    for candidate in candidates.sorted(by: {
        ($0.frame.width * $0.frame.height) > ($1.frame.width * $1.frame.height)
    }) {
        if let index = clusters.firstIndex(where: { cluster in
            cluster.contains(where: { samePhysicalStatusRegion($0, candidate) })
        }) {
            clusters[index].append(candidate)
        } else {
            clusters.append([candidate])
        }
    }

    return clusters.compactMap { cluster in
        guard let activation = cluster.max(by: {
            candidateActivationScore($0) < candidateActivationScore($1)
        }) else {
            return nil
        }
        let meaningfulLabels = cluster.filter {
            $0.label.caseInsensitiveCompare($0.appName) != .orderedSame
        }
        let labelSource = meaningfulLabels.min {
            ($0.frame.width * $0.frame.height) < ($1.frame.width * $1.frame.height)
        }
        let identifiers = cluster.compactMap(\.identifier)
        let identifier = activation.identifier
            ?? (Set(identifiers).count == 1 ? identifiers.first : nil)
        return AccessibilityCandidate(
            element: activation.element,
            pid: activation.pid,
            appName: activation.appName,
            bundleIdentifier: activation.bundleIdentifier,
            label: labelSource?.label ?? activation.label,
            identifier: identifier,
            role: activation.role,
            frame: activation.frame,
            actions: activation.actions
        )
    }
}

private struct AccessibilityApplicationSnapshot: Sendable {
    let index: Int
    let pid: pid_t
    let appName: String
    let bundleIdentifier: String?
}

private final class AccessibilityScanResults: @unchecked Sendable {
    private let lock = NSLock()
    private var candidatesByApplication: [[AccessibilityCandidate]?]

    init(applicationCount: Int) {
        candidatesByApplication = Array(
            repeating: nil,
            count: applicationCount
        )
    }

    func store(_ candidates: [AccessibilityCandidate], at index: Int) {
        lock.lock()
        candidatesByApplication[index] = candidates
        lock.unlock()
    }

    func flattened() -> [AccessibilityCandidate] {
        lock.lock()
        defer { lock.unlock() }
        return candidatesByApplication.flatMap { $0 ?? [] }
    }
}

private func accessibilityCandidates(
    for snapshot: AccessibilityApplicationSnapshot,
    displays: [CGRect]
) -> [AccessibilityCandidate] {
    let application = AXUIElementCreateApplication(snapshot.pid)
    AXUIElementSetMessagingTimeout(application, catalogAXMessagingTimeout)
    var applicationCandidates: [AccessibilityCandidate] = []

    if let extrasValue = attribute(
        kAXExtrasMenuBarAttribute,
        from: application
    ), CFGetTypeID(extrasValue) == AXUIElementGetTypeID() {
        let extras = unsafeBitCast(extrasValue, to: AXUIElement.self)
        AXUIElementSetMessagingTimeout(extras, catalogAXMessagingTimeout)
        for element in [extras] + descendants(of: extras) {
            guard
                let elementFrame = frame(of: element),
                elementFrame.width > 0,
                elementFrame.height > 0,
                elementFrame.height <= 72,
                displays.contains(where: { display in
                    abs(elementFrame.minY - display.minY) <= 6
                        && elementFrame.maxX > display.minX
                        && elementFrame.minX < display.maxX
                        && elementFrame.width < display.width
                })
            else {
                continue
            }

            // Multi-display accessibility trees expose display-level menu-bar
            // containers named "Mac 1", "Mac 2", and so on. Keep the varied
            // roles used by real status items, but never match the container.
            let role = attribute(kAXRoleAttribute, from: element) as? String
            if role == kAXMenuBarRole as String
                || role == kAXMenuRole as String {
                continue
            }

            let actions = actionNames(of: element)
            let hasSemanticAction = actions.contains(kAXPressAction as String)
                || actions.contains(kAXShowMenuAction as String)
                || actions.contains(kAXPickAction as String)
            let explicitLabel = accessibilityText(from: element, fallback: "")
            let rawIdentifier = attribute(
                kAXIdentifierAttribute,
                from: element
            ) as? String
            let identifier = rawIdentifier?.trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            applicationCandidates.append(AccessibilityCandidate(
                element: element,
                pid: snapshot.pid,
                appName: snapshot.appName,
                bundleIdentifier: snapshot.bundleIdentifier,
                label: explicitLabel.isEmpty
                    ? snapshot.appName
                    : explicitLabel,
                identifier: identifier?.isEmpty == false ? identifier : nil,
                role: role,
                frame: elementFrame,
                actions: hasSemanticAction ? actions : []
            ))
        }
    }
    return consolidatedStatusCandidates(applicationCandidates)
}

private func accessibilityCandidates() -> [AccessibilityCandidate] {
    guard AXIsProcessTrusted() else { return [] }

    // Snapshot AppKit metadata before leaving the caller thread. Only the AX
    // IPC work is parallelized; each process is scanned by exactly one worker.
    let applications = NSWorkspace.shared.runningApplications.enumerated().map {
        index, application in
        let bundleIdentifier = application.bundleIdentifier
        return AccessibilityApplicationSnapshot(
            index: index,
            pid: application.processIdentifier,
            appName: application.localizedName
                ?? bundleIdentifier
                ?? "Menu bar app",
            bundleIdentifier: bundleIdentifier
        )
    }
    guard !applications.isEmpty else { return [] }

    let displays = activeDisplayBounds()
    let results = AccessibilityScanResults(
        applicationCount: applications.count
    )

    let operations = applications.map { snapshot in
        BlockOperation {
            let candidates = autoreleasepool {
                accessibilityCandidates(for: snapshot, displays: displays)
            }
            results.store(candidates, at: snapshot.index)
        }
    }
    accessibilityCatalogQueue.addOperations(
        operations,
        waitUntilFinished: true
    )

    // Completion order is intentionally ignored. Preserve the original
    // NSWorkspace application order so concurrency cannot perturb the catalog.
    return results.flattened()
}

private func projectedFrame(
    for candidate: AccessibilityCandidate,
    onto targetDisplay: CGRect,
    displays: [CGRect]
) -> CGRect {
    guard let sourceDisplay = containingDisplay(
        for: candidate.frame,
        in: displays
    ) else {
        return candidate.frame
    }
    return CGRect(
        x: targetDisplay.maxX - (sourceDisplay.maxX - candidate.frame.minX),
        y: targetDisplay.minY + (candidate.frame.minY - sourceDisplay.minY),
        width: candidate.frame.width,
        height: candidate.frame.height
    )
}

func catalogCandidates(
    _ candidates: [AccessibilityCandidate],
    targetDisplay: CGRect,
    displays: [CGRect]
) -> [AccessibilityCandidate] {
    // A process may own several items with identical or dynamic labels. Treat
    // geometry/AX element identity as the item boundary and use labels only as
    // presentation. This preserves duplicates instead of collapsing them by
    // bundle + label.
    var groupedByProcess: [String: [AccessibilityCandidate]] = [:]
    for candidate in candidates {
        let source = candidate.bundleIdentifier ?? ""
        groupedByProcess["\(candidate.pid)|\(source)", default: []]
            .append(candidate)
    }

    return groupedByProcess.values.flatMap { processCandidates in
        let onTargetDisplay = processCandidates.filter {
            containingDisplay(for: $0.frame, in: displays) == targetDisplay
        }
        if !onTargetDisplay.isEmpty {
            return onTargetDisplay
        }

        // Some AX implementations expose status-item copies on only one
        // display. Preserve every item from one complete source display; the
        // caller will retain a projected row only if it can bind to one exact
        // WindowServer target on the requested display.
        let displayGroups = displays.map { display in
            processCandidates.filter {
                containingDisplay(for: $0.frame, in: displays) == display
            }
        }.filter { !$0.isEmpty }
        return displayGroups.max { left, right in
            if left.count == right.count {
                let leftX = left.map(\.frame.minX).min() ?? .greatestFiniteMagnitude
                let rightX = right.map(\.frame.minX).min() ?? .greatestFiniteMagnitude
                return leftX > rightX
            }
            return left.count < right.count
        } ?? []
    }
    .sorted {
        projectedFrame(for: $0, onto: targetDisplay, displays: displays).minX
            < projectedFrame(for: $1, onto: targetDisplay, displays: displays).minX
    }
}

private func accessibilityLineage(
    from element: AXUIElement,
    maximumDepth: Int = 4
) -> [AXUIElement] {
    var lineage = [element]
    var current = element
    for _ in 0..<maximumDepth {
        guard let rawParent = attribute(kAXParentAttribute, from: current),
              CFGetTypeID(rawParent) == AXUIElementGetTypeID() else {
            break
        }
        let parent = unsafeBitCast(rawParent, to: AXUIElement.self)
        lineage.append(parent)
        current = parent
    }
    return lineage
}

private func hitTestedCandidateIndex(
    for window: MenuWindow,
    candidates: [AccessibilityCandidate]
) -> Int? {
    let systemWide = AXUIElementCreateSystemWide()
    var hitElement: AXUIElement?
    guard AXUIElementCopyElementAtPosition(
        systemWide,
        Float(window.bounds.midX),
        Float(window.bounds.midY),
        &hitElement
    ) == .success, let hitElement else {
        return nil
    }

    let lineage = accessibilityLineage(from: hitElement)
    if let exact = candidates.indices.first(where: { index in
        lineage.contains { CFEqual($0, candidates[index].element) }
    }) {
        return exact
    }

    var hitPID: pid_t = 0
    guard AXUIElementGetPid(hitElement, &hitPID) == .success else {
        return nil
    }
    let sameProcess = candidates.indices.filter {
        candidates[$0].pid == hitPID
    }
    if sameProcess.count == 1 {
        return sameProcess[0]
    }

    let hitIdentifiers = Set(lineage.compactMap {
        (attribute(kAXIdentifierAttribute, from: $0) as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }.filter { !$0.isEmpty })
    let identifierMatches = sameProcess.filter { index in
        candidates[index].identifier.map(hitIdentifiers.contains) ?? false
    }
    if identifierMatches.count == 1 {
        return identifierMatches[0]
    }

    let hitLabels = Set(lineage.map {
        accessibilityText(from: $0, fallback: "").lowercased()
    }.filter { !$0.isEmpty })
    let labelMatches = sameProcess.filter {
        hitLabels.contains(candidates[$0].label.lowercased())
    }
    return labelMatches.count == 1 ? labelMatches[0] : nil
}

/// Converts direct target-display AX hit-test results into mutual one-to-one
/// candidate/window assignments. A target window is direct identity evidence:
/// its centre was hit-tested in the target display's real coordinate space.
/// Source-display AX geometry is deliberately not part of this decision,
/// because status-item copies may have different horizontal layouts on two
/// displays. Ambiguous duplicate claims are rejected instead of being paired by
/// label or order.
func uniqueDirectHitAssignments(
    _ candidateIndexByWindow: [Int?]
) -> [Int: Int] {
    var windowsByCandidate: [Int: [Int]] = [:]
    for (windowIndex, candidateIndex) in candidateIndexByWindow.enumerated() {
        guard let candidateIndex else { continue }
        windowsByCandidate[candidateIndex, default: []].append(windowIndex)
    }

    var assignments: [Int: Int] = [:]
    for (candidateIndex, windowIndices) in windowsByCandidate where
        windowIndices.count == 1 {
        assignments[candidateIndex] = windowIndices[0]
    }
    return assignments
}

private func framesStronglyAgree(
    window: MenuWindow,
    candidate: AccessibilityCandidate,
    targetDisplay: CGRect,
    displays: [CGRect]
) -> Bool {
    let candidateFrame = projectedFrame(
        for: candidate,
        onto: targetDisplay,
        displays: displays
    )
    let overlap = candidateFrame.intersection(window.bounds)
    let smallerArea = min(
        candidateFrame.width * candidateFrame.height,
        window.bounds.width * window.bounds.height
    )
    guard smallerArea > 0 else { return false }
    let overlapRatio = (overlap.width * overlap.height) / smallerArea
    let horizontalTolerance = max(
        2,
        min(candidateFrame.width, window.bounds.width) * 0.15
    )
    return overlapRatio >= 0.75
        && abs(candidateFrame.midX - window.bounds.midX) <= horizontalTolerance
        && abs(candidateFrame.midY - window.bounds.midY) <= 2
}

private func confidentWindowMatches(
    windows: [MenuWindow],
    candidates: [AccessibilityCandidate],
    targetDisplay: CGRect,
    displays: [CGRect]
) -> [Int: MenuWindow] {
    guard !windows.isEmpty, !candidates.isEmpty else { return [:] }

    // A captured image is attached only when public AX hit-testing resolves
    // the target-display WindowServer icon to one unique Accessibility item.
    // This direct target hit is stronger than projected source-display
    // geometry: menu-bar layouts legitimately differ across displays. Require
    // a mutual one-to-one claim so a process with several indistinguishable
    // items cannot be paired by iteration order.
    let hitCandidates = windows.map {
        hitTestedCandidateIndex(for: $0, candidates: candidates)
    }
    let assignments = uniqueDirectHitAssignments(hitCandidates)
    return Dictionary(uniqueKeysWithValues: assignments.map {
        ($0.key, windows[$0.value])
    })
}

private func appKitPoint(fromCoreGraphics point: CGPoint) -> NSPoint {
    // Quartz's global screen coordinates grow down from the main display's
    // top-left; AppKit's grow up from its bottom-left. X is shared, including
    // negative coordinates for displays arranged to the left of the main one.
    let mainDisplay = CGDisplayBounds(CGMainDisplayID())
    return NSPoint(x: point.x, y: mainDisplay.height - point.y)
}

private func displayHasTopSafeArea(_ targetDisplay: CGRect) -> Bool {
    let lookup = {
        NSScreen.screens.contains { screen in
            guard let number = screen.deviceDescription[
                NSDeviceDescriptionKey("NSScreenNumber")
            ] as? NSNumber else {
                return false
            }
            let bounds = CGDisplayBounds(CGDirectDisplayID(number.uint32Value))
            return bounds == targetDisplay && screen.safeAreaInsets.top > 0
        }
    }
    if Thread.isMainThread { return lookup() }
    return DispatchQueue.main.sync(execute: lookup)
}

private func firstHitWindow(
    atCoreGraphicsPoint point: CGPoint,
    eligibleWindowIDs: Set<CGWindowID>
) -> CGWindowID? {
    let lookup: () -> CGWindowID? = {
        var seen: Set<CGWindowID> = []
        var belowWindowNumber = 0
        let appKitPoint = appKitPoint(fromCoreGraphics: point)

        // Peel the public AppKit hit-test stack. This can reach a status-item
        // window underneath the notch or another menu-bar overlay without
        // moving the pointer or guessing from neighbouring item positions.
        for _ in 0..<24 {
            let number = NSWindow.windowNumber(
                at: appKitPoint,
                belowWindowWithWindowNumber: belowWindowNumber
            )
            guard number > 0 else { break }
            let id = CGWindowID(number)
            guard seen.insert(id).inserted else { break }
            if eligibleWindowIDs.contains(id) {
                return id
            }
            belowWindowNumber = number
        }
        return nil
    }

    if Thread.isMainThread {
        return lookup()
    }
    return DispatchQueue.main.sync { lookup() }
}

private func activationWindowMatches(
    windows: [MenuWindow],
    candidates: [AccessibilityCandidate],
    targetDisplay: CGRect,
    displays: [CGRect],
    strictMatches: [Int: MenuWindow]
) -> [Int: MenuWindow] {
    guard !windows.isEmpty, !candidates.isEmpty else { return strictMatches }
    let windowsByID = Dictionary(uniqueKeysWithValues: windows.map { ($0.id, $0) })
    let eligibleWindowIDs = Set(windowsByID.keys)
    var proposed = strictMatches

    for index in candidates.indices where proposed[index] == nil {
        let frame = projectedFrame(
            for: candidates[index],
            onto: targetDisplay,
            displays: displays
        )
        let inset = min(max(frame.width * 0.22, 2), max(frame.width / 2, 2))
        let points = [
            CGPoint(x: frame.midX, y: frame.midY),
            CGPoint(x: frame.minX + inset, y: frame.midY),
            CGPoint(x: frame.maxX - inset, y: frame.midY)
        ]
        var resolvedIDs: Set<CGWindowID> = []

        for point in points {
            if let id = firstHitWindow(
                atCoreGraphicsPoint: point,
                eligibleWindowIDs: eligibleWindowIDs
            ), let window = windowsByID[id],
               containingDisplay(for: window.bounds, in: displays) == targetDisplay,
               window.bounds.insetBy(dx: -1, dy: -1).contains(point) {
                resolvedIDs.insert(id)
            }
        }

        // Direct hit evidence must identify exactly one WindowServer window.
        // Conflicting sample points are ambiguity, not an invitation to guess.
        if resolvedIDs.count == 1,
           let id = resolvedIDs.first,
           let window = windowsByID[id] {
            proposed[index] = window
        }
    }

    // A physical notch makes the hidden WindowServer windows deliberately
    // non-hit-testable. Their geometry still remains available and, unlike an
    // order/count alignment, provides direct identity evidence: AX and the
    // status-level window share the same horizontal centre and overlap completely.
    // Accept this route only for a mutual one-to-one precise match.
    guard displayHasTopSafeArea(targetDisplay) else { return proposed }
    let claimedWindowIDs = Set(proposed.values.map(\.id))
    var seenGeometry: Set<String> = []
    let geometryWindows = windows.filter { window in
        guard !window.isOnScreen,
              !claimedWindowIDs.contains(window.id) else {
            return false
        }
        let bounds = window.bounds
        let key = [
            String(window.pid),
            String(format: "%.1f", bounds.minX),
            String(format: "%.1f", bounds.minY),
            String(format: "%.1f", bounds.width),
            String(format: "%.1f", bounds.height)
        ].joined(separator: ":")
        return seenGeometry.insert(key).inserted
    }
    let unresolved = candidates.indices.filter {
        proposed[$0] == nil
            && containingDisplay(for: candidates[$0].frame, in: displays)
                == targetDisplay
    }

    func isPreciseGeometryMatch(
        _ window: MenuWindow,
        _ candidate: AccessibilityCandidate
    ) -> Bool {
        let candidateFrame = projectedFrame(
            for: candidate,
            onto: targetDisplay,
            displays: displays
        )
        return framesStronglyAgree(
            window: window,
            candidate: candidate,
            targetDisplay: targetDisplay,
            displays: displays
        )
            && abs(candidateFrame.midX - window.bounds.midX) <= 1.5
            && abs(candidateFrame.midY - window.bounds.midY) <= 2
    }

    for index in unresolved {
        let matchingWindows = geometryWindows.filter {
            isPreciseGeometryMatch($0, candidates[index])
        }
        guard matchingWindows.count == 1,
              let window = matchingWindows.first else {
            continue
        }
        let matchingCandidates = unresolved.filter {
            isPreciseGeometryMatch(window, candidates[$0])
        }
        if matchingCandidates.count == 1 {
            proposed[index] = window
        }
    }

    // One WindowServer target may never be assigned to two AX identities.
    // Preserve safety even if two applications expose overlapping AX frames.
    let claims = Dictionary(grouping: proposed.keys) { proposed[$0]!.id }
    let ambiguousIDs = Set(claims.compactMap { id, indices in
        indices.count > 1 ? id : nil
    })
    return proposed.filter { !ambiguousIDs.contains($0.value.id) }
}

private func pngDataURL(from image: CGImage) -> String? {
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        return nil
    }
    return "data:image/png;base64,\(data.base64EncodedString())"
}

private func applicationIconDataURL(
    for candidate: AccessibilityCandidate
) -> String? {
    let key = candidate.bundleIdentifier ?? "pid:\(candidate.pid)"
    applicationIconCacheLock.lock()
    if let cached = applicationIconCache[key] {
        applicationIconCacheLock.unlock()
        return cached
    }
    applicationIconCacheLock.unlock()

    guard let icon = NSRunningApplication(
        processIdentifier: candidate.pid
    )?.icon else {
        return nil
    }
    var proposedRect = CGRect(x: 0, y: 0, width: 64, height: 64)
    guard let image = icon.cgImage(
        forProposedRect: &proposedRect,
        context: nil,
        hints: nil
    ), let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
       let context = CGContext(
           data: nil,
           width: 64,
           height: 64,
           bitsPerComponent: 8,
           bytesPerRow: 0,
           space: colorSpace,
           bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
       ) else {
        return nil
    }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: 64, height: 64))
    guard let resizedImage = context.makeImage(),
          let dataURL = pngDataURL(from: resizedImage) else {
        return nil
    }

    applicationIconCacheLock.lock()
    applicationIconCache[key] = dataURL
    applicationIconCacheLock.unlock()
    return dataURL
}

private func currentAppearanceIdentity() -> String {
    let resolve = {
        NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua])?.rawValue
            ?? NSAppearance.Name.aqua.rawValue
    }
    if Thread.isMainThread { return resolve() }
    return DispatchQueue.main.sync(execute: resolve)
}

private func neutralIconDataURL(appearance: String) -> String {
    let isDark = appearance == NSAppearance.Name.darkAqua.rawValue
    let fill = isDark ? "#20232b" : "#eef0f5"
    let stroke = isDark ? "#7f8799" : "#697185"
    let dot = isDark ? "#c7ccd8" : "#4d5568"
    let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect x="8" y="14" width="48" height="36" rx="12" fill="\(fill)" stroke="\(stroke)" stroke-width="3"/>
      <circle cx="22" cy="32" r="4" fill="\(dot)"/>
      <circle cx="32" cy="32" r="4" fill="\(dot)"/>
      <circle cx="42" cy="32" r="4" fill="\(dot)"/>
    </svg>
    """
    return "data:image/svg+xml;base64,\(Data(svg.utf8).base64EncodedString())"
}

private func reusableIconImages(
    for windows: [MenuWindow],
    matchedItems: [CGWindowID: AccessibilityCandidate],
    appearance: String,
    at timestamp: TimeInterval
) -> [CGWindowID: String] {
    iconImageCacheLock.lock()
    defer { iconImageCacheLock.unlock() }

    for windowID in Array(iconImageCache.keys) where
        timestamp - (iconImageCache[windowID]?.capturedAt ?? 0) > iconImageCacheRetention {
        iconImageCache.removeValue(forKey: windowID)
    }

    var reusable: [CGWindowID: String] = [:]
    for window in windows {
        let width = max(1, Int(window.bounds.width * 2))
        let height = max(1, Int(window.bounds.height * 2))
        let identity = iconCacheIdentity(
            for: window,
            candidate: matchedItems[window.id],
            appearance: appearance
        )
        guard let cached = iconImageCache[window.id],
              cached.pid == window.pid,
              cached.x == window.bounds.minX,
              cached.y == window.bounds.minY,
              cached.width == width,
              cached.height == height,
              cached.identity == identity,
              timestamp - cached.capturedAt < iconImageCacheLifetime else {
            continue
        }
        reusable[window.id] = cached.dataURL
    }
    return reusable
}

private func cacheIconImage(
    _ dataURL: String,
    for window: MenuWindow,
    identity: String,
    width: Int,
    height: Int,
    at timestamp: TimeInterval
) {
    iconImageCacheLock.lock()
    iconImageCache[window.id] = CachedIconImage(
        pid: window.pid,
        x: window.bounds.minX,
        y: window.bounds.minY,
        width: width,
        height: height,
        identity: identity,
        dataURL: dataURL,
        capturedAt: timestamp
    )
    iconImageCacheLock.unlock()
}

private func iconCacheIdentity(
    for window: MenuWindow,
    candidate: AccessibilityCandidate?,
    appearance: String
) -> String {
    guard let candidate else {
        return "\(appearance)|\(window.pid)|\(window.owner.lowercased())|unmatched"
    }
    return [
        appearance,
        String(candidate.pid),
        candidate.bundleIdentifier ?? "",
        candidate.identifier ?? "",
        String(activationCoordinate(candidate.frame.minX)),
        String(activationCoordinate(candidate.frame.width)),
        candidate.appName.lowercased(),
    ].joined(separator: "|")
}

private func onScreenWindows() -> [OnScreenWindow] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let statusWindowLevel = Int(CGWindowLevelForKey(.statusWindow))
    guard let info = CGWindowListCopyWindowInfo(
        options,
        kCGNullWindowID
    ) as? [[String: Any]] else {
        return []
    }

    return info.compactMap { window in
        guard
            let number = window[kCGWindowNumber as String] as? Int,
            let pid = window[kCGWindowOwnerPID as String] as? Int,
            let layer = window[kCGWindowLayer as String] as? Int,
            let boundsDictionary = window[kCGWindowBounds as String] as? [String: Any],
            let bounds = CGRect(
                dictionaryRepresentation: boundsDictionary as CFDictionary
            ),
            layer != statusWindowLevel,
            bounds.width >= 32,
            bounds.height >= 24
        else {
            return nil
        }
        return OnScreenWindow(
            id: CGWindowID(number),
            pid: pid_t(pid),
            bounds: bounds
        )
    }
}

private func waitForOpenedPopup(
    since baselineWindowIDs: Set<CGWindowID>,
    targetPID: pid_t,
    anchor: CGPoint
) -> Bool {
    // AX actions sometimes report success without opening the status menu.
    // Keep this bounded: the action itself is delivered immediately, and the
    // short wait exists only to decide whether an alternate AX action is needed.
    for _ in 0..<8 {
        Thread.sleep(forTimeInterval: 0.02)
        let newWindows = onScreenWindows().filter {
            !baselineWindowIDs.contains($0.id)
        }
        if newWindows.contains(where: { window in
            if window.pid == targetPID { return true }
            let horizontalDistance = max(
                0,
                max(window.bounds.minX - anchor.x, anchor.x - window.bounds.maxX)
            )
            return horizontalDistance <= 48
                && window.bounds.minY <= anchor.y + 100
        }) {
            return true
        }
    }
    return false
}

private func anchoredPopupWindows(for session: ActivationSession) -> [OnScreenWindow] {
    onScreenWindows().filter { window in
        guard !session.baselineWindowIDs.contains(window.id) else {
            return false
        }
        let horizontalDistance = max(
            0,
            max(
                window.bounds.minX - session.anchor.x,
                session.anchor.x - window.bounds.maxX
            )
        )
        return horizontalDistance <= 48
            && window.bounds.minY <= session.anchor.y + 100
    }
}

private func rememberActivation(
    menuWindow: MenuWindow?,
    candidate: AccessibilityCandidate?,
    action: String?,
    baselineWindowIDs: Set<CGWindowID>,
    usesProcessTargetedClick: Bool = false
) {
    guard let anchor = menuWindow.map({
        CGPoint(x: $0.bounds.midX, y: $0.bounds.midY)
    }) ?? candidate.map({
        CGPoint(x: $0.frame.midX, y: $0.frame.midY)
    }) else {
        return
    }
    let session = ActivationSession(
        menuWindowID: menuWindow?.id,
        anchor: anchor,
        baselineWindowIDs: baselineWindowIDs,
        accessibilityCandidate: candidate,
        accessibilityAction: action,
        usesProcessTargetedClick: usesProcessTargetedClick
    )
    activationSessionLock.lock()
    lastActivationSession = session
    activationSessionLock.unlock()
}

private func takeLastActivation() -> ActivationSession? {
    activationSessionLock.lock()
    defer { activationSessionLock.unlock() }
    let session = lastActivationSession
    lastActivationSession = nil
    return session
}

private func dismissLastActivatedPopup() {
    guard let session = takeLastActivation() else {
        NSApp.activate()
        return
    }

    // Toggle the exact status item that Macnu opened. Dismissal never sends
    // a synthetic keyboard event, so macOS cannot beep and Macnu cannot
    // receive a delayed Escape. This path deliberately performs no popup-open
    // wait because disappearance, not appearance, is the expected result.
    if !anchoredPopupWindows(for: session).isEmpty {
        let displays = activeDisplayBounds()
        if let menuWindowID = session.menuWindowID,
           let menuWindow = menuWindows(in: displays).first(where: {
               $0.id == menuWindowID
           }) {
            _ = postMenuWindowClick(menuWindow)
            Thread.sleep(forTimeInterval: 0.045)
        } else if let cachedCandidate = session.accessibilityCandidate,
                  let currentFrame = frame(of: cachedCandidate.element) {
            let candidate = AccessibilityCandidate(
                element: cachedCandidate.element,
                pid: cachedCandidate.pid,
                appName: cachedCandidate.appName,
                bundleIdentifier: cachedCandidate.bundleIdentifier,
                label: accessibilityText(
                    from: cachedCandidate.element,
                    fallback: cachedCandidate.label
                ),
                identifier: cachedCandidate.identifier,
                role: cachedCandidate.role,
                frame: currentFrame,
                actions: actionNames(of: cachedCandidate.element)
            )
            if session.usesProcessTargetedClick {
                _ = postProcessTargetedClick(candidate)
            } else {
                let action = session.accessibilityAction
                    ?? (candidate.actions.contains(kAXShowMenuAction as String)
                        ? kAXShowMenuAction as String
                        : kAXPressAction as String)
                _ = AXUIElementPerformAction(candidate.element, action as CFString)
            }
            Thread.sleep(forTimeInterval: 0.045)
        }
    }

    // Activation is deliberately last. Rust shows and focuses the palette
    // only after this synchronous dismissal sequence has fully completed.
    NSApp.activate()
    Thread.sleep(forTimeInterval: 0.015)
}

private func resolvedAccessibilityCandidate(
    pid: pid_t,
    bundleIdentifier: String?,
    identifier: String?,
    label: String,
    frame: CGRect?,
    preferredAction: String?,
    in candidates: [AccessibilityCandidate]
) -> AccessibilityCandidate? {
    let matchingProcess = candidates.filter { candidate in
        guard candidate.pid == pid else { return false }
        if let bundleIdentifier,
           candidate.bundleIdentifier != bundleIdentifier {
            return false
        }
        if let action = preferredAction {
            return candidate.actions.contains(action)
        }
        return true
    }
    guard !matchingProcess.isEmpty else { return nil }

    func frameDistance(_ candidate: AccessibilityCandidate) -> CGFloat {
        guard let frame else { return .greatestFiniteMagnitude }
        return max(
            abs(candidate.frame.midX - frame.midX),
            abs(candidate.frame.midY - frame.midY),
            abs(candidate.frame.width - frame.width),
            abs(candidate.frame.height - frame.height)
        )
    }

    if let identifier {
        let identifierMatches = matchingProcess.filter {
            $0.identifier == identifier
        }
        if frame != nil {
            let nearby = identifierMatches.filter { frameDistance($0) <= 6 }
            return nearby.count == 1 ? nearby[0] : nil
        }
        return identifierMatches.count == 1 ? identifierMatches[0] : nil
    }

    if frame != nil {
        let exactFrameMatches = matchingProcess.filter {
            frameDistance($0) <= 2
        }
        if exactFrameMatches.count == 1 {
            return exactFrameMatches[0]
        }
        let namedNearby = matchingProcess.filter {
            frameDistance($0) <= 8
                && $0.label.caseInsensitiveCompare(label) == .orderedSame
        }
        return namedNearby.count == 1 ? namedNearby[0] : nil
    }

    let labelMatches = matchingProcess.filter {
        $0.label.caseInsensitiveCompare(label) == .orderedSame
    }
    return labelMatches.count == 1 ? labelMatches[0] : nil
}

private func activationCoordinate(_ value: CGFloat) -> Int64 {
    Int64((Double(value) * 100).rounded())
}

private func activationCacheKey(
    windowID: CGWindowID,
    displayFrame: CGRect,
    activationPID: pid_t,
    bundleIdentifier: String?,
    identifier: String?,
    label: String,
    activationFrame: CGRect,
    action: String?
) -> String {
    let text = [bundleIdentifier ?? "", identifier ?? "", label, action ?? ""].map {
        "\($0.utf8.count):\($0)"
    }
    let numbers: [Int64] = [
        Int64(windowID),
        Int64(activationPID),
        activationCoordinate(displayFrame.minX),
        activationCoordinate(displayFrame.minY),
        activationCoordinate(displayFrame.width),
        activationCoordinate(displayFrame.height),
        activationCoordinate(activationFrame.minX),
        activationCoordinate(activationFrame.minY),
        activationCoordinate(activationFrame.width),
        activationCoordinate(activationFrame.height),
    ]
    return numbers.map(String.init).joined(separator: ",")
        + "|" + text.joined(separator: "|")
}

private func activationCacheKey(for request: ActivationRequest) -> String? {
    guard
        let activationPID = request.activationPid,
        let activationX = request.activationX,
        let activationY = request.activationY,
        let activationWidth = request.activationWidth,
        let activationHeight = request.activationHeight
    else {
        return nil
    }
    return activationCacheKey(
        windowID: CGWindowID(request.windowId),
        displayFrame: CGRect(
            x: request.x,
            y: request.y,
            width: request.width,
            height: request.height
        ),
        activationPID: pid_t(activationPID),
        bundleIdentifier: request.activationBundleId,
        identifier: request.activationIdentifier,
        label: request.label,
        activationFrame: CGRect(
            x: activationX,
            y: activationY,
            width: activationWidth,
            height: activationHeight
        ),
        action: request.activationAction
    )
}

private func storeActivationTargets(
    _ targets: [String: CachedActivationTarget],
    at timestamp: TimeInterval
) {
    activationTargetCacheLock.lock()
    for key in Array(activationTargetCache.keys) where
        timestamp - (activationTargetCache[key]?.capturedAt ?? 0)
            > activationTargetCacheRetention {
        activationTargetCache.removeValue(forKey: key)
    }
    activationTargetCache.merge(targets) { _, current in current }
    activationTargetCacheLock.unlock()
}

private func cachedActivationTarget(
    for request: ActivationRequest
) -> CachedActivationTarget? {
    guard let key = activationCacheKey(for: request) else { return nil }
    activationTargetCacheLock.lock()
    defer { activationTargetCacheLock.unlock() }
    guard let target = activationTargetCache[key],
          ProcessInfo.processInfo.systemUptime - target.capturedAt
            <= activationTargetCacheRetention else {
        activationTargetCache.removeValue(forKey: key)
        return nil
    }
    return target
}

private func liveCachedCandidate(
    _ cached: AccessibilityCandidate,
    for request: ActivationRequest
) -> AccessibilityCandidate? {
    guard let activationPID = request.activationPid else { return nil }
    var elementPID: pid_t = 0
    guard AXUIElementGetPid(cached.element, &elementPID) == .success,
          elementPID == pid_t(activationPID),
          let currentFrame = frame(of: cached.element) else {
        return nil
    }
    let currentIdentifier = (
        attribute(kAXIdentifierAttribute, from: cached.element) as? String
    )?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let identifier = cached.identifier,
       currentIdentifier != identifier {
        return nil
    }
    let currentActions = actionNames(of: cached.element)
    if let requestedAction = request.activationAction,
       !currentActions.contains(requestedAction) {
        return nil
    }
    return AccessibilityCandidate(
        element: cached.element,
        pid: cached.pid,
        appName: cached.appName,
        bundleIdentifier: cached.bundleIdentifier,
        label: accessibilityText(from: cached.element, fallback: cached.label),
        identifier: currentIdentifier?.isEmpty == false
            ? currentIdentifier
            : cached.identifier,
        role: cached.role,
        frame: currentFrame,
        actions: currentActions
    )
}

private func unchangedCachedMenuWindow(
    _ cachedWindow: MenuWindow?,
    cachedCandidate: AccessibilityCandidate,
    liveCandidate: AccessibilityCandidate,
    displays: [CGRect]
) -> MenuWindow? {
    guard let cachedWindow,
          abs(cachedCandidate.frame.minX - liveCandidate.frame.minX) <= 1,
          abs(cachedCandidate.frame.minY - liveCandidate.frame.minY) <= 1,
          abs(cachedCandidate.frame.width - liveCandidate.frame.width) <= 1,
          abs(cachedCandidate.frame.height - liveCandidate.frame.height) <= 1,
          let current = menuWindows(in: displays).first(where: {
              $0.id == cachedWindow.id && $0.pid == cachedWindow.pid
          }),
          abs(current.bounds.minX - cachedWindow.bounds.minX) <= 1,
          abs(current.bounds.minY - cachedWindow.bounds.minY) <= 1,
          abs(current.bounds.width - cachedWindow.bounds.width) <= 1,
          abs(current.bounds.height - cachedWindow.bounds.height) <= 1 else {
        return nil
    }
    return current
}

private func postProcessTargetedClick(
    _ candidate: AccessibilityCandidate
) -> Bool {
    let point = CGPoint(x: candidate.frame.midX, y: candidate.frame.midY)
    guard
        let source = CGEventSource(stateID: .hidSystemState),
        let mouseDown = CGEvent(
            mouseEventSource: source,
            mouseType: .leftMouseDown,
            mouseCursorPosition: point,
            mouseButton: .left
        ),
        let mouseUp = CGEvent(
            mouseEventSource: source,
            mouseType: .leftMouseUp,
            mouseCursorPosition: point,
            mouseButton: .left
        )
    else {
        return false
    }

    for event in [mouseDown, mouseUp] {
        event.setIntegerValueField(
            .eventTargetUnixProcessID,
            value: Int64(candidate.pid)
        )
        event.setIntegerValueField(.mouseEventClickState, value: 1)
    }
    mouseDown.postToPid(candidate.pid)
    Thread.sleep(forTimeInterval: 0.035)
    mouseUp.postToPid(candidate.pid)
    return true
}

private func performAccessibilityAction(
    on candidate: AccessibilityCandidate,
    preferredAction: String?,
    baselineWindowIDs: Set<CGWindowID>
) -> AccessibilityActivationResult? {
    AXUIElementSetMessagingTimeout(
        candidate.element,
        activationAXMessagingTimeout
    )
    let preferred = preferredAction.map { [$0] } ?? []
    let actions = preferred + [
        kAXShowMenuAction as String,
        kAXPressAction as String,
        kAXPickAction as String
    ]
    var attempted = Set<String>()
    for action in actions where !attempted.contains(action) {
        attempted.insert(action)
        guard candidate.actions.contains(action) else { continue }
        let result = AXUIElementPerformAction(
            candidate.element,
            action as CFString
        )
        if result == .success || result == .cannotComplete {
            _ = waitForOpenedPopup(
                since: baselineWindowIDs,
                targetPID: candidate.pid,
                anchor: CGPoint(x: candidate.frame.midX, y: candidate.frame.midY)
            )
            // AXPress may intentionally execute a direct command and
            // AXCannotComplete can mean the target handled the request before
            // replying. Never follow a delivered semantic action with another
            // click that could toggle it closed or execute it twice.
            return AccessibilityActivationResult(
                action: action,
                usedProcessTargetedClick: false
            )
        }
    }
    if postProcessTargetedClick(candidate) {
        _ = waitForOpenedPopup(
            since: baselineWindowIDs,
            targetPID: candidate.pid,
            anchor: CGPoint(x: candidate.frame.midX, y: candidate.frame.midY)
        )
        return AccessibilityActivationResult(
            action: nil,
            usedProcessTargetedClick: true
        )
    }
    return nil
}

private func cachedActivationCandidate(
    for request: ActivationRequest,
    in candidates: [AccessibilityCandidate]
) -> AccessibilityCandidate? {
    guard let activationPid = request.activationPid else { return nil }
    let cachedFrame: CGRect?
    if let x = request.activationX,
       let y = request.activationY,
       let width = request.activationWidth,
       let height = request.activationHeight {
        cachedFrame = CGRect(x: x, y: y, width: width, height: height)
    } else {
        cachedFrame = nil
    }
    return resolvedAccessibilityCandidate(
        pid: activationPid,
        bundleIdentifier: request.activationBundleId,
        identifier: request.activationIdentifier,
        label: request.label,
        frame: cachedFrame,
        preferredAction: request.activationAction,
        in: candidates
    )
}

private func confidentMenuWindow(
    for request: ActivationRequest,
    candidate: AccessibilityCandidate,
    allCandidates: [AccessibilityCandidate],
    displays: [CGRect]
) -> MenuWindow? {
    let requestedFrame = CGRect(
        x: request.x,
        y: request.y,
        width: request.width,
        height: request.height
    )
    guard let targetDisplay = containingDisplay(
        for: requestedFrame,
        in: displays
    ) else {
        return nil
    }
    let windows = menuWindows(in: displays, collapseCopies: false).filter {
        containingDisplay(for: $0.bounds, in: displays) == targetDisplay
    }
    let catalog = catalogCandidates(
        allCandidates,
        targetDisplay: targetDisplay,
        displays: displays
    )
    guard let index = catalog.firstIndex(where: { item in
        guard item.pid == candidate.pid else { return false }
        if let identifier = candidate.identifier {
            return item.identifier == identifier
        }
        return item.label.caseInsensitiveCompare(candidate.label) == .orderedSame
    }) else {
        return nil
    }
    let strictMatches = confidentWindowMatches(
        windows: windows,
        candidates: catalog,
        targetDisplay: targetDisplay,
        displays: displays
    )
    return activationWindowMatches(
        windows: windows,
        candidates: catalog,
        targetDisplay: targetDisplay,
        displays: displays,
        strictMatches: strictMatches
    )[index]
}

private func postMenuWindowClick(_ menuWindow: MenuWindow) -> Bool {
    let point = CGPoint(x: menuWindow.bounds.midX, y: menuWindow.bounds.midY)
    guard
        let source = CGEventSource(stateID: .hidSystemState),
        let mouseDown = CGEvent(
            mouseEventSource: source,
            mouseType: .leftMouseDown,
            mouseCursorPosition: point,
            mouseButton: .left
        ),
        let mouseUp = CGEvent(
            mouseEventSource: source,
            mouseType: .leftMouseUp,
            mouseCursorPosition: point,
            mouseButton: .left
        )
    else {
        return false
    }

    // macOS 26 reparents menu-bar windows under Control Center. Route every
    // item through the same WindowServer path using the current status-level
    // window ID and host PID. The icon's app name never affects activation.
    let hostPID = Int64(menuWindow.pid)
    let hostWindow = Int64(menuWindow.id)
    for event in [mouseDown, mouseUp] {
        let userData = Int64(
            truncatingIfNeeded: Int(bitPattern: ObjectIdentifier(event))
        )
        event.setIntegerValueField(.eventTargetUnixProcessID, value: hostPID)
        event.setIntegerValueField(.eventSourceUserData, value: userData)
        event.setIntegerValueField(.mouseEventClickState, value: 1)
        event.setIntegerValueField(
            .mouseEventWindowUnderMousePointer,
            value: hostWindow
        )
        event.setIntegerValueField(
            .mouseEventWindowUnderMousePointerThatCanHandleThisEvent,
            value: hostWindow
        )
        event.setIntegerValueField(.windowID, value: hostWindow)
    }

    if let sessionSource = CGEventSource(stateID: .combinedSessionState) {
        let permitted: CGEventFilterMask = [
            .permitLocalMouseEvents,
            .permitLocalKeyboardEvents,
            .permitSystemDefinedEvents
        ]
        sessionSource.setLocalEventsFilterDuringSuppressionState(
            permitted,
            state: .eventSuppressionStateRemoteMouseDrag
        )
        sessionSource.setLocalEventsFilterDuringSuppressionState(
            permitted,
            state: .eventSuppressionStateSuppressionInterval
        )
        sessionSource.localEventsSuppressionInterval = 0
    }

    mouseDown.post(tap: .cgSessionEventTap)
    Thread.sleep(forTimeInterval: 0.035)
    mouseUp.post(tap: .cgSessionEventTap)
    return true
}

private func captureMenuIcons() async -> CaptureResponse {
    let displays = activeDisplayBounds()
    let targetDisplayId = activeDisplayIdUnderPointer()
    let targetDisplay = CGDisplayBounds(targetDisplayId)
    let allWindows = menuWindows(in: displays, collapseCopies: false).filter { window in
        return containingDisplay(for: window.bounds, in: displays) == targetDisplay
    }
    let windows = menuWindows(in: displays).filter { window in
        return containingDisplay(for: window.bounds, in: displays) == targetDisplay
    }
    let accessibilityDenied = !AXIsProcessTrusted()
    let screenCaptureDenied = !CGPreflightScreenCaptureAccess()

    do {
        let captureTimestamp = ProcessInfo.processInfo.systemUptime
        let appearance = currentAppearanceIdentity()
        let allAccessibilityCandidates = accessibilityCandidates()
        let catalog = catalogCandidates(
            allAccessibilityCandidates,
            targetDisplay: targetDisplay,
            displays: displays
        )
        let confidentMatches = confidentWindowMatches(
            windows: windows,
            candidates: catalog,
            targetDisplay: targetDisplay,
            displays: displays
        )
        let activationMatches = activationWindowMatches(
            windows: allWindows,
            candidates: catalog,
            targetDisplay: targetDisplay,
            displays: displays,
            strictMatches: confidentMatches
        )
        let catalogIndices = catalog.indices.filter { index in
            let candidate = catalog[index]
            let isTargetLocal = containingDisplay(
                for: candidate.frame,
                in: displays
            ) == targetDisplay
            let hasSemanticAction = candidate.actions.contains(
                kAXShowMenuAction as String
            ) || candidate.actions.contains(
                kAXPressAction as String
            ) || candidate.actions.contains(
                kAXPickAction as String
            )
            // A projected source-display AX element must never be activated on
            // its original monitor while the row claims to target this one.
            // Keep it only when one exact target-display WindowServer window
            // provides the activation route. Actionless custom views follow
            // the same rule on every display.
            return activationMatches[index] != nil
                || (isTargetLocal && hasSemanticAction)
        }
        if diagnosticsEnabled {
            var diagnosticLines = [[
                "display=\(targetDisplayId)",
                "target=\(NSStringFromRect(targetDisplay))",
                "allAX=\(allAccessibilityCandidates.count)",
                "catalog=\(catalog.count)",
                "windows=\(windows.count)",
                "allWindows=\(allWindows.count)",
                "strict=\(confidentMatches.count)",
                "activation=\(activationMatches.count)",
                "kept=\(catalogIndices.count)"
            ].joined(separator: " ")]
            for (windowIndex, window) in allWindows.enumerated() {
                let hit = hitTestedCandidateIndex(
                    for: window,
                    candidates: catalog
                )
                diagnosticLines.append([
                    "WINDOW[\(windowIndex)]",
                    "id=\(window.id)",
                    "pid=\(window.pid)",
                    "owner=\(window.owner)",
                    "onscreen=\(window.isOnScreen)",
                    "frame=\(NSStringFromRect(window.bounds))",
                    "hit=\(hit.map(String.init) ?? "nil")"
                ].joined(separator: " | "))
            }
            for index in catalog.indices {
                let candidate = catalog[index]
                let local = containingDisplay(
                    for: candidate.frame,
                    in: displays
                ) == targetDisplay
                diagnosticLines.append([
                    "AX[\(index)]",
                    candidate.appName,
                    candidate.label,
                    "pid=\(candidate.pid)",
                    "bundle=\(candidate.bundleIdentifier ?? "nil")",
                    "identifier=\(candidate.identifier ?? "nil")",
                    "local=\(local)",
                    "frame=\(NSStringFromRect(candidate.frame))",
                    "actions=\(candidate.actions.sorted().joined(separator: ","))",
                    "strict=\(confidentMatches[index]?.id ?? 0)",
                    "activation=\(activationMatches[index]?.id ?? 0)",
                    "kept=\(catalogIndices.contains(index))"
                ].joined(separator: " | "))
            }
            try? diagnosticLines.joined(separator: "\n").write(
                toFile: "/tmp/macnu-catalog.log",
                atomically: true,
                encoding: .utf8
            )
            NSLog("[Macnu catalog] %@", [
                "display=\(targetDisplayId)",
                "allAX=\(allAccessibilityCandidates.count)",
                "catalog=\(catalog.count)",
                "windows=\(windows.count)",
                "strict=\(confidentMatches.count)",
                "activation=\(activationMatches.count)",
                "kept=\(catalogIndices.count)"
            ].joined(separator: " "))
            for index in catalog.indices {
                let candidate = catalog[index]
                let local = containingDisplay(
                    for: candidate.frame,
                    in: displays
                ) == targetDisplay
                NSLog("[Macnu catalog] %@", [
                    candidate.appName,
                    candidate.label,
                    "pid=\(candidate.pid)",
                    "local=\(local)",
                    "frame=\(NSStringFromRect(candidate.frame))",
                    "actions=\(candidate.actions.sorted().joined(separator: ","))",
                    "strict=\(confidentMatches[index]?.id ?? 0)",
                    "activation=\(activationMatches[index]?.id ?? 0)",
                    "kept=\(catalogIndices.contains(index))"
                ].joined(separator: " | "))
            }
        }
        var matchedItems: [CGWindowID: AccessibilityCandidate] = [:]
        for (index, window) in confidentMatches where
            catalogIndices.contains(index) {
            matchedItems[window.id] = catalog[index]
        }
        let matchedWindows = catalogIndices.compactMap { confidentMatches[$0] }
        let reusableImages = reusableIconImages(
            for: matchedWindows,
            matchedItems: matchedItems,
            appearance: appearance,
            at: captureTimestamp
        )
        let needsImageCapture = matchedWindows.contains {
            reusableImages[$0.id] == nil
        }
        let shareableById: [CGWindowID: SCWindow]
        if needsImageCapture && !screenCaptureDenied {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: false
            )
            shareableById = Dictionary(
                uniqueKeysWithValues: content.windows.map { ($0.windowID, $0) }
            )
        } else {
            shareableById = [:]
        }
        var capturedImages = reusableImages
        for menuWindow in matchedWindows where capturedImages[menuWindow.id] == nil {
            let captureWidth = max(1, Int(menuWindow.bounds.width * 2))
            let captureHeight = max(1, Int(menuWindow.bounds.height * 2))
            do {
                guard let shareableWindow = shareableById[menuWindow.id] else {
                    continue
                }
                let filter = SCContentFilter(
                    desktopIndependentWindow: shareableWindow
                )
                let configuration = SCStreamConfiguration()
                configuration.width = captureWidth
                configuration.height = captureHeight
                configuration.showsCursor = false
                configuration.ignoreShadowsSingleWindow = true
                configuration.captureResolution = .best
                let image: CGImage = try await SCScreenshotManager.captureImage(
                    contentFilter: filter,
                    configuration: configuration
                )
                guard let dataURL = pngDataURL(from: image) else { continue }
                capturedImages[menuWindow.id] = dataURL
                cacheIconImage(
                    dataURL,
                    for: menuWindow,
                    identity: iconCacheIdentity(
                        for: menuWindow,
                        candidate: matchedItems[menuWindow.id],
                        appearance: appearance
                    ),
                    width: captureWidth,
                    height: captureHeight,
                    at: captureTimestamp
                )
            } catch {
                continue
            }
        }

        let fallbackImage = neutralIconDataURL(appearance: appearance)
        var activationTargets: [String: CachedActivationTarget] = [:]
        let icons = catalogIndices.map { index in
            let candidate = catalog[index]
            let menuWindow = confidentMatches[index]
            let activationWindow = activationMatches[index]
            let displayFrame = menuWindow?.bounds ?? projectedFrame(
                for: candidate,
                onto: targetDisplay,
                displays: displays
            )
            let image = menuWindow.flatMap { capturedImages[$0.id] }
                ?? applicationIconDataURL(for: candidate)
                ?? fallbackImage
            let activationAction: String?
            if candidate.actions.contains(kAXShowMenuAction as String) {
                activationAction = kAXShowMenuAction as String
            } else if candidate.actions.contains(kAXPressAction as String) {
                activationAction = kAXPressAction as String
            } else if candidate.actions.contains(kAXPickAction as String) {
                activationAction = kAXPickAction as String
            } else {
                activationAction = nil
            }
            let activationKey = activationCacheKey(
                windowID: menuWindow?.id ?? 0,
                displayFrame: displayFrame,
                activationPID: candidate.pid,
                bundleIdentifier: candidate.bundleIdentifier,
                identifier: candidate.identifier,
                label: candidate.label,
                activationFrame: candidate.frame,
                action: activationAction
            )
            activationTargets[activationKey] = CachedActivationTarget(
                candidate: candidate,
                menuWindow: activationWindow,
                capturedAt: captureTimestamp
            )
            return MenuIcon(
                windowId: menuWindow?.id ?? 0,
                owner: candidate.appName,
                label: candidate.label,
                x: displayFrame.minX,
                y: displayFrame.minY,
                width: displayFrame.width,
                height: displayFrame.height,
                image: image,
                activationPid: candidate.pid,
                activationBundleId: candidate.bundleIdentifier,
                activationIdentifier: candidate.identifier,
                activationX: Double(candidate.frame.minX),
                activationY: Double(candidate.frame.minY),
                activationWidth: Double(candidate.frame.width),
                activationHeight: Double(candidate.frame.height),
                activationAction: activationAction
            )
        }
        storeActivationTargets(activationTargets, at: captureTimestamp)

        return CaptureResponse(
            icons: icons,
            displayId: targetDisplayId,
            screenCaptureDenied: screenCaptureDenied,
            accessibilityDenied: accessibilityDenied,
            error: nil
        )
    } catch {
        return CaptureResponse(
            icons: [],
            displayId: targetDisplayId,
            screenCaptureDenied: screenCaptureDenied,
            accessibilityDenied: accessibilityDenied,
            error: error.localizedDescription
        )
    }
}

private func encodedResponse(_ response: CaptureResponse) -> UnsafeMutablePointer<CChar>? {
    guard
        let data = try? JSONEncoder().encode(response),
        let json = String(data: data, encoding: .utf8)
    else {
        return nil
    }
    return strdup(json)
}

@_cdecl("macnu_copy_menu_icons_json")
public func macnuCopyMenuIconsJSON() -> UnsafeMutablePointer<CChar>? {
    let semaphore = DispatchSemaphore(value: 0)
    let box = CaptureBox()

    Task.detached {
        box.response = await captureMenuIcons()
        semaphore.signal()
    }
    semaphore.wait()

    return encodedResponse(
        box.response ?? CaptureResponse(
            icons: [],
            displayId: activeDisplayIdUnderPointer(),
            screenCaptureDenied: false,
            accessibilityDenied: !AXIsProcessTrusted(),
            error: "Menu capture did not return a result."
        )
    )
}

@_cdecl("macnu_free_native_string")
public func macnuFreeNativeString(_ pointer: UnsafeMutablePointer<CChar>?) {
    free(pointer)
}

@_cdecl("macnu_copy_installation_id")
public func macnuCopyInstallationID() -> UnsafeMutablePointer<CChar>? {
    guard let identifier = installationIdentifier() else { return nil }
    return strdup(identifier)
}

@_cdecl("macnu_copy_license_record_json")
public func macnuCopyLicenseRecordJSON() -> UnsafeMutablePointer<CChar>? {
    guard let data = keychainData(account: licenseRecordAccount),
          data.count <= maximumLicenseRecordBytes,
          let record = String(data: data, encoding: .utf8) else {
        return nil
    }
    return strdup(record)
}

@_cdecl("macnu_license_record_status")
public func macnuLicenseRecordStatus() -> Int32 {
    keychainItemStatus(account: licenseRecordAccount)
}

@_cdecl("macnu_save_license_record_json")
public func macnuSaveLicenseRecordJSON(
    _ recordJSON: UnsafePointer<CChar>?
) -> Int32 {
    guard let recordJSON else { return 1 }
    let record = String(cString: recordJSON)
    let data = Data(record.utf8)
    guard !data.isEmpty, data.count <= maximumLicenseRecordBytes else {
        return 1
    }
    return saveKeychainData(data, account: licenseRecordAccount) ? 0 : 2
}

@_cdecl("macnu_delete_license_record")
public func macnuDeleteLicenseRecord() -> Int32 {
    deleteKeychainData(account: licenseRecordAccount) ? 0 : 2
}

@_cdecl("macnu_active_display_id")
public func macnuActiveDisplayId() -> UInt32 {
    activeDisplayIdUnderPointer()
}

@_cdecl("macnu_active_menu_signature")
public func macnuActiveMenuSignature(_ displayID: UInt32) -> UInt64 {
    menuSignature(for: displayID)
}

@_cdecl("macnu_request_screen_capture")
public func macnuRequestScreenCapture() -> Bool {
    if CGPreflightScreenCaptureAccess() {
        return true
    }
    return CGRequestScreenCaptureAccess()
}

@_cdecl("macnu_screen_capture_granted")
public func macnuScreenCaptureGranted() -> Bool {
    CGPreflightScreenCaptureAccess()
}

@_cdecl("macnu_request_accessibility")
public func macnuRequestAccessibility() -> Bool {
    let options = [
        kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
    ] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

@_cdecl("macnu_accessibility_granted")
public func macnuAccessibilityGranted() -> Bool {
    AXIsProcessTrusted()
}

private func runningApplicationBundleURL() -> URL? {
    let bundleURL = Bundle.main.bundleURL.standardizedFileURL
    if bundleURL.pathExtension.caseInsensitiveCompare("app") == .orderedSame {
        return bundleURL
    }

    // Development builds are normally launched as a bare executable. Walk
    // its ancestors only as a defensive fallback; never reveal an unrelated
    // file and imply that it can be added to Accessibility.
    var candidate = URL(
        fileURLWithPath: CommandLine.arguments[0]
    ).standardizedFileURL
    while candidate.path != "/" {
        if candidate.pathExtension.caseInsensitiveCompare("app") == .orderedSame {
            return candidate
        }
        candidate.deleteLastPathComponent()
    }
    return nil
}

@_cdecl("macnu_reveal_app_in_finder")
public func macnuRevealAppInFinder() -> Bool {
    guard let bundleURL = runningApplicationBundleURL() else {
        return false
    }
    NSWorkspace.shared.activateFileViewerSelecting([bundleURL])
    return true
}

private func startAtLoginStatusCode() -> Int32 {
    switch SMAppService.mainApp.status {
    case .notRegistered:
        return 0
    case .enabled:
        return 1
    case .requiresApproval:
        return 2
    case .notFound:
        return 3
    @unknown default:
        return -1
    }
}

@_cdecl("macnu_start_at_login_status")
public func macnuStartAtLoginStatus() -> Int32 {
    startAtLoginStatusCode()
}

@_cdecl("macnu_set_start_at_login")
public func macnuSetStartAtLogin(_ enabled: Bool) -> Int32 {
    let service = SMAppService.mainApp
    do {
        if enabled {
            if service.status == .requiresApproval {
                return startAtLoginStatusCode()
            }
            if service.status != .enabled {
                try service.register()
            }
        } else if service.status != .notRegistered {
            try service.unregister()
        }
        return startAtLoginStatusCode()
    } catch {
        NSLog("[Macnu settings] start-at-login update failed: %@", error.localizedDescription)
        return -2
    }
}

@_cdecl("macnu_open_login_items_settings")
public func macnuOpenLoginItemsSettings() {
    SMAppService.openSystemSettingsLoginItems()
}

@_cdecl("macnu_activate_application")
public func macnuActivateApplication() {
    let activate = {
        dismissLastActivatedPopup()
    }
    if Thread.isMainThread {
        activate()
    } else {
        DispatchQueue.main.sync(execute: activate)
    }
}

@_cdecl("macnu_activate_menu_icon_json")
public func macnuActivateMenuIconJSON(
    _ requestJSON: UnsafePointer<CChar>?
) -> Int32 {
    let activationStartedAt = ProcessInfo.processInfo.systemUptime
    guard let requestJSON,
          let requestData = String(cString: requestJSON).data(using: .utf8),
          let request = try? JSONDecoder().decode(
            ActivationRequest.self,
            from: requestData
          ) else {
        return 4
    }

    guard AXIsProcessTrusted() else {
        _ = macnuRequestAccessibility()
        return 2
    }

    let displays = activeDisplayBounds()

    // The catalog refresh already performed the expensive all-item AX scan,
    // notch-safe matching, and ambiguity checks. Reuse that exact result on
    // Enter. Validate only the selected AX element and its previously matched
    // WindowServer window; never infer a neighbouring window here.
    if let cachedTarget = cachedActivationTarget(for: request),
       let activationCandidate = liveCachedCandidate(
           cachedTarget.candidate,
           for: request
       ) {
        let baselineWindowIDs = Set(onScreenWindows().map(\.id))
        if let menuWindow = unchangedCachedMenuWindow(
            cachedTarget.menuWindow,
            cachedCandidate: cachedTarget.candidate,
            liveCandidate: activationCandidate,
            displays: displays
        ), postMenuWindowClick(menuWindow) {
            _ = waitForOpenedPopup(
                since: baselineWindowIDs,
                targetPID: activationCandidate.pid,
                anchor: CGPoint(
                    x: activationCandidate.frame.midX,
                    y: activationCandidate.frame.midY
                )
            )
            rememberActivation(
                menuWindow: menuWindow,
                candidate: activationCandidate,
                action: request.activationAction,
                baselineWindowIDs: baselineWindowIDs
            )
            NSLog(
                "[Macnu activation] cached WindowServer match in %.1f ms",
                (ProcessInfo.processInfo.systemUptime - activationStartedAt) * 1_000
            )
            return 0
        }

        if let activation = performAccessibilityAction(
            on: activationCandidate,
            preferredAction: request.activationAction,
            baselineWindowIDs: baselineWindowIDs
        ) {
            rememberActivation(
                menuWindow: nil,
                candidate: activationCandidate,
                action: activation.action,
                baselineWindowIDs: baselineWindowIDs,
                usesProcessTargetedClick: activation.usedProcessTargetedClick
            )
            let route = activation.usedProcessTargetedClick
                ? "process-targeted click"
                : (activation.action ?? "Accessibility action")
            NSLog(
                "[Macnu activation] cached %@ in %.1f ms",
                route,
                (ProcessInfo.processInfo.systemUptime - activationStartedAt) * 1_000
            )
            return 0
        }
    }

    // A cache miss means the selected element disappeared, moved, or is older
    // than the retained catalog. Only that exceptional case pays for a fresh
    // all-item scan and confidence match.
    let accessibilityItems = accessibilityCandidates()
    guard let activationCandidate = cachedActivationCandidate(
        for: request,
        in: accessibilityItems
    ) else {
        NSLog("[Macnu activation] accessibility item is no longer available")
        return 1
    }
    let baselineWindowIDs = Set(onScreenWindows().map(\.id))
    let menuWindow = confidentMenuWindow(
        for: request,
        candidate: activationCandidate,
        allCandidates: accessibilityItems,
        displays: displays
    )

    // WindowServer delivery is used only when the fresh Accessibility-first
    // catalog still produces the same unambiguous one-to-one match. A stale or
    // uncertain window ID is never clicked.
    if let menuWindow,
       postMenuWindowClick(menuWindow) {
        _ = waitForOpenedPopup(
            since: baselineWindowIDs,
            targetPID: activationCandidate.pid,
            anchor: CGPoint(
                x: activationCandidate.frame.midX,
                y: activationCandidate.frame.midY
            )
        )
        rememberActivation(
            menuWindow: menuWindow,
            candidate: activationCandidate,
            action: request.activationAction,
            baselineWindowIDs: baselineWindowIDs
        )
        if let key = activationCacheKey(for: request) {
            storeActivationTargets([
                key: CachedActivationTarget(
                    candidate: activationCandidate,
                    menuWindow: menuWindow,
                    capturedAt: ProcessInfo.processInfo.systemUptime
                )
            ], at: ProcessInfo.processInfo.systemUptime)
        }
        NSLog(
            "[Macnu activation] refreshed WindowServer match in %.1f ms",
            (ProcessInfo.processInfo.systemUptime - activationStartedAt) * 1_000
        )
        return 0
    }

    if let activation = performAccessibilityAction(
        on: activationCandidate,
        preferredAction: request.activationAction,
        baselineWindowIDs: baselineWindowIDs
    ) {
        rememberActivation(
            menuWindow: nil,
            candidate: activationCandidate,
            action: activation.action,
            baselineWindowIDs: baselineWindowIDs,
            usesProcessTargetedClick: activation.usedProcessTargetedClick
        )
        if let key = activationCacheKey(for: request) {
            let timestamp = ProcessInfo.processInfo.systemUptime
            storeActivationTargets([
                key: CachedActivationTarget(
                    candidate: activationCandidate,
                    menuWindow: nil,
                    capturedAt: timestamp
                )
            ], at: timestamp)
        }
        let route = activation.usedProcessTargetedClick
            ? "process-targeted click"
            : (activation.action ?? "Accessibility action")
        NSLog(
            "[Macnu activation] refreshed %@ in %.1f ms",
            route,
            (ProcessInfo.processInfo.systemUptime - activationStartedAt) * 1_000
        )
        return 0
    }

    NSLog("[Macnu activation] no activation path succeeded")
    return 3
}
