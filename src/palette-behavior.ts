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

export type KeyboardModifierState = {
  metaKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
};

export function isPinShortcut(
  key: string,
  modifiers: KeyboardModifierState,
): boolean {
  return (
    key.toLocaleLowerCase() === "p" &&
    modifiers.metaKey &&
    !modifiers.altKey &&
    !modifiers.ctrlKey &&
    !modifiers.shiftKey
  );
}

export function pinnedFirstWhenIdle<T>(
  items: readonly T[],
  isPinned: (item: T) => boolean,
  hasQuery: boolean,
): T[] {
  if (hasQuery) return [...items];
  return items
    .map((item, nativeOrder) => ({ item, nativeOrder, pinned: isPinned(item) }))
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        left.nativeOrder - right.nativeOrder,
    )
    .map(({ item }) => item);
}

export type PointerPosition = { x: number; y: number };

export function pointerPositionChanged(
  previous: PointerPosition | null,
  current: PointerPosition,
): boolean {
  return (
    previous !== null &&
    (previous.x !== current.x || previous.y !== current.y)
  );
}

export function paletteResultLabel(
  isMacnu: boolean,
  personalizedLabel: string,
): string {
  return isMacnu ? "Macnu" : personalizedLabel;
}
