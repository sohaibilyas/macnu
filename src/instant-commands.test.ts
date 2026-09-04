import { describe, expect, it } from "vitest";
import {
  buildPaletteResults,
  findPaletteSearchMatch,
  menuItemResultContext,
  menuItemResultLabel,
  savedActionResultContext,
  savedActionResultLabel,
  stableMenuItemResultId,
  stableSavedActionResultId,
  type LiveMenuItemView,
  type PaletteResult,
  type SavedActionMap,
  type SavedActionView,
} from "./instant-commands";

const NOW = Date.UTC(2026, 7, 31);

function item(
  itemId: string,
  label: string,
  owner: string,
  nativeOrder: number,
  overrides: Partial<LiveMenuItemView> = {},
): LiveMenuItemView {
  return { itemId, label, owner, nativeOrder, ...overrides };
}

function savedAction(
  id: string,
  parentItemId: string,
  title: string,
  overrides: Partial<SavedActionView> = {},
): SavedActionView {
  return {
    id,
    parentItemId,
    owner: "OrbStack",
    parentLabel: "OrbStack",
    action: {
      id: `native-${id}`,
      title,
      path: [{ title, occurrence: 0 }],
      enabled: true,
      shortcut: null,
    },
    alias: null,
    shortcut: null,
    usageCount: 0,
    lastUsedAt: null,
    ...overrides,
  };
}

function actionMap(...actions: SavedActionView[]): SavedActionMap {
  return Object.fromEntries(actions.map((action) => [action.id, action]));
}

function ranked(
  items: readonly LiveMenuItemView[],
  actions: SavedActionMap,
  query: string,
  mode: "smart" | "menuBar" | "alphabetical" = "smart",
): PaletteResult[] {
  return buildPaletteResults(items, actions, {
    query,
    mode,
    now: NOW,
    includeSavedActions: true,
  });
}

describe("Instant Commands search", () => {
  it("keeps saved actions inside their parent by default", () => {
    const parent = item("orb", "OrbStack", "OrbStack", 0);
    const command = savedAction("restart", "orb", "Restart");

    const results = buildPaletteResults(
      [parent],
      actionMap(command),
      { query: "", mode: "smart", now: NOW },
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "item",
      itemId: "orb",
    });
  });

  it("ranks exact and prefix matches ahead of fuzzy matches", () => {
    const results = ranked(
      [
        item("fuzzy-substring", "CloudSyncAgent", "Acme", 0),
        item("fuzzy-typo", "Synx", "Acme", 1, { favorite: true }),
        item("prefix", "Sync Utility", "Acme", 2),
        item("exact", "Sync", "Acme", 3),
      ],
      {},
      "sync",
    );

    expect(results.map(({ id }) => id)).toEqual([
      "item:exact",
      "item:prefix",
      "item:fuzzy-substring",
      "item:fuzzy-typo",
    ]);
    expect(results.map(({ match }) => match?.kind)).toEqual([
      "exact",
      "prefix",
      "fuzzy",
      "fuzzy",
    ]);
  });

  it("searches aliases, titles, owners, and action path segments", () => {
    const parent = item("orb", "Orb menu", "Acme Systems", 0, {
      alias: "Dev tools",
    });
    const stop = savedAction("stop", "orb", "Stop", {
      owner: "Acme Systems",
      parentLabel: "Orb menu",
      alias: "Halt stack",
      action: {
        id: "native-stop",
        title: "Stop",
        path: [
          { title: "Containers", occurrence: 0 },
          { title: "Stop", occurrence: 0 },
        ],
        enabled: true,
        shortcut: null,
      },
    });

    for (const query of ["halt stack", "stop", "containers"]) {
      const result = ranked([parent], actionMap(stop), query).find(
        ({ kind }) => kind === "action",
      );
      expect(result?.match?.kind, query).toBe("exact");
    }
    const byOwner = ranked([parent], actionMap(stop), "acme systems");
    expect(
      byOwner.some(
        ({ kind, match }) => kind === "action" && match?.field === "owner",
      ),
    ).toBe(true);
    expect(ranked([parent], actionMap(stop), "dev tools")).toHaveLength(2);
  });

  it("matches reordered tokens and common acronyms", () => {
    const parent = item("sync", "Cloud Utility", "Acme", 0);
    const pause = savedAction("pause", "sync", "Pause Cloud Sync");
    const tokenResult = ranked([parent], actionMap(pause), "sync pause");

    expect(tokenResult).toHaveLength(1);
    expect(tokenResult[0]).toMatchObject({ kind: "action" });
    expect(tokenResult[0].match?.kind).toBe("token");

    const acronymResult = ranked(
      [item("clock", "Pretty Timezones", "Clockworks", 0)],
      {},
      "pt",
    );
    expect(acronymResult).toHaveLength(1);
    expect(acronymResult[0].match?.kind).toBe("acronym");
  });

  it("allows mild typos while keeping short and distant terms strict", () => {
    expect(
      findPaletteSearchMatch(
        [{ field: "title", value: "Tailscale" }],
        "tailscael",
      ),
    ).toMatchObject({ kind: "fuzzy", field: "title" });
    expect(
      findPaletteSearchMatch([{ field: "title", value: "Tailscale" }], "tx"),
    ).toBeNull();
    expect(
      findPaletteSearchMatch(
        [{ field: "title", value: "Tailscale" }],
        "television",
      ),
    ).toBeNull();
  });
});

describe("catalog safety", () => {
  it("hides a parent row without hiding its saved actions", () => {
    const hidden = item("hidden", "Secret VPN", "VPN", 0, { hidden: true });
    const visible = item("visible", "Visible VPN", "VPN", 1);
    const results = ranked(
      [hidden, visible],
      actionMap(
        savedAction("disconnect-hidden", "hidden", "Disconnect"),
        savedAction("disconnect-visible", "visible", "Disconnect"),
      ),
      "",
      "menuBar",
    );

    expect(results.map(({ id }) => id)).toEqual([
      "action:hidden:disconnect-hidden",
      "action:visible:disconnect-visible",
      "item:visible",
    ]);
    expect(results[0]).toMatchObject({
      kind: "action",
      parentItemId: "hidden",
      parent: { hidden: true },
      savedAction: { action: { enabled: true } },
    });
  });

  it("never materializes an orphan saved action", () => {
    const current = item("current", "Current", "Owner", 0);
    const results = ranked(
      [current],
      actionMap(savedAction("ghost", "removed-parent", "Ghost action")),
      "",
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "item", itemId: "current" });
  });

  it("deduplicates IDs and uses deterministic tie-breakers", () => {
    const parent = item("parent", "Same", "Owner", 0);
    const first = item("a", "Same", "Owner", 1);
    const second = item("b", "Same", "Owner", 1);
    const actionA = savedAction("action-a", "parent", "Run");
    const actionB = savedAction("action-b", "parent", "Run");
    const expected = [
      "action:parent:action-a",
      "action:parent:action-b",
      "item:parent",
      "item:a",
      "item:b",
    ];

    expect(
      ranked(
        [parent, second, first, { ...first }],
        actionMap(actionB, actionA),
        "",
        "menuBar",
      ).map(({ id }) => id),
    ).toEqual(expected);
    expect(
      ranked(
        [{ ...first }, first, second, parent],
        actionMap(actionA, actionB),
        "",
        "menuBar",
      ).map(({ id }) => id),
    ).toEqual(expected);
  });
});

describe("ranking modes", () => {
  it.each([
    [
      "smart",
      [
        "item:favorite",
        "action:parent:command",
        "item:frequent",
        "item:parent",
      ],
    ],
    [
      "menuBar",
      [
        "item:favorite",
        "action:parent:command",
        "item:parent",
        "item:frequent",
      ],
    ],
    [
      "alphabetical",
      [
        "item:favorite",
        "action:parent:command",
        "item:frequent",
        "item:parent",
      ],
    ],
  ] as const)(
    "promotes pins and included pinned actions only for empty queries in %s mode",
    (mode, expected) => {
      const frequent = item("frequent", "Frequent", "Owner", 3, {
        usageCount: 10_000,
        lastUsedAt: NOW,
      });
      const favorite = item("favorite", "Favorite", "Owner", 1, {
        favorite: true,
        usageCount: 3,
        lastUsedAt: NOW,
      });
      const parent = item("parent", "Parent", "Owner", 2);
      const command = savedAction("command", "parent", "Pinned command");

      for (const query of ["", "  \t\n  "]) {
        const results = ranked(
          [frequent, favorite, parent],
          actionMap(command),
          query,
          mode,
        );

        expect(results.map(({ id }) => id), JSON.stringify(query)).toEqual(
          expected,
        );
        expect(
          results.find(({ kind }) => kind === "action")?.favorite,
        ).toBe(false);
      }
    },
  );

  it.each([
    [
      "smart",
      ["item:plain", "action:parent:command", "item:boosted"],
    ],
    [
      "menuBar",
      ["item:plain", "action:parent:command", "item:boosted"],
    ],
    [
      "alphabetical",
      ["action:parent:command", "item:boosted", "item:plain"],
    ],
  ] as const)(
    "uses only relevance and the %s tie-breaker for non-empty searches",
    (mode, expected) => {
      const plain = item("plain", "Sync", "Owner", 0);
      const parent = item("parent", "OrbStack", "OrbStack", 1);
      const boosted = item("boosted", "Sync", "Owner", 2, {
        favorite: true,
        usageCount: 10_000,
        lastUsedAt: NOW,
      });
      const command = savedAction("command", "parent", "Sync", {
        usageCount: 10_000,
        lastUsedAt: NOW,
      });

      const results = ranked(
        [plain, parent, boosted],
        actionMap(command),
        "sync",
        mode,
      );

      expect(results.map(({ match }) => match?.score)).toEqual([
        results[0].match?.score,
        results[0].match?.score,
        results[0].match?.score,
      ]);
      expect(results.map(({ id }) => id)).toEqual(expected);
    },
  );
});

describe("labels, contexts, and stable IDs", () => {
  it("keeps concise labels without losing original provenance", () => {
    const parent = item("vpn", "Tailscale", "Tailscale Inc.", 4, {
      alias: "Work VPN",
    });
    const pause = savedAction("pause", "vpn", "Pause Syncing", {
      owner: "Tailscale Inc.",
      parentLabel: "Tailscale",
      alias: "Pause work",
      shortcut: "Command+Shift+P",
      action: {
        id: "native-pause",
        title: "Pause Syncing",
        path: [
          { title: "Connections", occurrence: 0 },
          { title: "Pause Syncing", occurrence: 0 },
        ],
        enabled: true,
        shortcut: null,
      },
    });

    expect(menuItemResultLabel(parent)).toBe("Work VPN");
    expect(menuItemResultContext(parent)).toBe("Tailscale · Tailscale Inc.");
    expect(savedActionResultLabel(pause)).toBe("Pause work");
    expect(savedActionResultContext(pause, parent)).toBe(
      "Pause Syncing · Work VPN › Connections · Tailscale Inc.",
    );
    expect(stableMenuItemResultId(parent)).toBe("item:vpn");
    expect(stableSavedActionResultId(pause)).toBe("action:vpn:pause");

    const results = ranked([parent], actionMap(pause), "", "menuBar");
    expect(results[0]).toMatchObject({
      kind: "action",
      label: "Pause work",
      originalLabel: "Pause Syncing",
      context: "Pause Syncing · Work VPN › Connections · Tailscale Inc.",
    });
    expect(results[1]).toMatchObject({
      kind: "item",
      label: "Work VPN",
      originalLabel: "Tailscale",
    });
  });

  it("hides native Macnu activation metadata from its visible label", () => {
    const macnu = item(
      "macnu",
      "Macnu — Command+Semicolon",
      "Macnu",
      0,
      { isMacnu: true },
    );
    expect(menuItemResultLabel(macnu)).toBe("Macnu");
    expect(menuItemResultContext(macnu)).toBeNull();
  });
});
