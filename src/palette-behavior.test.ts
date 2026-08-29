import { describe, expect, it } from "vitest";
import {
  itemShortcutErrorKeyAction,
  paletteResultLabel,
} from "./palette-behavior";

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

describe("palette result labels", () => {
  it("keeps native activation metadata out of the visible Macnu title", () => {
    expect(paletteResultLabel(true, "Macnu \u2014 Command+Semicolon")).toBe("Macnu");
    expect(paletteResultLabel(false, "Work VPN")).toBe("Work VPN");
  });
});
