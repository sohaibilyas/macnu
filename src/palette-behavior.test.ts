import { describe, expect, it } from "vitest";
import {
  itemShortcutErrorKeyAction,
  isPinShortcut,
  paletteResultLabel,
  pinnedFirstWhenIdle,
  pointerPositionChanged,
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

describe("pin keyboard policy", () => {
  const commandOnly = {
    metaKey: true,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
  };

  it("accepts exact Command+P", () => {
    expect(isPinShortcut("p", commandOnly)).toBe(true);
  });

  it.each([
    ["no Command", { ...commandOnly, metaKey: false }],
    ["Command+Option+P", { ...commandOnly, altKey: true }],
    ["Command+Control+P", { ...commandOnly, ctrlKey: true }],
    ["Command+Shift+P", { ...commandOnly, shiftKey: true }],
  ] as const)("rejects %s", (_label, modifiers) => {
    expect(isPinShortcut("p", modifiers)).toBe(false);
  });

  it("rejects other Command shortcuts", () => {
    expect(isPinShortcut("s", commandOnly)).toBe(false);
  });
});

describe("pin ordering", () => {
  const actions = [
    { id: "one" },
    { id: "two" },
    { id: "three" },
  ];

  it("promotes pins only while the Actions search is empty", () => {
    const pinned = new Set(["three"]);

    expect(
      pinnedFirstWhenIdle(actions, ({ id }) => pinned.has(id), false),
    ).toEqual([{ id: "three" }, { id: "one" }, { id: "two" }]);
    expect(
      pinnedFirstWhenIdle(actions, ({ id }) => pinned.has(id), true),
    ).toEqual(actions);
  });
});

describe("pointer selection after list movement", () => {
  it("ignores repeated stationary events when pinning or unpinning scrolls rows", () => {
    const cursor = { x: 500, y: 400 };
    for (let event = 0; event < 5; event += 1) {
      expect(pointerPositionChanged(cursor, { ...cursor })).toBe(false);
    }
  });

  it("resumes hover selection when the mouse actually moves on either axis", () => {
    expect(pointerPositionChanged({ x: 500, y: 400 }, { x: 501, y: 400 })).toBe(true);
    expect(pointerPositionChanged({ x: 500, y: 400 }, { x: 500, y: 401 })).toBe(true);
    expect(pointerPositionChanged(null, { x: 500, y: 400 })).toBe(false);
  });
});

describe("palette result labels", () => {
  it("keeps native activation metadata out of the visible Macnu title", () => {
    expect(paletteResultLabel(true, "Macnu \u2014 Command+Semicolon")).toBe("Macnu");
    expect(paletteResultLabel(false, "Work VPN")).toBe("Work VPN");
  });
});
