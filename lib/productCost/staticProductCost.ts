/**
 * Static ProductCost contract helpers.
 * costDate is technical upload/create timestamp, NOT effective-from.
 * One normalized vendorCode -> one canonical costPrice.
 */

export function normalizeProductCostVendor(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export type ProductCostLike = {
  vendorCode: string;
  costPrice: number;
  costDate?: Date | string | null;
  nmId?: string | null;
  name?: string | null;
};

/**
 * Collapse import rows to one canonical cost per normalized vendor.
 * Deterministic: last row in input wins for conflicting prices.
 */
export function collapseProductCostsByNormalizedVendor<T extends ProductCostLike>(
  rows: T[]
): T[] {
  const byNorm = new Map<string, T>();

  for (const row of rows) {
    const key = normalizeProductCostVendor(row.vendorCode);
    if (!key) continue;
    byNorm.set(key, row);
  }

  return Array.from(byNorm.values());
}

/**
 * Production static resolver: costs must already be ordered by costDate desc.
 * First normalizeText(vendorCode) wins. No sale-date filtering.
 */
export function buildStaticCostByVendorCode(
  costsOrderedByCostDateDesc: Array<{
    vendorCode: unknown;
    costPrice: unknown;
  }>
): Map<string, number> {
  const map = new Map<string, number>();

  for (const cost of costsOrderedByCostDateDesc) {
    const vendorCode = normalizeProductCostVendor(cost.vendorCode);
    if (!vendorCode) continue;

    if (!map.has(vendorCode)) {
      const n = Number(cost.costPrice);
      map.set(vendorCode, Number.isFinite(n) ? n : 0);
    }
  }

  return map;
}

export function resolveStaticCostPrice(
  costByVendorCode: Map<string, number>,
  vendorCode: unknown
): number {
  const key = normalizeProductCostVendor(vendorCode);
  if (!key) return 0;
  return costByVendorCode.get(key) ?? 0;
}
