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
