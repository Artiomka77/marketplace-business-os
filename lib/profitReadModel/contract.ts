/**
 * Wave B Profit WB/Ozon read-model contract.
 * Does NOT duplicate Financial Core formulas — producers call getProfitAnalytics*.
 */
export const FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1 =
  "FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1" as const;
export const FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1 =
  "FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1" as const;

export const WAVE_B_PROFIT_FORMULAS = [
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
] as const;

export type WaveBProfitFormulaVersion =
  (typeof WAVE_B_PROFIT_FORMULAS)[number];

export type ProfitMarketplace = "WB" | "OZON";
export type ProfitCoverageStatus = "COMPLETE" | "PARTIAL" | "MISSING";
export type ProfitDataMode = "FINAL" | "PRELIMINARY";

export function isWaveBProfitFormula(
  value: string
): value is WaveBProfitFormulaVersion {
  return (WAVE_B_PROFIT_FORMULAS as readonly string[]).includes(value);
}

export function formulaForMarketplace(
  marketplace: ProfitMarketplace
): WaveBProfitFormulaVersion {
  return marketplace === "WB"
    ? FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1
    : FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1;
}

export type ProfitPeriodMeta = {
  formulaVersion: WaveBProfitFormulaVersion;
  marketplace: ProfitMarketplace;
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  dataMode: ProfitDataMode;
  coverageStatus: ProfitCoverageStatus;
  sourceFingerprint: string;
  payloadChecksum: string;
  generatedAt: string;
  staleAfterMs: number | null;
  sourceOwnershipFinal: boolean | null;
  taxesUnavailable: boolean | null;
  taxesEstimated: boolean | null;
  ozonQuarantineCount: number | null;
  readinessStatus: "complete" | "preliminary" | "incomplete";
  weekPresentationStatus: "FINAL" | "PRELIMINARY" | "INCOMPLETE";
  heavyFcCallsInProducer: number;
};

export type ProfitLoadResult =
  | {
      status: "HIT";
      formulaVersion: WaveBProfitFormulaVersion;
      dataMode: ProfitDataMode;
      coverageStatus: ProfitCoverageStatus;
      analytics: unknown;
      meta: ProfitPeriodMeta;
      skuCount: number;
      heavyFcCalls: 0;
      sourceMarker: "PROFIT_READ_MODEL_HIT";
      preliminaryStale?: boolean;
      rebuildEnqueued?: boolean;
    }
  | {
      status: "PENDING" | "UNAVAILABLE";
      formulaVersion: WaveBProfitFormulaVersion;
      reason: string;
      heavyFcCalls: 0;
      sourceMarker: "PROFIT_READ_MODEL_MISS";
      rebuildEnqueued?: boolean;
    };

export function rejectsLegacyAsWaveBProfit(formula: string): boolean {
  return (
    formula === "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1" ||
    formula === "FINANCIAL_CORE_V6_PERIOD_READMODEL_V1" ||
    formula === "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2"
  );
}
