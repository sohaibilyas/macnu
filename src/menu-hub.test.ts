import { describe, expect, it } from "vitest";
import { gridSelection, menuStatus, parsePaletteLayout } from "./menu-hub";
import { buildPaletteResults, menuItemResultContext, menuItemResultLabel } from "./instant-commands";

describe("menu layout", () => {
  it("keeps the existing list as the default and ignores invalid stored values", () => {
    expect(parsePaletteLayout(null)).toBe("list");
    expect(parsePaletteLayout("broken")).toBe("list");
    expect(parsePaletteLayout("grid")).toBe("grid");
  });
  it("moves by columns vertically and by one icon horizontally", () => {
    expect(gridSelection(2, "ArrowDown", 12, 4)).toBe(6);
    expect(gridSelection(6, "ArrowUp", 12, 4)).toBe(2);
    expect(gridSelection(6, "ArrowLeft", 12, 4)).toBe(5);
    expect(gridSelection(6, "ArrowRight", 12, 4)).toBe(7);
  });
  it("clamps at edges and handles incomplete rows and empty grids", () => {
    expect(gridSelection(0, "ArrowUp", 10, 4)).toBe(0);
    expect(gridSelection(7, "ArrowDown", 10, 4)).toBe(9);
    expect(gridSelection(9, "ArrowRight", 10, 4)).toBe(9);
    expect(gridSelection(0, "ArrowLeft", 0, 4)).toBe(0);
  });
});

describe("truthful status previews", () => {
  it.each(["CPU 28%, Memory 76%", "Average CPU: 55°C", "Network ↑6.9 KB/s", "Fan 1200 rpm"])(
    "separates the app name from %s", (label) => {
      const item = { owner: "Monitor", label };
      expect(menuItemResultLabel(item)).toBe("Monitor");
      expect(menuItemResultContext(item)).toBe(label);
    },
  );
  it("preserves ordinary labels and does not guess VPN or connection states", () => {
    expect(menuStatus("Now Playing", "Control Centre")).toBeNull();
    expect(menuStatus("Battery 80%", "Control Centre")).toBeNull();
    expect(menuStatus("Tailscale", "Tailscale")).toBeNull();
    expect(menuItemResultLabel({ owner: "Control Centre", label: "Now Playing" })).toBe("Now Playing");
    expect(menuItemResultContext({ owner: "Tailscale", label: "Tailscale" })).toBeNull();
  });
  it("keeps aliases, deduplicates context, and always calls Macnu Macnu", () => {
    expect(menuItemResultLabel({ owner: "Monitor", label: "CPU 28%", alias: "Stats" })).toBe("Stats");
    expect(menuItemResultContext({ owner: "Monitor", label: "CPU 28%", alias: "Stats" })).toBe("Monitor · CPU 28%");
    expect(menuItemResultLabel({ owner: "Macnu", label: "CPU 28%", isMacnu: true })).toBe("Macnu");
  });
  it("keeps measurements searchable without boosting pinned search results", () => {
    const items = [
      { itemId: "a", label: "CPU 28%", owner: "Monitor", favorite: true },
      { itemId: "b", label: "CPU", owner: "Other", favorite: false },
    ];
    const opts = { query: "CPU", mode: "menuBar" as const, now: 0 };
    expect(buildPaletteResults(items, {}, opts).map((result) => result.kind === "item" ? result.itemId : null)).toEqual(["b", "a"]);
    expect(buildPaletteResults(items, {}, { ...opts, query: "" })[0].label).toBe("Monitor");
  });
});
