import { describe, expect, it } from "vitest";
import { supportsDirectShortcut } from "./shortcut-identity";
describe("direct shortcut eligibility", () => {
  it("supports explicit and unique app-label-role identities", () => {
    expect(supportsDirectShortcut("v1.item-identifier.YXBw.aWNvbg")).toBe(true);
    expect(supportsDirectShortcut("v1.item-label-role.YXBw.bGFiZWw.cm9sZQ")).toBe(true);
  });
  it.each([
    "", "legacy", "v1.item-single.YXBw", "v1.item-label-role.YXBw.bGFiZWw",
    "v1.item-label-role.YXBw.bGFiZWw.cm9sZQ.extra", "v1.item-identifier.YXBw.aWNvbg\n",
    "v1.item-identifier.YXBw.bad/value", "v1.item-identifier.YXBw." + "a".repeat(512),
  ])("rejects malformed or app-only identity %s", (id) => {
    expect(supportsDirectShortcut(id)).toBe(false);
  });
});
