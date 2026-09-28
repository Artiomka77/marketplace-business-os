export type MarketplaceRevenueFields = {
  economicTurnover?: number | null;
  salesAmount?: number | null;
  taxableRevenue?: number | null;
  financialUnavailable?: boolean;
};

export function marketplaceManagementRevenue(
  metrics: MarketplaceRevenueFields | null | undefined
): number | null {
  if (!metrics) return null;
  if (metrics.financialUnavailable) return null;
  if (
    metrics.economicTurnover != null &&
    Number.isFinite(Number(metrics.economicTurnover))
  ) {
    return Number(metrics.economicTurnover);
  }
  if (metrics.salesAmount == null) return null;
  const sales = Number(metrics.salesAmount);
  return Number.isFinite(sales) ? sales : null;
}

export function combinedManagementRevenue(
  wb: MarketplaceRevenueFields | null | undefined,
  ozon: MarketplaceRevenueFields | null | undefined
): number | null {
  const wbRevenue = marketplaceManagementRevenue(wb);
  const ozonRevenue = marketplaceManagementRevenue(ozon);
  if (wbRevenue == null || ozonRevenue == null) return null;
  return wbRevenue + ozonRevenue;
}

export function drrPercent(adsCost: number, revenue: number): number | null {
  return revenue > 0 ? (adsCost / revenue) * 100 : null;
}

export function marketplaceSharePercent(
  part: number,
  total: number
): number | null {
  return total > 0 ? (part / total) * 100 : null;
}

export function financialDynamicsMayShowNumericClaim(input: {
  marketplaceTotalIncomplete: boolean;
  totalRevenue: number | null;
}) {
  return input.marketplaceTotalIncomplete !== true && input.totalRevenue != null;
}

export function sanitizeLegacyCompanyFinancialRow<T extends {
  ozonRevenue: number | null;
  wbRevenue: number | null;
  totalRevenue: number | null;
  operatingProfitAfterTax: number | null;
  netProfit: number | null;
  profitAfterOwnerWithdrawal: number | null;
  drr: number | null;
  ozonCoverageComplete?: boolean;
}>(row: T): T {
  const legacyFakeZero =
    row.ozonCoverageComplete === false &&
    row.ozonRevenue === 0 &&
    row.wbRevenue != null &&
    row.totalRevenue === row.wbRevenue;
  if (!legacyFakeZero) return row;
  return {
    ...row,
    ozonRevenue: null,
    totalRevenue: null,
    operatingProfitAfterTax: null,
    netProfit: null,
    profitAfterOwnerWithdrawal: null,
    drr: null,
  };
}

export function storedFinite(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function rollUpPlanFactMarketplace(input: {
  periodUnavailable: boolean;
  wbRevenue?: unknown;
  ozonRevenue?: unknown;
  totalRevenue?: unknown;
  operatingProfitAfterTax?: unknown;
}) {
  if (input.periodUnavailable) {
    return {
      wbRevenue: null,
      ozonRevenue: null,
      marketplaceRevenue: null,
      operatingProfit: null,
    };
  }
  const wbRevenue = storedFinite(input.wbRevenue);
  const ozonRevenue = storedFinite(input.ozonRevenue);
  const operatingProfit = storedFinite(input.operatingProfitAfterTax);
  const storedTotal = storedFinite(input.totalRevenue);
  const marketplaceRevenue =
    wbRevenue == null || ozonRevenue == null || storedTotal == null
      ? null
      : storedTotal;
  return { wbRevenue, ozonRevenue, marketplaceRevenue, operatingProfit };
}

export function snapshotCombinedProfit(input: {
  wbFinancialUnavailable?: boolean;
  ozonFinancialUnavailable?: boolean;
  wbNet: number;
  ozonNet: number;
  financeImpact: number;
  ownerWithdrawals: number;
}) {
  if (input.wbFinancialUnavailable || input.ozonFinancialUnavailable) {
    return {
      operatingProfitAfterTax: null as number | null,
      netProfit: null as number | null,
      profitAfterOwnerWithdrawal: null as number | null,
    };
  }
  const operatingProfitAfterTax = input.wbNet + input.ozonNet;
  const netProfit = operatingProfitAfterTax + input.financeImpact;
  return {
    operatingProfitAfterTax,
    netProfit,
    profitAfterOwnerWithdrawal: netProfit - input.ownerWithdrawals,
  };
}

export function aliasWbDailyReportSalesAmount(input: {
  economicTurnover: number;
  taxableRevenue: number;
}) {
  return {
    salesAmount: input.economicTurnover,
    economicTurnover: input.economicTurnover,
    taxableRevenue: input.taxableRevenue,
    drrSalesBase: input.economicTurnover,
    drrTaxableBase: input.taxableRevenue,
    taxBase: input.taxableRevenue,
  };
}
