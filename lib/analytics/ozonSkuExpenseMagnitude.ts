/**
 * Display helper for Ozon SKU expense magnitude.
 * Kept outside sealed profitAnalyticsOzon.ts (Financial Core V5/V6).
 * Formula matches the historical sealed-era helper: sum of known cost legs.
 */
export function calculateOzonSkuExpenseMagnitude(row: {
  totalCost?: number | null;
  wbCommission?: number | null;
  logisticsCost?: number | null;
  adsCost?: number | null;
  penaltiesAmount?: number | null;
  deductions?: number | null;
  taxesAmount?: number | null;
}): number {
  const n = (v: number | null | undefined) => {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? x : 0;
  };
  return (
    n(row.totalCost) +
    n(row.wbCommission) +
    n(row.logisticsCost) +
    n(row.adsCost) +
    n(row.penaltiesAmount) +
    n(row.deductions) +
    n(row.taxesAmount)
  );
}
