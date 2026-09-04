export type InstantCommandRankingMode = "smart" | "menuBar" | "alphabetical";

export type LiveMenuItemView = {
  itemId?: string | null;
  label: string;
  owner: string;
  nativeOrder?: number;
  alias?: string | null;
  hidden?: boolean;
  favorite?: boolean;
  usageCount?: number;
  lastUsedAt?: number | null;
  isMacnu?: boolean;
};

export type SavedActionPathSegment = {
  title: string;
  occurrence: number;
};

export type SavedActionDefinition = {
  id: string;
  title: string;
  path: readonly SavedActionPathSegment[];
  enabled: boolean;
  shortcut: string | null;
};

/** The camel-cased shape returned in CatalogCustomizationsResponse.savedActions. */
export type SavedActionView = {
  id: string;
  parentItemId: string;
  owner: string;
  parentLabel: string;
  action: SavedActionDefinition;
  alias: string | null;
  shortcut: string | null;
  usageCount: number;
  lastUsedAt: number | null;
};

export type SavedActionMap = Readonly<
  Record<string, Readonly<SavedActionView> | undefined>
>;

export type PaletteSearchField = "alias" | "title" | "owner" | "path";
export type PaletteSearchMatchKind =
  | "exact"
  | "prefix"
  | "token"
  | "acronym"
  | "fuzzy";

export type PaletteSearchMatch = {
  kind: PaletteSearchMatchKind;
  field: PaletteSearchField;
  /** Higher is more relevant. Useful for diagnostics; callers should not persist it. */
  score: number;
};

type PaletteResultBase = {
  id: string;
  label: string;
  originalLabel: string;
  owner: string;
  context: string | null;
  favorite: boolean;
  usageCount: number;
  lastUsedAt: number | null;
  nativeOrder: number;
  match: PaletteSearchMatch | null;
};

export type MenuItemPaletteResult<TItem extends LiveMenuItemView> =
  PaletteResultBase & {
    kind: "item";
    item: TItem;
    itemId: string | null;
  };

export type SavedActionPaletteResult<TItem extends LiveMenuItemView> =
  PaletteResultBase & {
    kind: "action";
    parent: TItem;
    parentItemId: string;
    savedAction: Readonly<SavedActionView>;
  };

export type PaletteResult<TItem extends LiveMenuItemView = LiveMenuItemView> =
  | MenuItemPaletteResult<TItem>
  | SavedActionPaletteResult<TItem>;

export type BuildPaletteResultsOptions = {
  query: string;
  mode: InstantCommandRankingMode;
  /** Unix milliseconds. Backend second timestamps are normalized automatically. */
  now: number;
  /** Caps the returned rows, not the rows considered. Defaults to 250, max 500. */
  limit?: number;
  /** Root search keeps actions inside their parent by default. */
  includeSavedActions?: boolean;
};

const MAX_OUTPUT_RESULTS = 500;
const DEFAULT_OUTPUT_RESULTS = 250;
const MAX_SEARCH_CHARACTERS = 192;
const MAX_FIELD_CHARACTERS = 384;
const MAX_QUERY_TOKENS = 8;
const MAX_FIELD_TOKENS = 24;
const MAX_TOKEN_CHARACTERS = 48;
const MAX_TRACKED_USAGE_COUNT = 10_000;
const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

const alphabeticalCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export type PaletteSearchFacet = {
  field: PaletteSearchField;
  value: string;
};

function trimmed(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalized(value: string, maximum = MAX_FIELD_CHARACTERS): string {
  return value
    .slice(0, maximum)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(value: string, maximum: number): string[] {
  if (!value) return [];
  return value
    .split(" ")
    .slice(0, maximum)
    .map((token) => token.slice(0, MAX_TOKEN_CHARACTERS))
    .filter(Boolean);
}

function itemIdOf(item: LiveMenuItemView): string | null {
  return trimmed(item.itemId) || null;
}

function nativeOrderOf(item: LiveMenuItemView, fallback: number): number {
  return typeof item.nativeOrder === "number" && Number.isFinite(item.nativeOrder)
    ? item.nativeOrder
    : fallback;
}

function usageCountOf(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(MAX_TRACKED_USAGE_COUNT, Math.max(0, value));
}

function timestampMilliseconds(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  // Rust views use Unix seconds while frontend personalization uses milliseconds.
  return value < 100_000_000_000 ? value * 1_000 : value;
}

function stablePart(value: string): string {
  return encodeURIComponent(value.normalize("NFC").trim());
}

export function stableMenuItemResultId(
  item: LiveMenuItemView,
  fallbackOrder = 0,
): string {
  const itemId = itemIdOf(item);
  if (itemId) return `item:${stablePart(itemId)}`;
  return `item:fallback:${stablePart(item.owner)}:${stablePart(item.label)}:${nativeOrderOf(
    item,
    fallbackOrder,
  )}`;
}

export function stableSavedActionResultId(
  action: Pick<SavedActionView, "id" | "parentItemId">,
): string {
  return `action:${stablePart(action.parentItemId)}:${stablePart(action.id)}`;
}

export function menuItemResultLabel(item: LiveMenuItemView): string {
  if (item.isMacnu) return "Macnu";
  return trimmed(item.alias) || item.label;
}

export function savedActionResultLabel(action: SavedActionView): string {
  return trimmed(action.alias) || action.action.title;
}

function uniqueContext(parts: readonly string[], displayLabel: string): string[] {
  const seen = new Set([normalized(displayLabel)]);
  return parts.flatMap((part) => {
    const value = trimmed(part);
    const key = normalized(value);
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [value];
  });
}

export function menuItemResultContext(item: LiveMenuItemView): string | null {
  if (item.isMacnu) return null;
  const label = menuItemResultLabel(item);
  const parts = trimmed(item.alias)
    ? [item.label, item.owner]
    : [item.owner];
  const context = uniqueContext(parts, label);
  return context.length ? context.join(" · ") : null;
}

function actionParentPath(action: SavedActionView): string[] {
  const path = action.action.path.map(({ title }) => trimmed(title)).filter(Boolean);
  if (
    path.length &&
    normalized(path[path.length - 1]) === normalized(action.action.title)
  ) {
    path.pop();
  }
  return path;
}

export function savedActionResultContext(
  action: SavedActionView,
  parent?: LiveMenuItemView,
): string | null {
  const label = savedActionResultLabel(action);
  const originalTitle = trimmed(action.alias) ? action.action.title : "";
  const parentLabel = parent ? menuItemResultLabel(parent) : action.parentLabel;
  const hierarchy = uniqueContext(actionParentPath(action), parentLabel);
  const parentPath = [parentLabel, ...hierarchy].filter(Boolean).join(" › ");
  const context = uniqueContext(
    [originalTitle, parentPath, action.owner],
    label,
  );
  return context.length ? context.join(" · ") : null;
}

/** Banded Damerau-Levenshtein check; query and field tokens are already capped. */
function editDistanceAtMost(left: string, right: string, threshold: number): number | null {
  if (left === right) return 0;
  if (threshold <= 0 || Math.abs(left.length - right.length) > threshold) return null;

  let previousPrevious: number[] | null = null;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = new Array<number>(right.length + 1).fill(threshold + 1);
    current[0] = leftIndex;
    const start = Math.max(1, leftIndex - threshold);
    const end = Math.min(right.length, leftIndex + threshold);
    let rowMinimum = threshold + 1;

    for (let rightIndex = start; rightIndex <= end; rightIndex += 1) {
      const substitution =
        previous[rightIndex - 1] +
        Number(left[leftIndex - 1] !== right[rightIndex - 1]);
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        substitution,
      );
      if (
        previousPrevious &&
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        current[rightIndex] = Math.min(
          current[rightIndex],
          previousPrevious[rightIndex - 2] + 1,
        );
      }
      rowMinimum = Math.min(rowMinimum, current[rightIndex]);
    }

    if (rowMinimum > threshold) return null;
    previousPrevious = previous;
    previous = current;
  }

  const distance = previous[right.length];
  return distance <= threshold ? distance : null;
}

function typoThreshold(token: string): number {
  if (token.length >= 8) return 2;
  if (token.length >= 4) return 1;
  return 0;
}

function tokenMatch(
  queryTokens: readonly string[],
  candidateTokens: readonly string[],
): { kind: "token" | "fuzzy"; penalty: number } | null {
  if (!queryTokens.length || queryTokens.length > candidateTokens.length) return null;
  const available = new Set(candidateTokens.map((_, index) => index));
  let fuzzy = false;
  let penalty = 0;

  // Most specific tokens claim candidates first, making reordered matching stable.
  const orderedQueries = [...queryTokens].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
  for (const queryToken of orderedQueries) {
    let best: { index: number; tier: number; penalty: number } | null = null;
    for (const index of available) {
      const candidate = candidateTokens[index];
      let tier = 0;
      let candidatePenalty = 0;
      if (candidate === queryToken) {
        tier = 3;
      } else if (candidate.startsWith(queryToken)) {
        tier = 2;
        candidatePenalty = candidate.length - queryToken.length;
      } else {
        const threshold = typoThreshold(queryToken);
        const distance = editDistanceAtMost(queryToken, candidate, threshold);
        if (distance === null) continue;
        tier = 1;
        candidatePenalty = distance * 4 + Math.abs(candidate.length - queryToken.length);
      }
      if (
        !best ||
        tier > best.tier ||
        (tier === best.tier && candidatePenalty < best.penalty) ||
        (tier === best.tier && candidatePenalty === best.penalty && index < best.index)
      ) {
        best = { index, tier, penalty: candidatePenalty };
      }
    }
    if (!best) return null;
    available.delete(best.index);
    fuzzy ||= best.tier === 1;
    penalty += best.penalty;
  }

  return { kind: fuzzy ? "fuzzy" : "token", penalty };
}

const fieldWeight: Record<PaletteSearchField, number> = {
  alias: 400,
  title: 300,
  owner: 200,
  path: 100,
};

function matchFacet(
  facet: PaletteSearchFacet,
  query: string,
  queryTokens: readonly string[],
): PaletteSearchMatch | null {
  const value = normalized(facet.value);
  if (!value) return null;
  const weight = fieldWeight[facet.field];
  if (value === query) return { kind: "exact", field: facet.field, score: 100_000 + weight };
  if (value.startsWith(query)) {
    return {
      kind: "prefix",
      field: facet.field,
      score: 90_000 + weight - Math.min(200, value.length - query.length),
    };
  }

  const valueTokens = tokens(value, MAX_FIELD_TOKENS);
  const tokenResult = tokenMatch(queryTokens, valueTokens);
  if (tokenResult) {
    const base = tokenResult.kind === "token" ? 80_000 : 60_000;
    return {
      kind: tokenResult.kind,
      field: facet.field,
      score: base + weight - Math.min(500, tokenResult.penalty),
    };
  }

  if (queryTokens.length === 1 && value.includes(query)) {
    return {
      kind: "fuzzy",
      field: facet.field,
      score: 70_000 + weight - Math.min(500, value.indexOf(query)),
    };
  }

  if (queryTokens.length === 1 && query.length >= 2) {
    const acronym = valueTokens.map((token) => token[0] ?? "").join("");
    if (acronym.startsWith(query)) {
      return {
        kind: "acronym",
        field: facet.field,
        score: 65_000 + weight - Math.min(200, acronym.length - query.length),
      };
    }
  }

  return null;
}

export function findPaletteSearchMatch(
  facets: readonly PaletteSearchFacet[],
  rawQuery: string,
): PaletteSearchMatch | null {
  const query = normalized(rawQuery, MAX_SEARCH_CHARACTERS);
  if (!query) return null;
  const queryTokens = tokens(query, MAX_QUERY_TOKENS);
  let best: PaletteSearchMatch | null = null;
  for (const facet of facets) {
    const match = matchFacet(facet, query, queryTokens);
    if (
      match &&
      (!best ||
        match.score > best.score ||
        (match.score === best.score && match.field < best.field))
    ) {
      best = match;
    }
  }
  return best;
}

function itemFacets(item: LiveMenuItemView): PaletteSearchFacet[] {
  return [
    ...(trimmed(item.alias) ? [{ field: "alias" as const, value: item.alias! }] : []),
    { field: "title", value: item.label },
    { field: "owner", value: item.owner },
  ];
}

function actionFacets(
  action: SavedActionView,
  parent: LiveMenuItemView,
): PaletteSearchFacet[] {
  const path = [
    action.parentLabel,
    ...action.action.path.map(({ title }) => title),
  ].filter(Boolean);
  return [
    ...(trimmed(action.alias)
      ? [{ field: "alias" as const, value: action.alias! }]
      : []),
    ...(trimmed(parent.alias)
      ? [{ field: "alias" as const, value: parent.alias! }]
      : []),
    { field: "title", value: action.action.title },
    { field: "owner", value: action.owner },
    ...path.map((value) => ({ field: "path" as const, value })),
    { field: "path", value: path.join(" ") },
  ];
}

function smartUsageScore(result: PaletteResult, now: number): number {
  const frequency =
    Math.log1p(result.usageCount) / Math.log1p(MAX_TRACKED_USAGE_COUNT);
  const lastUsedAt = timestampMilliseconds(result.lastUsedAt);
  const recency =
    lastUsedAt === null || !Number.isFinite(now)
      ? 0
      : Math.max(0, 1 - Math.max(0, now - lastUsedAt) / RECENCY_WINDOW_MS);
  return Math.min(1, Math.max(0, frequency * 0.6 + recency * 0.4));
}

function compareStable(left: PaletteResult, right: PaletteResult): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function compareMenuBar(left: PaletteResult, right: PaletteResult): number {
  const orderDifference = left.nativeOrder - right.nativeOrder;
  if (orderDifference !== 0) return orderDifference;
  if (left.kind !== right.kind) return left.kind === "item" ? -1 : 1;
  if (left.kind === "action" && right.kind === "action") {
    const labelDifference = alphabeticalCollator.compare(left.label, right.label);
    if (labelDifference !== 0) return labelDifference;
  }
  return compareStable(left, right);
}

function compareResults(
  left: PaletteResult,
  right: PaletteResult,
  options: BuildPaletteResultsOptions,
  hasQuery: boolean,
): number {
  const relevanceDifference = (right.match?.score ?? 0) - (left.match?.score ?? 0);
  if (relevanceDifference !== 0) return relevanceDifference;

  if (!hasQuery) {
    const promotedDifference =
      Number(right.kind === "action" || right.favorite) -
      Number(left.kind === "action" || left.favorite);
    if (promotedDifference !== 0) return promotedDifference;

    if (options.mode === "smart") {
      const usageDifference =
        smartUsageScore(right, options.now) - smartUsageScore(left, options.now);
      if (usageDifference !== 0) return usageDifference;
    }
  }

  if (options.mode === "alphabetical") {
    const labelDifference = alphabeticalCollator.compare(left.label, right.label);
    if (labelDifference !== 0) return labelDifference;
    return compareStable(left, right);
  }

  return compareMenuBar(left, right);
}

/**
 * Produces one palette model from live menu rows and the saved-action map.
 * Hidden live rows are omitted as ordinary item results, but remain valid
 * parents for pinned actions. Only pinned actions whose stable parent is absent
 * from the live catalog are excluded.
 */
export function buildPaletteResults<TItem extends LiveMenuItemView>(
  liveItems: readonly TItem[],
  savedActions: SavedActionMap,
  options: BuildPaletteResultsOptions,
): PaletteResult<TItem>[] {
  const query = normalized(options.query, MAX_SEARCH_CHARACTERS);
  const results: PaletteResult<TItem>[] = [];
  const liveParents = new Map<string, { item: TItem; nativeOrder: number }>();
  const seenResultIds = new Set<string>();

  liveItems.forEach((item, sourceIndex) => {
    const nativeOrder = nativeOrderOf(item, sourceIndex);
    const itemId = itemIdOf(item);
    if (itemId && !liveParents.has(itemId)) {
      liveParents.set(itemId, { item, nativeOrder });
    }
    // Hiding removes only the ordinary root row. A pinned action still needs
    // its live parent as the execution/validation target.
    if (item.hidden) return;

    const id = stableMenuItemResultId(item, sourceIndex);
    if (seenResultIds.has(id)) return;
    const match = query ? findPaletteSearchMatch(itemFacets(item), query) : null;
    if (query && !match) return;
    seenResultIds.add(id);
    results.push({
      kind: "item",
      id,
      item,
      itemId,
      label: menuItemResultLabel(item),
      originalLabel: item.label,
      owner: item.owner,
      context: menuItemResultContext(item),
      favorite: item.favorite === true,
      usageCount: usageCountOf(item.usageCount),
      lastUsedAt: timestampMilliseconds(item.lastUsedAt),
      nativeOrder,
      match,
    });
  });

  const includedSavedActions = options.includeSavedActions ? savedActions : {};

  for (const [mapKey, action] of Object.entries(includedSavedActions).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    if (!action) continue;
    const parentItemId = trimmed(action.parentItemId);
    const parent = liveParents.get(parentItemId);
    if (!parent) continue;
    const actionId = trimmed(action.id) || trimmed(mapKey);
    if (!actionId) continue;
    const id = stableSavedActionResultId({ id: actionId, parentItemId });
    if (seenResultIds.has(id)) continue;
    const match = query
      ? findPaletteSearchMatch(actionFacets(action, parent.item), query)
      : null;
    if (query && !match) continue;
    seenResultIds.add(id);
    results.push({
      kind: "action",
      id,
      parent: parent.item,
      parentItemId,
      savedAction: action,
      label: savedActionResultLabel(action),
      originalLabel: action.action.title,
      owner: action.owner,
      context: savedActionResultContext(action, parent.item),
      favorite: false,
      usageCount: usageCountOf(action.usageCount),
      lastUsedAt: timestampMilliseconds(action.lastUsedAt),
      nativeOrder: parent.nativeOrder,
      match,
    });
  }

  results.sort((left, right) =>
    compareResults(left, right, options, query.length > 0),
  );
  const requestedLimit = Number.isFinite(options.limit)
    ? Math.floor(options.limit as number)
    : DEFAULT_OUTPUT_RESULTS;
  const limit = Math.max(0, Math.min(MAX_OUTPUT_RESULTS, requestedLimit));
  return results.slice(0, limit);
}
