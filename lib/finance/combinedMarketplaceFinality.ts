export type MarketplaceDataMode =
  | "FINAL"
  | "FINAL_WITH_UNCLASSIFIED"
  | "PRELIMINARY";

export type CombinedMarketplaceFinalityInput = {
  wbSelected: boolean;
  ozonSelected: boolean;
  wb: {
    dataMode: MarketplaceDataMode;
    sourceOwner?: string | null;
    coverageComplete: boolean;
    missingEvidence?: string[];
  };
  ozon: {
    dataMode: MarketplaceDataMode;
    coverageComplete: boolean;
    quarantineCount: number;
    missingEvidence?: string[];
    canonicalImportSession?: string | null;
  };
};

export type CombinedMarketplaceFinality = {
  wb: CombinedMarketplaceFinalityInput["wb"];
  ozon: CombinedMarketplaceFinalityInput["ozon"];
  combined: {
    dataMode: MarketplaceDataMode;
    coverageComplete: boolean;
    missingEvidence: string[];
  };
};

function isFinanciallyFinal(mode: MarketplaceDataMode) {
  return mode === "FINAL" || mode === "FINAL_WITH_UNCLASSIFIED";
}

function isAnalyticalUnclassifiedEvidence(item: string) {
  return /UNCLASSIFIED_ADJUSTMENT/i.test(item);
}

export function evaluateCombinedMarketplaceFinality(
  input: CombinedMarketplaceFinalityInput,
): CombinedMarketplaceFinality {
  const missingEvidence = [
    ...(input.wbSelected ? input.wb.missingEvidence ?? [] : []),
    ...(input.ozonSelected ? input.ozon.missingEvidence ?? [] : []),
  ];

  if (input.wbSelected && (!input.wb.coverageComplete || input.wb.dataMode !== "FINAL")) {
    missingEvidence.push("WB_NOT_FINAL");
  }
  if (
    input.ozonSelected &&
    (!input.ozon.coverageComplete ||
      !isFinanciallyFinal(input.ozon.dataMode) ||
      input.ozon.quarantineCount > 0)
  ) {
    missingEvidence.push("OZON_NOT_FINAL");
  }

  const wbFinal =
    !input.wbSelected || (input.wb.dataMode === "FINAL" && input.wb.coverageComplete);
  const ozonFinal =
    !input.ozonSelected ||
    (isFinanciallyFinal(input.ozon.dataMode) &&
      input.ozon.coverageComplete &&
      input.ozon.quarantineCount === 0);

  const blockingMissing = missingEvidence.filter(
    (item) => !isAnalyticalUnclassifiedEvidence(item),
  );
  const anyUnclassified =
    input.ozonSelected &&
    (input.ozon.dataMode === "FINAL_WITH_UNCLASSIFIED" ||
      (input.ozon.missingEvidence ?? []).some(isAnalyticalUnclassifiedEvidence));

  const combinedFinanciallyFinal =
    wbFinal && ozonFinal && blockingMissing.length === 0;

  return {
    wb: input.wb,
    ozon: input.ozon,
    combined: {
      dataMode: combinedFinanciallyFinal
        ? anyUnclassified
          ? "FINAL_WITH_UNCLASSIFIED"
          : "FINAL"
        : "PRELIMINARY",
      coverageComplete: combinedFinanciallyFinal,
      missingEvidence: [...new Set(missingEvidence)],
    },
  };
}
