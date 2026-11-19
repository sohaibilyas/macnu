import ApplicationServices
import CoreGraphics

struct HostedStatusTarget {
    let wrapper: AXUIElement
    let child: AXUIElement
    let window: AXUIElement
    let hostPID: pid_t
}

func uniqueHostedStatusTarget(_ targets: [HostedStatusTarget]) -> HostedStatusTarget? {
    var unique: [HostedStatusTarget] = []
    for target in targets where !unique.contains(where: {
        CFEqual($0.wrapper, target.wrapper) && CFEqual($0.child, target.child)
    }) {
        unique.append(target)
    }
    return unique.count == 1 ? unique[0] : nil
}

func statusFramesMatch(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
    [lhs, rhs].allSatisfy {
        !$0.isNull && !$0.isInfinite && $0.width > 0 && $0.height > 0
            && [$0.minX, $0.minY, $0.width, $0.height].allSatisfy(\.isFinite)
    } && abs(lhs.minX - rhs.minX) <= 1 && abs(lhs.minY - rhs.minY) <= 1
        && abs(lhs.width - rhs.width) <= 1 && abs(lhs.height - rhs.height) <= 1
}

/// Whether a status item sits on the collapsed side of the menu bar's
/// overflow control. Collapsed items either end to the control's left or are
/// stacked underneath it; visible items always start to its right.
func statusItemIsBehindOverflowControl(item: CGRect, control: CGRect) -> Bool {
    [item, control].allSatisfy {
        !$0.isNull && !$0.isInfinite && $0.width > 0 && $0.height > 0
            && [$0.minX, $0.minY, $0.width, $0.height].allSatisfy(\.isFinite)
    } && item.minX < control.minX
}

func verifiedStatusClickPoint(
    hitPID: pid_t, hitFrame: CGRect, targetPID: pid_t, targetFrame: CGRect,
    requestedFrame: CGRect, displays: [CGRect]
) -> CGPoint? {
    guard hitPID == targetPID, statusFramesMatch(hitFrame, targetFrame),
          activationFramesShareDisplay(requested: requestedFrame, target: targetFrame, displays: displays)
    else { return nil }
    return CGPoint(x: targetFrame.midX, y: targetFrame.midY)
}

func statusClickRestorationPoint(original: CGPoint, current: CGPoint, posted: CGPoint) -> CGPoint? {
    guard [original.x, original.y, current.x, current.y, posted.x, posted.y].allSatisfy(\.isFinite),
          abs(current.x - posted.x) <= 1, abs(current.y - posted.y) <= 1,
          original != current else { return nil }
    // Do not override mouse movement the user made while the menu was opening.
    return original
}

/// Whether a window that appeared after activation is the menu or popover
/// Macnu opened: it hangs below the item and belongs to the item's app or
/// floats above normal windows. Ordinary windows opened elsewhere are ignored.
func statusPopupIsOpen(
    windows: [OnScreenWindow], baseline: Set<CGWindowID>, itemPID: pid_t, anchor: CGPoint
) -> Bool {
    windows.contains { window in
        guard !baseline.contains(window.id) else { return false }
        let horizontalDistance = max(
            0, max(window.bounds.minX - anchor.x, anchor.x - window.bounds.maxX)
        )
        return horizontalDistance <= 48 && window.bounds.minY <= anchor.y + 100
            && (window.pid == itemPID || window.layer > 0)
    }
}

func pointIsInMenuBar(
    _ point: CGPoint, display: CGRect, barHeight: CGFloat = 40
) -> Bool {
    display.contains(point) && point.y < display.minY + barHeight
}

struct OverflowCollapseConditions {
    var menuOpen = false
    var launcherActive = false
    var mouseDown = false
    var pointerInMenuBar = false
}

/// Macnu re-collapses the menu bar only when nothing is using it: the opened
/// menu has closed, the palette is not focused, and the user is neither
/// pressing a mouse button nor pointing at the menu bar.
func overflowCollapseShouldWait(_ conditions: OverflowCollapseConditions) -> Bool {
    conditions.menuOpen || conditions.launcherActive
        || conditions.mouseDown || conditions.pointerInMenuBar
}
