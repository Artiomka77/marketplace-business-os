/**
 * FINANCIAL_CORE_V6_PERIOD_READMODEL_V2
 * Wave A canonical Dashboard read-model contract (reusable for later waves).
 * Does not duplicate Financial Core formulas — producers call existing V6 analytics.
 *
 * V1 remains exported for forensic lookup of pre-D1 rows.
 * Active consumer/producer/worker HIT identity is V2 only.
 */

export const FINANCIAL_CORE_V6_PERIOD_READMODEL_V1 =
  "FINANCIAL_CORE_V6_PERIOD_READMODEL_V1" as const;

export const FINANCIAL_CORE_V6_PERIOD_READMODEL_V2 =
  "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2" as const;

export const V6_PERIOD_READMODEL_ACTIVE_FORMULA =
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2;

export const LEGACY_V4_PERIOD_SNAPSHOT_FORMULA =
  "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1" as const;

export type V6ReadModelFormulaVersion =
  typeof FINANCIAL_CORE_V6_PERIOD_READMODEL_V2;

export type V6CoverageStatus = "COMPLETE" | "PARTIAL" | "MISSING";
export type V6DataMode = "FINAL" | "PRELIMINARY";
export type V6MarketplaceScope = "ALL" | "WB" | "OZON";

export type ReadinessFinalityMeta = {
  formulaVersion: V6ReadModelFormulaVersion;
  coverageStatus: V6CoverageStatus;
  dataMode: V6DataMode;
  generatedAt: string;
  sourceFingerprint: string;
  payloadChecksum: string;
  companyScope: string;
  marketplace: V6MarketplaceScope;
  dateFrom: string;
  dateTo: string;
  completeness: {
    orderDataLoadedDays: number;
    orderDataExpectedDays: number;
    issues: string[];
  };
  invalidationKey: string;
  staleAfterMs: number | null;
  /** Explicit: calendar closed alone never promotes FINAL. */
  closedDateAutoFinal: false;
  readinessIsFinal: boolean;
  readinessStatus: "complete" | "preliminary" | "incomplete";
  weekPresentationStatus: "FINAL" | "PRELIMINARY" | "INCOMPLETE";
  weekPresentationReason: string | null;
  /** Direct FC signals (not proxies of netProfitStatus). */
  wbSourceOwnershipFinal: boolean | null;
  wbTaxesUnavailable: boolean | null;
  ozonCoverageComplete: boolean | null;
  ozonQuarantineCount: number;
  canonicalDataMode: V6DataMode | null;
  /**
   * Typed proof that this V2 row passed A_V2_BOUNDED_SAFE_PERIOD_ELIGIBILITY.
   * Required for trusted V2 persist and consumer HIT. No schema migration:
   * stored inside existing JSON meta.
   */
  v2SafetyAttestation?: {
    strategy: "A_V2_BOUNDED_SAFE_PERIOD_ELIGIBILITY";
    eligible: boolean;
    reason: string;
    source: "LIVE_ELIGIBILITY" | "SYNTHETIC_SAFE_FIXTURE";
    dateFrom: string;
    dateTo: string;
    companyScope: string;
    safetyPlanDigest: string;
  };
};

/** Grain: companyScope × marketplace × businessDate × formulaVersion */
export type DailyCompanyMarketplaceMetricsPayload = {
  businessDate: string;
  wbRevenue: number;
  ozonRevenue: number;
  revenue: number;
  adsCost: number;
  drr: number | null;
  operatingProfitAfterTax: number;
  netProfit: number;
  cashFlowResult: number;
  loanPayments: number;
  creditPrincipal: number;
  creditInterest: number;
};

/** Grain: companyScope × marketplace × dateFrom × dateTo × formulaVersion */
export type PeriodCompanyMarketplaceMetricsPayload = {
  companyName: string;
  ordersQty: number;
  ordersAmount: number;
  orderDataLoadedDays: number;
  orderDataExpectedDays: number;
  wbRevenue: number | null;
  ozonRevenue: number | null;
  totalRevenue: number | null;
  operatingProfitAfterTax: number | null;
  netProfit: number | null;
  profitAfterOwnerWithdrawal: number | null;
  cashFlowResult: number;
  adsCost: number;
  wbAdsCost: number;
  ozonAdsCost: number;
  drr: number | null;
  drrByOrders: number | null;
  loanPayments: number;
  creditPrincipal: number;
  creditInterest: number;
  personalExpenses: number;
  financialExpenses: number;
  cashOnlyExpenses: number;
  wbStockQty: number;
  ozonStockQty: number;
  warehouseStockQty: number;
  wbAbcA: number;
  wbAbcB: number;
  wbAbcC: number;
  ozonAbcA: number;
  ozonAbcB: number;
  ozonAbcC: number;
  /** Preserved Loans V4 / FC V6 per-company finality signals (optional for fixtures). */
  wbNetProfitStatus?: "FINAL" | "PRELIMINARY";
  /** Direct profitAnalytics.totals.sourceOwnershipFinal — never inferred from netProfitStatus. */
  wbSourceOwnershipFinal?: boolean;
  /** Direct profitAnalytics.totals.taxesUnavailable when present on FC totals. */
  wbTaxesUnavailable?: boolean;
  ozonNetProfitStatus?: "FINAL" | "PRELIMINARY";
  ozonTaxesEstimated?: boolean;
  ozonCoverageComplete?: boolean;
  /** planOzonAccrualIngest.quarantine.length (0 when no quarantine evidence). */
  ozonQuarantineCount?: number;
  combinedDataMode?: "FINAL" | "PRELIMINARY";
};

export type DashboardV6PeriodBundle = {
  meta: ReadinessFinalityMeta;
  companyRows: PeriodCompanyMarketplaceMetricsPayload[];
  dailyPoints: DailyCompanyMarketplaceMetricsPayload[];
  sourceMarker: "READ_MODEL";
};

export type DashboardV6LoadResult =
  | {
      status: "HIT";
      bundle: DashboardV6PeriodBundle;
    }
  | {
      status: "PENDING" | "UNAVAILABLE";
      reason: string;
      formulaVersionExpected: V6ReadModelFormulaVersion;
      rejectedFormulaVersion?: string;
      sourceMarker: "READ_MODEL_MISS";
    };

export function isV6PeriodReadModelFormula(
  value: unknown
): value is V6ReadModelFormulaVersion {
  return value === FINANCIAL_CORE_V6_PERIOD_READMODEL_V2;
}

export function rejectsLegacyV4AsV6Final(formulaVersion: string): boolean {
  return formulaVersion === LEGACY_V4_PERIOD_SNAPSHOT_FORMULA;
}

export function isPreD1D5V1Formula(formulaVersion: string): boolean {
  return formulaVersion === FINANCIAL_CORE_V6_PERIOD_READMODEL_V1;
}
