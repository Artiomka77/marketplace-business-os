export const WB_PRELIMINARY_FINANCIAL_DATA =
  "WB_PRELIMINARY_FINANCIAL_DATA" as const;

export type WbFinancialFinality = {
  dataMode?: "FINAL" | "PRELIMINARY";
  sourceOwnershipFinal?: boolean;
  sourceOwnershipReasons?: string[];
};

export type PlanningMarketplace = "ALL" | "WB" | "OZON";

export function requiresFinalWbFinancialDataForMarketplace(input: {
  exportMarketplace?: PlanningMarketplace;
  supplyMarketplace?: PlanningMarketplace;
}) {
  const exportMarketplace = input.exportMarketplace ?? "ALL";
  const supplyMarketplace = input.supplyMarketplace ?? "ALL";
  const effectiveMarketplace =
    exportMarketplace === "ALL" ? supplyMarketplace : exportMarketplace;
  return effectiveMarketplace !== "OZON";
}

export class WbPreliminaryFinancialDataError extends Error {
  readonly code = WB_PRELIMINARY_FINANCIAL_DATA;
  readonly context: string;
  readonly reasons: string[];

  constructor(context: string, reasons: string[] = []) {
    super(
      `${WB_PRELIMINARY_FINANCIAL_DATA}: ${context}${
        reasons.length > 0 ? ` (${reasons.join(", ")})` : ""
      }`
    );
    this.name = "WbPreliminaryFinancialDataError";
    this.context = context;
    this.reasons = reasons;
  }
}

export function assertWbFinancialDataFinal(
  finality: WbFinancialFinality | null | undefined,
  context: string
) {
  if (
    !finality ||
    finality.dataMode !== "FINAL" ||
    finality.sourceOwnershipFinal !== true
  ) {
    throw new WbPreliminaryFinancialDataError(
      context,
      finality?.sourceOwnershipReasons ?? ["WB_PNL_UNAVAILABLE"]
    );
  }
}

export function isWbPreliminaryFinancialDataError(
  error: unknown
): error is WbPreliminaryFinancialDataError {
  return (
    error instanceof WbPreliminaryFinancialDataError ||
    (error instanceof Error &&
      error.message.startsWith(`${WB_PRELIMINARY_FINANCIAL_DATA}:`))
  );
}
