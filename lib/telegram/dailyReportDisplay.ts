/**
 * Display/readiness helpers for DailyReport marketplace metrics.
 * Kept outside sealed dailyReport.ts (Financial Core) so seal hashes stay intact.
 */

export type MarketplaceFinancialAvailability = {
  financialUnavailable?: boolean;
};

export function isMarketplaceFinancialUnavailable(
  metrics: MarketplaceFinancialAvailability | null | undefined
): boolean {
  return metrics?.financialUnavailable === true;
}

export function asMarketplaceFinancialAvailability<T extends object>(
  metrics: T
): T & MarketplaceFinancialAvailability {
  return metrics as T & MarketplaceFinancialAvailability;
}
