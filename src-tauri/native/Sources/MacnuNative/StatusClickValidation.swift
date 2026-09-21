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
