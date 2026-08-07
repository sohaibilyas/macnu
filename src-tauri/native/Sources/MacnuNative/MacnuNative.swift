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
    let menuWindowID: CGWindowID
    let targetPID: pid_t
    let anchor: CGPoint
    let baselineWindowIDs: Set<CGWindowID>
}

private let activationSessionLock = NSLock()
private var lastActivationSession: ActivationSession?

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

            candidates.append(AccessibilityCandidate(
                element: element,
                pid: pid,
                appName: appName,
                frame: elementFrame,
                actions: actionNames(of: element)
            ))
        }
    }
    return candidates
}

private func matchedAccessibilityElement(
    for menuWindow: MenuWindow,
    in candidates: [AccessibilityCandidate],
    displays: [CGRect],
    requiringAction: Bool = false
) -> AccessibilityCandidate? {
    let menuDisplay = containingDisplay(for: menuWindow.bounds, in: displays)

    return candidates
        .compactMap { candidate -> (AccessibilityCandidate, CGFloat)? in
            if requiringAction
                && !candidate.actions.contains(kAXPressAction as String)
                && !candidate.actions.contains(kAXShowMenuAction as String) {
                return nil
            }

            let globalHorizontalDistance = abs(
                candidate.frame.midX - menuWindow.bounds.midX
            )
            let globalVerticalDistance = abs(
                candidate.frame.midY - menuWindow.bounds.midY
            )
            let candidateDisplay = containingDisplay(
                for: candidate.frame,
                in: displays
            )
            let horizontalDistance: CGFloat
            let verticalDistance: CGFloat
            if let menuDisplay, let candidateDisplay {
                // Status items are right-aligned. Comparing their distance
                // from each display's right edge lets an external-display
                // window match the corresponding AX item exposed on the main
                // display, even when the displays have different widths.
                let relativeHorizontalDistance = abs(
                    (menuDisplay.maxX - menuWindow.bounds.midX)
                        - (candidateDisplay.maxX - candidate.frame.midX)
                )
                let relativeVerticalDistance = abs(
                    (menuWindow.bounds.midY - menuDisplay.minY)
                        - (candidate.frame.midY - candidateDisplay.minY)
                )
                horizontalDistance = min(
                    globalHorizontalDistance,
                    relativeHorizontalDistance
                )
                verticalDistance = min(
                    globalVerticalDistance,
                    relativeVerticalDistance
                )
            } else {
                horizontalDistance = globalHorizontalDistance
                verticalDistance = globalVerticalDistance
            }
            let widthDistance = abs(candidate.frame.width - menuWindow.bounds.width) * 0.25
            let displayPenalty: CGFloat = menuDisplay == candidateDisplay ? 0 : 12
            // Some macOS-hosted extras have a window owned by SystemUIServer
            // or Control Centre while their AX element belongs to the source
            // app. Prefer a matching PID without excluding those valid items.
            let processPenalty: CGFloat = candidate.pid == menuWindow.pid ? 0 : 18
            return (
                candidate,
                horizontalDistance
                    + (verticalDistance * 2)
                    + widthDistance
                    + displayPenalty
                    + processPenalty
            )
        }
        .filter { $0.1 < max(56, menuWindow.bounds.width * 1.5) }
        .min { $0.1 < $1.1 }?
        .0
}

private func accessibilityLabel(
    candidate: AccessibilityCandidate?,
    fallback: String
) -> String {
    guard let candidate else {
        return fallback
    }

    for name in [
        kAXDescriptionAttribute,
        kAXTitleAttribute,
        kAXHelpAttribute,
        kAXValueAttribute,
        kAXIdentifierAttribute
    ] {
        if let value = attribute(name, from: candidate.element) as? String {
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

private func pngDataURL(from image: CGImage) -> String? {
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        return nil
    }
    return "data:image/png;base64,\(data.base64EncodedString())"
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
            bounds.width >= 80,
            bounds.height >= 40
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
    menuWindow: MenuWindow,
    targetPID: pid_t,
    baselineWindowIDs: Set<CGWindowID>
) {
    let session = ActivationSession(
        menuWindowID: menuWindow.id,
        targetPID: targetPID,
        anchor: CGPoint(x: menuWindow.bounds.midX, y: menuWindow.bounds.midY),
        baselineWindowIDs: baselineWindowIDs
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
        if let menuWindow = menuWindows(in: displays).first(where: {
            $0.id == session.menuWindowID
        }) {
            _ = postMenuWindowClick(menuWindow)
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

private func cachedActivationCandidate(
    for request: ActivationRequest,
    menuWindow: MenuWindow,
    in candidates: [AccessibilityCandidate]
) -> AccessibilityCandidate? {
    guard let activationPid = request.activationPid else {
        return nil
    }

    let actionable = candidates.filter { candidate in
        guard candidate.pid == activationPid else { return false }
        if let action = request.activationAction {
            return candidate.actions.contains(action)
        }
        return candidate.actions.contains(kAXPressAction as String)
            || candidate.actions.contains(kAXShowMenuAction as String)
    }
    guard !actionable.isEmpty else { return nil }

    // The cached label is a more stable identity than position. When the user
    // rearranges status items, resolve the same labeled AX element at its new
    // location instead of selecting whichever element occupies the old frame.
    let labelMatches = actionable.filter { candidate in
        let currentLabel = accessibilityLabel(
            candidate: candidate,
            fallback: candidate.appName
        )
        return currentLabel.caseInsensitiveCompare(request.label) == .orderedSame
    }
    if !labelMatches.isEmpty {
        return labelMatches.min { left, right in
            let leftDistance = hypot(
                left.frame.midX - menuWindow.bounds.midX,
                left.frame.midY - menuWindow.bounds.midY
            )
            let rightDistance = hypot(
                right.frame.midX - menuWindow.bounds.midX,
                right.frame.midY - menuWindow.bounds.midY
            )
            return leftDistance < rightDistance
        }
    }

    guard
        let x = request.activationX,
        let y = request.activationY,
        let width = request.activationWidth,
        let height = request.activationHeight
    else {
        return actionable.count == 1 ? actionable[0] : nil
    }
    let cachedFrame = CGRect(x: x, y: y, width: width, height: height)
    return actionable.min { left, right in
        let leftDistance = hypot(
            left.frame.midX - cachedFrame.midX,
            left.frame.midY - cachedFrame.midY
        )
        let rightDistance = hypot(
            right.frame.midX - cachedFrame.midX,
            right.frame.midY - cachedFrame.midY
        )
        return leftDistance < rightDistance
    }
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
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: false
        )
        let shareableById = Dictionary(
            uniqueKeysWithValues: content.windows.map { ($0.windowID, $0) }
        )
        let accessibilityItems = accessibilityCandidates()
        var icons: [MenuIcon] = []
        var seenIcons: Set<String> = []

        for menuWindow in windows {
            guard let shareableWindow = shareableById[menuWindow.id] else { continue }

            let filter = SCContentFilter(desktopIndependentWindow: shareableWindow)
            let configuration = SCStreamConfiguration()
            configuration.width = max(1, Int(menuWindow.bounds.width * 2))
            configuration.height = max(1, Int(menuWindow.bounds.height * 2))
            configuration.showsCursor = false
            configuration.ignoreShadowsSingleWindow = true
            configuration.captureResolution = .best

            do {
                let image: CGImage = try await SCScreenshotManager.captureImage(
                    contentFilter: filter,
                    configuration: configuration
                )
                guard let dataURL = pngDataURL(from: image) else { continue }
                let matchedItem = matchedAccessibilityElement(
                    for: menuWindow,
                    in: accessibilityItems,
                    displays: displays
                )
                let activationItem = matchedAccessibilityElement(
                    for: menuWindow,
                    in: accessibilityItems,
                    displays: displays,
                    requiringAction: true
                )
                let identityItem = activationItem ?? matchedItem
                let activationApplication = identityItem.flatMap {
                    NSRunningApplication(processIdentifier: $0.pid)
                }
                let activationAction = activationItem.flatMap { item in
                    if item.actions.contains(kAXPressAction as String) {
                        return kAXPressAction as String
                    }
                    if item.actions.contains(kAXShowMenuAction as String) {
                        return kAXShowMenuAction as String
                    }
                    return nil
                }
                let actualOwner = matchedItem?.appName ?? menuWindow.owner
                let label = accessibilityLabel(
                    candidate: matchedItem,
                    fallback: actualOwner
                )
                let identity = [
                    actualOwner.lowercased(),
                    label.lowercased(),
                    dataURL
                ].joined(separator: "\u{0}")
                guard seenIcons.insert(identity).inserted else {
                    continue
                }

                icons.append(MenuIcon(
                    windowId: menuWindow.id,
                    owner: actualOwner,
                    label: label,
                    x: menuWindow.bounds.minX,
                    y: menuWindow.bounds.minY,
                    width: menuWindow.bounds.width,
                    height: menuWindow.bounds.height,
                    image: dataURL,
                    activationPid: identityItem?.pid,
                    activationBundleId: activationApplication?.bundleIdentifier,
                    activationX: activationItem.map { Double($0.frame.minX) },
                    activationY: activationItem.map { Double($0.frame.minY) },
                    activationWidth: activationItem.map { Double($0.frame.width) },
                    activationHeight: activationItem.map { Double($0.frame.height) },
                    activationAction: activationAction
                ))
            } catch {
                continue
            }
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

    let displays = activeDisplayBounds()
    guard let menuWindow = menuWindows(in: displays).first(where: {
        $0.id == request.windowId
    }) else {
        NSLog(
            "[Macnu activation] window %u is no longer available",
            request.windowId
        )
        return 1
    }

    NSLog(
        "[Macnu activation] owner=%@ pid=%d window=%u onScreen=%d frame=%@",
        menuWindow.owner,
        menuWindow.pid,
        menuWindow.id,
        menuWindow.isOnScreen ? 1 : 0,
        NSStringFromRect(menuWindow.bounds)
    )

    guard AXIsProcessTrusted() else {
        _ = macnuRequestAccessibility()
        return 2
    }

    let catalogPID = pid_t(request.activationPid ?? menuWindow.pid)
    let baselineWindowIDs = Set(onScreenWindows().map(\.id))
    if clickMenuWindow(menuWindow, targetPID: catalogPID) {
        rememberActivation(
            menuWindow: menuWindow,
            targetPID: catalogPID,
            baselineWindowIDs: baselineWindowIDs
        )
        NSLog("[Macnu activation] delivered through WindowServer")
        return 0
    }

    // Generic recovery only: resolve the cached label back to the source
    // app's current accessibility element. No application name or bundle ID
    // changes which activation path is selected.
    handOffActivation(to: catalogPID)
    let accessibilityItems = accessibilityCandidates()
    let activationCandidate = cachedActivationCandidate(
        for: request,
        menuWindow: menuWindow,
        in: accessibilityItems
    ) ?? matchedAccessibilityElement(
            for: menuWindow,
            in: accessibilityItems,
            displays: displays,
            requiringAction: true
        )

    if let candidate = activationCandidate {
        let menuDisplay = containingDisplay(for: menuWindow.bounds, in: displays)
        let candidateDisplay = containingDisplay(for: candidate.frame, in: displays)

        // Visible items must stay tied to the requested display. A notch-hidden
        // item, however, may only expose an AX replica on another display; an
        // exact process match is safe in that case.
        let isRequestedDisplay = menuDisplay == candidateDisplay
        let isHiddenOwnerReplica = !menuWindow.isOnScreen
            && candidate.pid == catalogPID
        if isRequestedDisplay || isHiddenOwnerReplica {
            let cachedActions = request.activationAction.map { [$0] } ?? []
            let actions = cachedActions + [kAXPressAction as String, kAXShowMenuAction as String]
            let uniqueActions = actions.reduce(into: [String]()) { result, action in
                if !result.contains(action) { result.append(action) }
            }
            for action in uniqueActions {
                guard candidate.actions.contains(action as String) else {
                    continue
                }
                let visibleWindows = Set(onScreenWindows().map(\.id))
                if AXUIElementPerformAction(
                    candidate.element,
                    action as CFString
                ) == .success,
                   waitForOpenedPopup(
                    since: visibleWindows,
                    targetPID: catalogPID,
                    anchor: CGPoint(
                        x: candidate.frame.midX,
                        y: candidate.frame.midY
                    )
                   ) {
                    rememberActivation(
                        menuWindow: menuWindow,
                        targetPID: catalogPID,
                        baselineWindowIDs: visibleWindows
                    )
                    NSLog("[Macnu activation] opened with AX action %@", action)
                    return 0
                }
            }
        }
    }

    NSLog("[Macnu activation] no activation path succeeded")
    return 3
}
