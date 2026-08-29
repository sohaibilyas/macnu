import { describe, expect, it } from "vitest";
import {
  findSearchMatch,
  getDisplayLabel,
  getSecondaryContext,
  personalizeMenuItems,
  rankPersonalizedItems,
  smartUsageScore,
  type ItemPreferenceMap,
  type PersonalizableMenuItem,
  type RankingMode,
} from "./personalization";

const NOW = Date.UTC(2026, 7, 28);
const DAY = 24 * 60 * 60 * 1_000;

function item(
  itemId: string,
  label: string,
  owner: string,
  nativeOrder: number,
): PersonalizableMenuItem {
  return { itemId, label, owner, nativeOrder };
}

describe("display labels and search", () => {
  it("uses a trimmed alias without replacing native label data", () => {
    const native = item("vpn", "Tailscale", "Tailscale Inc.", 0);
    const [personalized] = personalizeMenuItems([native], {
      vpn: { alias: "  Work VPN  " },
    });

    expect(personalized.displayLabel).toBe("Work VPN");
    expect(personalized.originalLabel).toBe("Tailscale");
    expect(personalized.item).toBe(native);
    expect(native.label).toBe("Tailscale");
    expect(getDisplayLabel(native, { alias: "  Work VPN  " })).toBe("Work VPN");
    expect(findSearchMatch(personalized, "work vpn")).toMatchObject({
      kind: "exact",
      field: "alias",
    });
    expect(findSearchMatch(personalized, "tailscale")).toMatchObject({
      kind: "exact",
      field: "label",
    });
    expect(findSearchMatch(personalized, "inc.")).toMatchObject({
      kind: "substring",
      field: "owner",
    });
  });

  it("lets a stored null alias explicitly restore the original label", () => {
    const native = {
      ...item("clock", "Pretty Timezones", "Pretty", 0),
      alias: "Clock",
    };
    const [personalized] = personalizeMenuItems([native], {
      clock: { alias: null },
    });

    expect(personalized.alias).toBeNull();
    expect(personalized.displayLabel).toBe("Pretty Timezones");
  });

  it("supports current catalog rows that do not yet have a persistent ID", () => {
    const native: PersonalizableMenuItem = {
      label: "Control Centre",
      owner: "macOS",
      alias: "Quick Controls",
      favorite: true,
    };
    const [personalized] = personalizeMenuItems([native], {
      stale: { alias: "Not this row" },
    });

    expect(personalized.itemId).toBeNull();
    expect(personalized.displayLabel).toBe("Quick Controls");
    expect(personalized.favorite).toBe(true);
    expect(personalized.nativeOrder).toBe(0);
  });

  it("shows secondary text only when it adds useful context", () => {
    const [duplicate] = personalizeMenuItems([
      item("tailscale", "Tailscale", "  tailscale  ", 0),
    ]);
    const [aliased] = personalizeMenuItems(
      [item("chatgpt", "ChatGPT", "ChatGPT", 0)],
      { chatgpt: { alias: "Cg" } },
    );
    const [dynamic] = personalizeMenuItems([
      item("cpu", "CPU 28%, Memory 76%", "Mole", 0),
    ]);
    const [distinctAlias] = personalizeMenuItems(
      [item("vpn", "Tailscale", "Tailscale Inc.", 0)],
      { vpn: { alias: "Work VPN" } },
    );
    const [unicodeDuplicate] = personalizeMenuItems([
      item("cafe", "Café", "Cafe\u0301", 0),
    ]);

    expect(getSecondaryContext(duplicate)).toBeNull();
    expect(getSecondaryContext(aliased)).toBe("ChatGPT");
    expect(getSecondaryContext(dynamic)).toBe("Mole");
    expect(getSecondaryContext(distinctAlias)).toBe("Tailscale · Tailscale Inc.");
    expect(getSecondaryContext(unicodeDuplicate)).toBeNull();
  });
});

describe("ranking", () => {
  const rows = [
    item("third", "Zulu", "Owner", 2),
    item("first", "Beta", "Owner", 0),
    item("second", "Alpha", "Owner", 1),
  ];

  it.each<RankingMode>(["smart", "menuBar", "alphabetical"])(
    "puts favorites first for an empty query in %s mode",
    (mode) => {
      const ranked = rankPersonalizedItems(
        rows,
        { third: { favorite: true } },
        { query: "", mode, now: NOW },
      );

      expect(ranked[0].itemId).toBe("third");
    },
  );

  it("supports menu-bar and alphabetical modes", () => {
    expect(
      rankPersonalizedItems(rows, {}, {
        query: "",
        mode: "menuBar",
        now: NOW,
      }).map(({ itemId }) => itemId),
    ).toEqual(["first", "second", "third"]);

    expect(
      rankPersonalizedItems(
        rows,
        { third: { alias: "Aardvark" } },
        { query: "", mode: "alphabetical", now: NOW },
      ).map(({ itemId }) => itemId),
    ).toEqual(["third", "second", "first"]);
  });

  it("sorts exact, prefix, then substring matches before favorites or usage", () => {
    const searchable = [
      item("substring", "Cloud Sync Tool", "Other", 0),
      item("prefix", "Anything", "Other", 1),
      item("exact", "Anything", "Sync", 2),
    ];
    const preferences: ItemPreferenceMap = {
      substring: { favorite: true, usageCount: 10_000, lastUsedAt: NOW },
      prefix: {
        alias: "Sync Utility",
        favorite: true,
        usageCount: 10_000,
        lastUsedAt: NOW,
      },
    };

    expect(
      rankPersonalizedItems(searchable, preferences, {
        query: "sync",
        mode: "smart",
        now: NOW,
      }).map(({ itemId }) => itemId),
    ).toEqual(["exact", "prefix", "substring"]);
  });

  it("uses bounded frequency and recency for smart mode", () => {
    const active = item("active", "Active", "Owner", 1);
    const old = item("old", "Old", "Owner", 0);
    const ranked = rankPersonalizedItems(
      [old, active],
      {
        active: { usageCount: 8, lastUsedAt: NOW - DAY },
        old: { usageCount: 1, lastUsedAt: NOW - 60 * DAY },
      },
      { query: "", mode: "smart", now: NOW },
    );

    expect(ranked.map(({ itemId }) => itemId)).toEqual(["active", "old"]);
    expect(smartUsageScore({ usageCount: -100, lastUsedAt: null }, NOW)).toBe(0);
    expect(
      smartUsageScore(
        { usageCount: Number.MAX_VALUE, lastUsedAt: NOW + DAY },
        NOW,
      ),
    ).toBe(1);
    expect(smartUsageScore({ usageCount: 10_000, lastUsedAt: NOW }, NOW)).toBe(
      smartUsageScore(
        { usageCount: Number.MAX_VALUE, lastUsedAt: NOW + DAY },
        NOW,
      ),
    );
  });

  it("uses native order then item ID as deterministic tie-breakers", () => {
    const tied = [
      item("z", "Same", "Owner", 2),
      item("b", "Same", "Owner", 1),
      item("a", "Same", "Owner", 1),
    ];

    expect(
      rankPersonalizedItems(tied, {}, {
        query: "",
        mode: "smart",
        now: NOW,
      }).map(({ itemId }) => itemId),
    ).toEqual(["a", "b", "z"]);
  });

  it("never turns stale preferences into catalog rows", () => {
    const current = item("current", "Current", "Owner", 0);
    const ranked = rankPersonalizedItems(
      [current],
      {
        current: { alias: "Here" },
        removed: { alias: "Ghost", favorite: true, usageCount: 10_000 },
      },
      { query: "", mode: "smart", now: NOW },
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0].item).toBe(current);
    expect(ranked[0].displayLabel).toBe("Here");
  });
});
