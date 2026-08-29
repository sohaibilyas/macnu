export type ItemShortcutErrorKeyAction =
  | "dismiss"
  | "focus-dismiss"
  | "block";

export function itemShortcutErrorKeyAction(
  key: string,
): ItemShortcutErrorKeyAction {
  if (key === "Enter") return "dismiss";
  if (key === "Tab") return "focus-dismiss";
  return "block";
}
