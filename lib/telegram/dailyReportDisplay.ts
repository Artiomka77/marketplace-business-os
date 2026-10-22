/**
 * Display/readiness helpers for DailyReport marketplace metrics.
 * Kept outside sealed dailyReport.ts (Financial Core) so seal hashes stay intact.
 */

export type MarketplaceFinancialAvailability = {
  financialUnavailable?: boolean;
};

export function isMarketplaceFinancialUnavailable(metrics: unknown): boolean {
  if (!metrics || typeof metrics !== "object") return false;
  return (
    (metrics as MarketplaceFinancialAvailability).financialUnavailable === true
  );
}

export function asMarketplaceFinancialAvailability<T>(
  metrics: T
): T & MarketplaceFinancialAvailability {
  return metrics as T & MarketplaceFinancialAvailability;
}

/** Sealed DailyReport marketplace metrics + optional runtime display fields. */
export type MarketplaceMetricsView = {
  financialUnavailable?: boolean;
  netProfitUnavailable?: boolean;
  totalCost?: number | null;
  economicTurnover?: number | null;
  salesAmount?: number | null;
  taxableRevenue?: number | null;
  netProfitAfterTax?: number | null;
  adSpend?: number | null;
  ordersQty?: number | null;
  ordersAmount?: number | null;
  drrByEconomicTurnover?: number | null;
  stockQty?: number | null;
  ozonMissingEvidence?: string | null;
  [key: string]: unknown;
};

export function asMarketplaceMetricsView(metrics: unknown): MarketplaceMetricsView {
  return (metrics ?? {}) as MarketplaceMetricsView;
}
