import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit
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

private struct AccessibilityCandidate {
    let element: AXUIElement
    let pid: pid_t
    let appName: String
    let bundleIdentifier: String?
    let label: String
    let identifier: String?
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
    let accessibilityPID: pid_t?
    let accessibilityLabel: String?
    let accessibilityFrame: CGRect?
    let accessibilityAction: String?
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

private let activationSessionLock = NSLock()
private var lastActivationSession: ActivationSession?
private let iconImageCacheLock = NSLock()
private var iconImageCache: [CGWindowID: CachedIconImage] = [:]
private let applicationIconCacheLock = NSLock()
private var applicationIconCache: [String: String] = [:]
private let iconImageCacheLifetime: TimeInterval = 30
private let iconImageCacheRetention: TimeInterval = 120

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
    in displays: [CGRect] = activeDisplayBounds()
) -> [MenuWindow] {
    // Menu extras obscured by the notch are not considered on-screen by
    // CoreGraphics, so the complete window list is required here.
    let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
    guard let info = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }

    let windows = info.compactMap { window -> MenuWindow? in
        guard
            let boundsDictionary = window[kCGWindowBounds as String] as? [String: Any],
            let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary),
            let layer = window[kCGWindowLayer as String] as? Int,
            let number = window[kCGWindowNumber as String] as? Int,
            let pid = window[kCGWindowOwnerPID as String] as? Int,
            let owner = window[kCGWindowOwnerName as String] as? String,
            layer == 25,
            displays.isEmpty || displays.contains(where: { display in
                abs(bounds.minY - display.minY) <= 2
                    && bounds.maxX > display.minX
                    && bounds.minX < display.maxX
            }),
            bounds.height >= 24,
            bounds.height <= 48,
            bounds.width >= 12,
            bounds.width <= 180
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

    // macOS creates a copy of each status-item window for every Space. Prefer
    // the active copy, then collapse copies with identical process/geometry.
    let preferred = windows.sorted { left, right in
        if left.isOnScreen != right.isOnScreen {
            return left.isOnScreen
        }
        if left.bounds.minX == right.bounds.minX {
            return left.id < right.id
        }
        return left.bounds.minX < right.bounds.minX
    }

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

private func descendants(of element: AXUIElement, depth: Int = 0) -> [AXUIElement] {
    guard depth < 3 else { return [] }
    guard
        let rawChildren = attribute(kAXChildrenAttribute, from: element),
        CFGetTypeID(rawChildren) == CFArrayGetTypeID()
    else {
        return []
    }

    let children = (rawChildren as! [AnyObject]).compactMap { value -> AXUIElement? in
        let rawValue = value as CFTypeRef
        guard CFGetTypeID(rawValue) == AXUIElementGetTypeID() else {
            return nil
        }
        return unsafeBitCast(rawValue, to: AXUIElement.self)
    }
    return children + children.flatMap { descendants(of: $0, depth: depth + 1) }
}

private func accessibilityCandidates() -> [AccessibilityCandidate] {
    guard AXIsProcessTrusted() else { return [] }

    var candidates: [AccessibilityCandidate] = []
    for runningApplication in NSWorkspace.shared.runningApplications {
        let pid = runningApplication.processIdentifier
        let appName = runningApplication.localizedName
            ?? runningApplication.bundleIdentifier
            ?? "Menu bar app"
        let bundleIdentifier = runningApplication.bundleIdentifier
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 1.0)

        guard
            let extrasValue = attribute(
                kAXExtrasMenuBarAttribute,
                from: application
            ),
            CFGetTypeID(extrasValue) == AXUIElementGetTypeID()
        else {
            continue
        }

        let extras = unsafeBitCast(extrasValue, to: AXUIElement.self)
        for element in [extras] + descendants(of: extras) {
            guard
                let elementFrame = frame(of: element),
                elementFrame.width > 0,
                elementFrame.width <= 200,
                elementFrame.height > 0,
                elementFrame.height <= 64
            else {
                continue
            }

            // Multi-display accessibility trees expose display-level menu-bar
            // containers named "Mac 1", "Mac 2", and so on. Keep the varied
            // roles used by real status items, but never match the container.
            if let role = attribute(kAXRoleAttribute, from: element) as? String,
               role == kAXMenuBarRole as String {
                continue
            }

            let actions = actionNames(of: element)
            guard actions.contains(kAXPressAction as String)
                || actions.contains(kAXShowMenuAction as String) else {
                continue
            }
            let rawIdentifier = attribute(
                kAXIdentifierAttribute,
                from: element
            ) as? String
            let identifier = rawIdentifier?.trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            candidates.append(AccessibilityCandidate(
                element: element,
                pid: pid,
                appName: appName,
                bundleIdentifier: bundleIdentifier,
                label: accessibilityText(from: element, fallback: appName),
                identifier: identifier?.isEmpty == false ? identifier : nil,
                frame: elementFrame,
                actions: actions
            ))
        }
    }
    return candidates
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

private func catalogCandidates(
    _ candidates: [AccessibilityCandidate],
    targetDisplay: CGRect,
    displays: [CGRect]
) -> [AccessibilityCandidate] {
    var grouped: [String: [AccessibilityCandidate]] = [:]
    for candidate in candidates {
        let source = candidate.bundleIdentifier
            ?? "pid:\(candidate.pid)"
        let item = candidate.identifier?.lowercased()
            ?? candidate.label.lowercased()
        grouped["\(source)|\(item)", default: []].append(candidate)
    }

    return grouped.values.compactMap { copies in
        let onTargetDisplay = copies.filter {
            containingDisplay(for: $0.frame, in: displays) == targetDisplay
        }
        let eligible = onTargetDisplay.isEmpty ? copies : onTargetDisplay
        return eligible.min { left, right in
            let leftFrame = projectedFrame(
                for: left,
                onto: targetDisplay,
                displays: displays
            )
            let rightFrame = projectedFrame(
                for: right,
                onto: targetDisplay,
                displays: displays
            )
            if leftFrame.minX == rightFrame.minX {
                return leftFrame.width < rightFrame.width
            }
            return leftFrame.minX < rightFrame.minX
        }
    }
    .sorted {
        projectedFrame(for: $0, onto: targetDisplay, displays: displays).minX
            < projectedFrame(for: $1, onto: targetDisplay, displays: displays).minX
    }
}

private func geometryCost(
    window: MenuWindow,
    candidate: AccessibilityCandidate,
    targetDisplay: CGRect,
    displays: [CGRect]
) -> CGFloat {
    let frame = projectedFrame(
        for: candidate,
        onto: targetDisplay,
        displays: displays
    )
    return abs(frame.midX - window.bounds.midX)
        + (abs(frame.midY - window.bounds.midY) * 2)
        + (abs(frame.width - window.bounds.width) * 0.25)
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

private func confidentWindowMatches(
    windows: [MenuWindow],
    candidates: [AccessibilityCandidate],
    targetDisplay: CGRect,
    displays: [CGRect]
) -> [Int: MenuWindow] {
    guard !windows.isEmpty, !candidates.isEmpty else { return [:] }

    let costs = candidates.map { candidate in
        windows.map {
            geometryCost(
                window: $0,
                candidate: candidate,
                targetDisplay: targetDisplay,
                displays: displays
            )
        }
    }
    var matches: [Int: MenuWindow] = [:]
    var usedCandidates: Set<Int> = []
    var usedWindows: Set<Int> = []

    // Public AX hit-testing is authoritative when it resolves a unique status
    // item at the center of a WindowServer icon. This avoids all notch-offset
    // inference for items macOS can identify directly.
    for windowIndex in windows.indices {
        guard let candidateIndex = hitTestedCandidateIndex(
            for: windows[windowIndex],
            candidates: candidates
        ), !usedCandidates.contains(candidateIndex) else {
            continue
        }
        matches[candidateIndex] = windows[windowIndex]
        usedCandidates.insert(candidateIndex)
        usedWindows.insert(windowIndex)
    }

    for candidateIndex in candidates.indices where !usedCandidates.contains(candidateIndex) {
        let rankedWindows = windows.indices.filter {
            !usedWindows.contains($0)
        }.sorted {
            costs[candidateIndex][$0] < costs[candidateIndex][$1]
        }
        guard let windowIndex = rankedWindows.first else { continue }
        let bestCost = costs[candidateIndex][windowIndex]
        let threshold = min(
            20,
            max(12, windows[windowIndex].bounds.width * 0.35)
        )
        guard bestCost <= threshold else { continue }

        let nextWindowCost = rankedWindows.dropFirst().first.map {
            costs[candidateIndex][$0]
        } ?? .greatestFiniteMagnitude
        guard nextWindowCost - bestCost >= 10 else { continue }

        let rankedCandidates = candidates.indices.filter {
            !usedCandidates.contains($0)
        }.sorted {
            costs[$0][windowIndex] < costs[$1][windowIndex]
        }
        guard rankedCandidates.first == candidateIndex else { continue }
        let nextCandidateCost = rankedCandidates.dropFirst().first.map {
            costs[$0][windowIndex]
        } ?? .greatestFiniteMagnitude
        guard nextCandidateCost - bestCost >= 10 else { continue }

        matches[candidateIndex] = windows[windowIndex]
        usedCandidates.insert(candidateIndex)
        usedWindows.insert(windowIndex)
    }
    return matches
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

private func neutralIconDataURL() -> String {
    let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect x="8" y="14" width="48" height="36" rx="12" fill="#20232b" stroke="#7f8799" stroke-width="3"/>
      <circle cx="22" cy="32" r="4" fill="#c7ccd8"/>
      <circle cx="32" cy="32" r="4" fill="#c7ccd8"/>
      <circle cx="42" cy="32" r="4" fill="#c7ccd8"/>
    </svg>
    """
    return "data:image/svg+xml;base64,\(Data(svg.utf8).base64EncodedString())"
}

private func reusableIconImages(
    for windows: [MenuWindow],
    matchedItems: [CGWindowID: AccessibilityCandidate],
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
            candidate: matchedItems[window.id]
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
    candidate: AccessibilityCandidate?
) -> String {
    guard let candidate else {
        return "\(window.pid)|\(window.owner.lowercased())|unmatched"
    }
    return [
        String(candidate.pid),
        candidate.bundleIdentifier ?? "",
        candidate.appName.lowercased(),
    ].joined(separator: "|")
}

private func onScreenWindows() -> [OnScreenWindow] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
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
            layer != 25,
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
    since previous: Set<CGWindowID>,
    targetPID: pid_t,
    anchor: CGPoint
) -> Bool {
    for _ in 0..<20 {
        Thread.sleep(forTimeInterval: 0.05)
        let newWindows = onScreenWindows().filter { !previous.contains($0.id) }
        if newWindows.contains(where: { window in
            if window.pid == targetPID {
                return true
            }
            // Some status-item apps render the popup in a helper process.
            // Accept only a newly visible window attached to the clicked item.
            let horizontalDistance = max(
                0,
                max(window.bounds.minX - anchor.x, anchor.x - window.bounds.maxX)
            )
            return horizontalDistance <= 32
                && window.bounds.minY <= anchor.y + 80
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
    baselineWindowIDs: Set<CGWindowID>
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
        accessibilityPID: candidate?.pid,
        accessibilityLabel: candidate?.label,
        accessibilityFrame: candidate?.frame,
        accessibilityAction: action
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
        } else if let pid = session.accessibilityPID,
                  let label = session.accessibilityLabel,
                  let frame = session.accessibilityFrame,
                  let candidate = resolvedAccessibilityCandidate(
                      pid: pid,
                      label: label,
                      frame: frame,
                      preferredAction: session.accessibilityAction,
                      in: accessibilityCandidates()
                  ) {
            let action = session.accessibilityAction
                ?? (candidate.actions.contains(kAXPressAction as String)
                    ? kAXPressAction as String
                    : kAXShowMenuAction as String)
            _ = AXUIElementPerformAction(candidate.element, action as CFString)
            Thread.sleep(forTimeInterval: 0.045)
        }
    }

    // Activation is deliberately last. Rust shows and focuses the palette
    // only after this synchronous dismissal sequence has fully completed.
    NSApp.activate()
    Thread.sleep(forTimeInterval: 0.015)
}

private func handOffActivation(to pid: pid_t) {
    guard pid != ProcessInfo.processInfo.processIdentifier,
          let target = NSRunningApplication(processIdentifier: pid) else {
        return
    }

    DispatchQueue.main.sync {
        NSApp.yieldActivation(to: target)
        _ = target.activate(from: .current, options: [])
    }
    Thread.sleep(forTimeInterval: 0.06)
}

private func resolvedAccessibilityCandidate(
    pid: pid_t,
    label: String,
    frame: CGRect?,
    preferredAction: String?,
    in candidates: [AccessibilityCandidate]
) -> AccessibilityCandidate? {
    let actionable = candidates.filter { candidate in
        guard candidate.pid == pid else { return false }
        if let action = preferredAction {
            return candidate.actions.contains(action)
        }
        return candidate.actions.contains(kAXPressAction as String)
            || candidate.actions.contains(kAXShowMenuAction as String)
    }
    guard !actionable.isEmpty else { return nil }

    let labelMatches = actionable.filter { candidate in
        candidate.label.caseInsensitiveCompare(label) == .orderedSame
    }
    let eligible = labelMatches.isEmpty ? actionable : labelMatches
    guard let frame else {
        return eligible.count == 1 ? eligible[0] : nil
    }
    return eligible.min { left, right in
        hypot(left.frame.midX - frame.midX, left.frame.midY - frame.midY)
            < hypot(right.frame.midX - frame.midX, right.frame.midY - frame.midY)
    }
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
    let windows = menuWindows(in: displays).filter {
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
    return confidentWindowMatches(
        windows: windows,
        candidates: catalog,
        targetDisplay: targetDisplay,
        displays: displays
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
    // item through the same WindowServer path using the current layer-25
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

private func clickMenuWindow(
    _ menuWindow: MenuWindow,
    targetPID: pid_t
) -> Bool {
    let visibleWindows = Set(onScreenWindows().map(\.id))
    guard postMenuWindowClick(menuWindow) else {
        return false
    }

    // A visible status item may perform an immediate action without creating
    // a popup. The targeted WindowServer delivery is sufficient in that case.
    if menuWindow.isOnScreen {
        return true
    }

    return waitForOpenedPopup(
        since: visibleWindows,
        targetPID: targetPID,
        anchor: CGPoint(x: menuWindow.bounds.midX, y: menuWindow.bounds.midY)
    )
}

private func captureMenuIcons() async -> CaptureResponse {
    let displays = activeDisplayBounds()
    let targetDisplayId = activeDisplayIdUnderPointer()
    let targetDisplay = CGDisplayBounds(targetDisplayId)
    let windows = menuWindows(in: displays).filter { window in
        return containingDisplay(for: window.bounds, in: displays) == targetDisplay
    }
    let accessibilityDenied = !AXIsProcessTrusted()

    guard CGPreflightScreenCaptureAccess() else {
        return CaptureResponse(
            icons: [],
            displayId: targetDisplayId,
            screenCaptureDenied: true,
            accessibilityDenied: accessibilityDenied,
            error: nil
        )
    }

    do {
        let captureTimestamp = ProcessInfo.processInfo.systemUptime
        let catalog = catalogCandidates(
            accessibilityCandidates(),
            targetDisplay: targetDisplay,
            displays: displays
        )
        let confidentMatches = confidentWindowMatches(
            windows: windows,
            candidates: catalog,
            targetDisplay: targetDisplay,
            displays: displays
        )
        let matchedItems = Dictionary(
            uniqueKeysWithValues: confidentMatches.map {
                ($0.value.id, catalog[$0.key])
            }
        )
        let matchedWindows = Array(confidentMatches.values)
        let reusableImages = reusableIconImages(
            for: matchedWindows,
            matchedItems: matchedItems,
            at: captureTimestamp
        )
        let needsImageCapture = matchedWindows.contains {
            reusableImages[$0.id] == nil
        }
        let shareableById: [CGWindowID: SCWindow]
        if needsImageCapture {
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
                        candidate: matchedItems[menuWindow.id]
                    ),
                    width: captureWidth,
                    height: captureHeight,
                    at: captureTimestamp
                )
            } catch {
                continue
            }
        }

        let fallbackImage = neutralIconDataURL()
        let icons = catalog.enumerated().map { index, candidate in
            let menuWindow = confidentMatches[index]
            let displayFrame = menuWindow?.bounds ?? projectedFrame(
                for: candidate,
                onto: targetDisplay,
                displays: displays
            )
            let image = menuWindow.flatMap { capturedImages[$0.id] }
                ?? applicationIconDataURL(for: candidate)
                ?? fallbackImage
            let activationAction: String?
            if candidate.actions.contains(kAXPressAction as String) {
                activationAction = kAXPressAction as String
            } else if candidate.actions.contains(kAXShowMenuAction as String) {
                activationAction = kAXShowMenuAction as String
            } else {
                activationAction = nil
            }
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
                activationX: Double(candidate.frame.minX),
                activationY: Double(candidate.frame.minY),
                activationWidth: Double(candidate.frame.width),
                activationHeight: Double(candidate.frame.height),
                activationAction: activationAction
            )
        }

        return CaptureResponse(
            icons: icons,
            displayId: targetDisplayId,
            screenCaptureDenied: false,
            accessibilityDenied: accessibilityDenied,
            error: nil
        )
    } catch {
        return CaptureResponse(
            icons: [],
            displayId: targetDisplayId,
            screenCaptureDenied: false,
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

@_cdecl("macnu_request_accessibility")
public func macnuRequestAccessibility() -> Bool {
    let options = [
        kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
    ] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
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
    let accessibilityItems = accessibilityCandidates()
    guard let activationCandidate = cachedActivationCandidate(
        for: request,
        in: accessibilityItems
    ) else {
        NSLog("[Macnu activation] accessibility item is no longer available")
        return 1
    }
    let catalogPID = activationCandidate.pid
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
       clickMenuWindow(menuWindow, targetPID: catalogPID) {
        rememberActivation(
            menuWindow: menuWindow,
            candidate: activationCandidate,
            action: request.activationAction,
            baselineWindowIDs: baselineWindowIDs
        )
        NSLog("[Macnu activation] delivered through confident WindowServer match")
        return 0
    }

    handOffActivation(to: catalogPID)
    let cachedActions = request.activationAction.map { [$0] } ?? []
    let actions = cachedActions + [kAXPressAction as String, kAXShowMenuAction as String]
    let uniqueActions = actions.reduce(into: [String]()) { result, action in
        if !result.contains(action) { result.append(action) }
    }
    for action in uniqueActions {
        guard activationCandidate.actions.contains(action) else { continue }
        let visibleWindows = Set(onScreenWindows().map(\.id))
        if AXUIElementPerformAction(
            activationCandidate.element,
            action as CFString
        ) == .success {
            let openedPopup = waitForOpenedPopup(
                since: visibleWindows,
                targetPID: catalogPID,
                anchor: CGPoint(
                    x: activationCandidate.frame.midX,
                    y: activationCandidate.frame.midY
                )
            )
            if openedPopup {
                rememberActivation(
                    menuWindow: nil,
                    candidate: activationCandidate,
                    action: action,
                    baselineWindowIDs: visibleWindows
                )
            }
            NSLog("[Macnu activation] delivered through Accessibility action %@", action)
            return 0
        }
    }

    NSLog("[Macnu activation] no activation path succeeded")
    return 3
}
