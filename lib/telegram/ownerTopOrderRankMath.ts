/**
 * Pure ranking/merge math for Telegram TOP orders (no I/O).
 */

export type OrderUniverseRow = {
  identityKey: string;
  exactFamilyKey: string | null;
  label: string;
  companyName: string;
  marketplace: "WB" | "OZON";
  qty: number;
  amount: number;
  sku: string | null;
  imageUrl: string | null;
};

/**
 * Exact ALL merge: only rows sharing exactFamilyKey merge.
 * Same display label without exact family → stay separate.
 */
export function mergeOrderUniverseExactFamily(
  rows: OrderUniverseRow[],
): OrderUniverseRow[] {
  const map = new Map<string, OrderUniverseRow>();
  for (const row of rows) {
    const key = row.exactFamilyKey
      ? `ALL|FAMILY|${row.exactFamilyKey}`
      : row.identityKey;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        ...row,
        identityKey: key,
        companyName: row.exactFamilyKey ? "Весь бизнес" : row.companyName,
      });
    } else {
      prev.qty += row.qty;
      prev.amount += row.amount;
      if (!prev.imageUrl && row.imageUrl) prev.imageUrl = row.imageUrl;
      if (prev.exactFamilyKey) {
        prev.label = row.label || prev.label;
      }
    }
  }
  return [...map.values()];
}

export function sortOrderUniverse(
  rows: OrderUniverseRow[],
  criterion: "amt" | "qty",
): OrderUniverseRow[] {
  return [...rows].sort((a, b) => {
    if (criterion === "amt") {
      return (
        b.amount - a.amount ||
        b.qty - a.qty ||
        a.identityKey.localeCompare(b.identityKey)
      );
    }
    return (
      b.qty - a.qty ||
      b.amount - a.amount ||
      a.identityKey.localeCompare(b.identityKey)
    );
  });
}

/** Exact ALL margin: mergedProfit / mergedTurnover * 100 (never weighted row %). */
export function derivedMarginPct(
  profit: number,
  turnover: number,
): number | null {
  if (!Number.isFinite(turnover) || Math.abs(turnover) < 0.0001) return null;
  return (profit / turnover) * 100;
}
