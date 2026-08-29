import { describe, expect, it } from "vitest";
import { itemShortcutErrorKeyAction } from "./palette-behavior";

describe("direct-shortcut error keyboard policy", () => {
  it("dismisses on Enter and moves Tab to the visible recovery control", () => {
    expect(itemShortcutErrorKeyAction("Enter")).toBe("dismiss");
    expect(itemShortcutErrorKeyAction("Tab")).toBe("focus-dismiss");
  });

  it.each(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "a"])(
    "blocks %s instead of exposing stale results",
    (key) => {
      expect(itemShortcutErrorKeyAction(key)).toBe("block");
    },
  );
});
