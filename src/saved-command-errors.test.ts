import { describe, expect, it } from "vitest";
import { friendlyPinActionError } from "./saved-command-errors";

describe("pinned action errors", () => {
  it.each([
    [
      "That display is no longer available.",
      "This Actions view is out of date. Go back, reopen Actions, and try again.",
    ],
    [
      "That menu-bar item is no longer available on this display.",
      "Tailscale changed while Actions was open. Go back, reopen Actions, and try again.",
    ],
    [
      "That menu action descriptor is invalid or has changed.",
      "This action changed. Refresh Actions and try again.",
    ],
    [
      "That menu action contains invalid or oversized path data.",
      "This action changed. Refresh Actions and try again.",
    ],
    [
      "Macnu has reached the saved-actions limit.",
      "Macnu’s pinned-action limit has been reached. Unpin one in Settings, then try again.",
    ],
    [
      "The personalization writer is unavailable.",
      "Macnu couldn’t access pinned actions on this Mac. Nothing was changed; please try again.",
    ],
  ])("maps %s to an actionable explanation", (error, expected) => {
    expect(friendlyPinActionError(error, "Tailscale")).toBe(expected);
  });

  it("keeps readiness failures specific", () => {
    expect(
      friendlyPinActionError(
        "A valid Macnu license is required.",
        "Tailscale",
      ),
    ).toContain("license");
    expect(
      friendlyPinActionError(
        "Complete Macnu setup before using the menu search.",
        "Tailscale",
      ),
    ).toContain("finish Macnu setup");
    expect(
      friendlyPinActionError(
        "Accessibility permission is required to use Macnu.",
        "Tailscale",
      ),
    ).toContain("Accessibility");
  });

  it("explains when an app cannot provide a reliable identity", () => {
    expect(
      friendlyPinActionError(
        "This menu-bar item does not expose a stable identity.",
        "Tailscale",
      ),
    ).toBe("Tailscale doesn’t provide a reliable identity for pinned actions.");
  });

  it("uses a safe fallback without guessing that the app stopped", () => {
    const message = friendlyPinActionError("Unexpected persistence failure", "");
    expect(message).toContain("Nothing was changed");
    expect(message).not.toContain("running");
  });
});
