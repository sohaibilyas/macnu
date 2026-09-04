export type RankingMode = "smart" | "menuBar" | "alphabetical";

export type PersonalizableMenuItem = {
  itemId?: string | null;
  label: string;
  owner: string;
  nativeOrder?: number;
  alias?: string | null;
  favorite?: boolean;
  usageCount?: number;
  lastUsedAt?: number | null;
};

export type ItemPreference = {
  alias?: string | null;
  favorite?: boolean;
  usageCount?: number;
  lastUsedAt?: number | null;
};

export type ItemPreferenceMap = Readonly<
  Record<string, Readonly<ItemPreference> | undefined>
>;

export type PersonalizedMenuItem<T extends PersonalizableMenuItem> = {
  /** The untouched catalog row. Personalization never replaces native data. */
  item: T;
  itemId: string | null;
  originalLabel: string;
  owner: string;
  alias: string | null;
  displayLabel: string;
  favorite: boolean;
  usageCount: number;
  lastUsedAt: number | null;
  nativeOrder: number;
};

export type SearchMatchKind = "exact" | "prefix" | "substring";
export type SearchField = "alias" | "label" | "owner";

export type SearchMatch = {
  kind: SearchMatchKind;
  field: SearchField;
  relevance: 1 | 2 | 3;
};

export type RankOptions = {
  query: string;
  mode: RankingMode;
  /** Injected to keep smart ranking deterministic and straightforward to test. */
  now: number;
};

const MAX_TRACKED_USAGE_COUNT = 10_000;
const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const alphabeticalCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

function normalizedSearchValue(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function normalizedItemId(itemId: string | null | undefined): string | null {
  if (typeof itemId !== "string") return null;
  const trimmed = itemId.trim();
  return trimmed.length ? trimmed : null;
}

function normalizedAlias(alias: string | null | undefined): string | null {
  if (typeof alias !== "string") return null;
  const trimmed = alias.trim();
  return trimmed.length ? trimmed : null;
}

function normalizedUsageCount(usageCount: number | undefined): number {
  if (!Number.isFinite(usageCount) || usageCount === undefined) return 0;
  return Math.min(MAX_TRACKED_USAGE_COUNT, Math.max(0, usageCount));
}

function normalizedLastUsedAt(lastUsedAt: number | null | undefined): number | null {
  return typeof lastUsedAt === "number" && Number.isFinite(lastUsedAt)
    ? lastUsedAt
    : null;
}

function preferenceFor(
  itemId: string | null,
  preferences: ItemPreferenceMap,
): Readonly<ItemPreference> | undefined {
  if (!itemId || !Object.prototype.hasOwnProperty.call(preferences, itemId)) {
    return undefined;
  }
  return preferences[itemId];
}

function preferredValue<T>(stored: T | undefined, inline: T | undefined): T | undefined {
  return stored === undefined ? inline : stored;
}

export function getDisplayLabel(
  item: Pick<PersonalizableMenuItem, "label" | "alias">,
  preference?: Pick<ItemPreference, "alias">,
): string {
  return normalizedAlias(preferredValue(preference?.alias, item.alias)) ?? item.label;
}

export function getSecondaryContext(
  item: Pick<
    PersonalizedMenuItem<PersonalizableMenuItem>,
    "alias" | "displayLabel" | "originalLabel" | "owner"
  >,
): string | null {
  const seen = new Set([normalizedSearchValue(item.displayLabel)]);
  const candidates = item.alias
    ? [item.originalLabel, item.owner]
    : [item.owner];
  const usefulParts: string[] = [];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const normalized = normalizedSearchValue(trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    usefulParts.push(trimmed);
  }

  return usefulParts.length ? usefulParts.join(" · ") : null;
}

/**
 * Attaches preferences only to catalog rows that currently exist. Iterating the
 * catalog (rather than the preference map) prevents stale IDs from creating UI rows.
 */
export function personalizeMenuItems<T extends PersonalizableMenuItem>(
  items: readonly T[],
  preferences: ItemPreferenceMap = {},
): PersonalizedMenuItem<T>[] {
  return items.map((item, sourceIndex) => {
    const itemId = normalizedItemId(item.itemId);
    const preference = preferenceFor(itemId, preferences);
    const alias = normalizedAlias(preferredValue(preference?.alias, item.alias));
    const nativeOrder = Number.isFinite(item.nativeOrder)
      ? (item.nativeOrder as number)
      : sourceIndex;

    return {
      item,
      itemId,
      originalLabel: item.label,
      owner: item.owner,
      alias,
      displayLabel: alias ?? item.label,
      favorite: preferredValue(preference?.favorite, item.favorite) === true,
      usageCount: normalizedUsageCount(
        preferredValue(preference?.usageCount, item.usageCount),
      ),
      lastUsedAt: normalizedLastUsedAt(
        preferredValue(preference?.lastUsedAt, item.lastUsedAt),
      ),
      nativeOrder,
    };
  });
}

export function findSearchMatch<T extends PersonalizableMenuItem>(
  item: PersonalizedMenuItem<T>,
  query: string,
): SearchMatch | null {
  const normalizedQuery = normalizedSearchValue(query);
  if (!normalizedQuery) return null;

  const fields: readonly [SearchField, string | null][] = [
    ["alias", item.alias],
    ["label", item.originalLabel],
    ["owner", item.owner],
  ];

  for (const kind of ["exact", "prefix", "substring"] as const) {
    for (const [field, rawValue] of fields) {
      if (!rawValue) continue;
      const value = normalizedSearchValue(rawValue);
      const matches =
        kind === "exact"
          ? value === normalizedQuery
          : kind === "prefix"
            ? value.startsWith(normalizedQuery)
            : value.includes(normalizedQuery);
      if (matches) {
        return {
          kind,
          field,
          relevance: kind === "exact" ? 3 : kind === "prefix" ? 2 : 1,
        };
      }
    }
  }

  return null;
}

export function filterPersonalizedItems<T extends PersonalizableMenuItem>(
  items: readonly PersonalizedMenuItem<T>[],
  query: string,
): PersonalizedMenuItem<T>[] {
  if (!normalizedSearchValue(query)) return [...items];
  return items.filter((item) => findSearchMatch(item, query) !== null);
}

/** A bounded 0…1 score: logarithmic frequency plus recency over 30 days. */
export function smartUsageScore(
  usage: Pick<
    PersonalizedMenuItem<PersonalizableMenuItem>,
    "usageCount" | "lastUsedAt"
  >,
  now: number,
): number {
  const usageCount = normalizedUsageCount(usage.usageCount);
  const frequency =
    Math.log1p(usageCount) / Math.log1p(MAX_TRACKED_USAGE_COUNT);

  const lastUsedAt = normalizedLastUsedAt(usage.lastUsedAt);
  const recency =
    lastUsedAt === null || !Number.isFinite(now)
      ? 0
      : Math.max(0, 1 - Math.max(0, now - lastUsedAt) / RECENCY_WINDOW_MS);

  return Math.min(1, Math.max(0, frequency * 0.6 + recency * 0.4));
}

function stableId<T extends PersonalizableMenuItem>(
  item: PersonalizedMenuItem<T>,
): string {
  return item.itemId ?? `${item.owner}\u0000${item.originalLabel}`;
}

function compareNativeThenId<T extends PersonalizableMenuItem>(
  left: PersonalizedMenuItem<T>,
  right: PersonalizedMenuItem<T>,
): number {
  const nativeDifference = left.nativeOrder - right.nativeOrder;
  if (nativeDifference !== 0) return nativeDifference;

  const leftId = stableId(left);
  const rightId = stableId(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

export function rankPersonalizedItems<T extends PersonalizableMenuItem>(
  items: readonly T[],
  preferences: ItemPreferenceMap,
  options: RankOptions,
): PersonalizedMenuItem<T>[] {
  const query = normalizedSearchValue(options.query);
  const personalized = personalizeMenuItems(items, preferences);
  const matches = personalized
    .map((item) => ({ item, match: query ? findSearchMatch(item, query) : null }))
    .filter(({ match }) => !query || match !== null);

  matches.sort((left, right) => {
    if (query) {
      const relevanceDifference =
        (right.match?.relevance ?? 0) - (left.match?.relevance ?? 0);
      if (relevanceDifference !== 0) return relevanceDifference;
    }

    if (!query) {
      const favoriteDifference =
        Number(right.item.favorite) - Number(left.item.favorite);
      if (favoriteDifference !== 0) return favoriteDifference;

      if (options.mode === "smart") {
        const smartDifference =
          smartUsageScore(right.item, options.now) -
          smartUsageScore(left.item, options.now);
        if (smartDifference !== 0) return smartDifference;
      }
    }

    if (options.mode === "alphabetical") {
      const alphabeticalDifference = alphabeticalCollator.compare(
        left.item.displayLabel,
        right.item.displayLabel,
      );
      if (alphabeticalDifference !== 0) return alphabeticalDifference;
    }

    return compareNativeThenId(left.item, right.item);
  });

  return matches.map(({ item }) => item);
}
