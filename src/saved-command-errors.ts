function normalizedError(error: unknown): string {
  return String(error).trim().toLocaleLowerCase();
}

export function friendlyPinActionError(
  error: unknown,
  owner: string,
): string {
  const detail = normalizedError(error);
  const appName = owner.trim() || "This app";

  if (
    detail.includes("valid macnu license") ||
    detail.includes("license is required")
  ) {
    return "Open Settings to activate or review your Macnu license.";
  }
  if (detail.includes("complete macnu setup")) {
    return "Open Settings and finish Macnu setup, then pin the action again.";
  }
  if (detail.includes("accessibility")) {
    return "Allow Accessibility in Macnu Settings, then pin the action again.";
  }
  if (detail.includes("stable identity")) {
    return `${appName} doesn’t provide a reliable identity for pinned actions.`;
  }
  if (
    detail.includes("display is no longer") ||
    detail.includes("display no longer")
  ) {
    return "This Actions view is out of date. Go back, reopen Actions, and try again.";
  }
  if (
    detail.includes("menu-bar item is no longer") ||
    detail.includes("menu-bar item is not available") ||
    detail.includes("not available on this display")
  ) {
    return `${appName} changed while Actions was open. Go back, reopen Actions, and try again.`;
  }
  if (
    detail.includes("action changed") ||
    detail.includes("descriptor") ||
    detail.includes("path data") ||
    detail.includes("identity conflicts")
  ) {
    return "This action changed. Refresh Actions and try again.";
  }
  if (detail.includes("saved-actions limit")) {
    return "Macnu’s pinned-action limit has been reached. Unpin one in Settings, then try again.";
  }
  if (
    detail.includes("personalization") ||
    detail.includes("settings are unavailable") ||
    detail.includes("menu cache is unavailable")
  ) {
    return "Macnu couldn’t access pinned actions on this Mac. Nothing was changed; please try again.";
  }
  return "Macnu couldn’t pin that action. Nothing was changed; please try again.";
}
