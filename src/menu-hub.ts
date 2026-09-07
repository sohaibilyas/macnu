export type PaletteLayout = "list" | "grid";

export function parsePaletteLayout(value: string | null): PaletteLayout {
  return value === "grid" ? "grid" : "list";
}

/** Preserve menu labels unless they clearly contain a live measurement. */
export function menuStatus(label: string, owner: string): string | null {
  if (!owner.trim() || label.trim().toLowerCase() === owner.trim().toLowerCase()) return null;
  // System processes own several distinct controls; keep those controls named.
  if (/^(Control Cent(?:er|re)|SystemUIServer)$/i.test(owner.trim())) return null;
  return /\d(?:[.,]\d+)?\s*(?:%|°[CF]|[KMGT]?B\s*\/\s*s|[KMGT]?Bps|rpm|MHz|GHz)\b|\d\s*%/i.test(label)
    ? label.trim()
    : null;
}

export function gridSelection(index: number, key: string, count: number, columns: number): number {
  if (count < 1) return 0;
  const stride = Math.max(1, columns);
  const delta = key === "ArrowDown" ? stride : key === "ArrowUp" ? -stride : key === "ArrowRight" ? 1 : -1;
  return Math.max(0, Math.min(count - 1, index + delta));
}
