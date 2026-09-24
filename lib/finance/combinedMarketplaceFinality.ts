export type MarketplaceDataMode = "FINAL" | "PRELIMINARY";

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
      input.ozon.dataMode !== "FINAL" ||
      input.ozon.quarantineCount > 0)
  ) {
    missingEvidence.push("OZON_NOT_FINAL");
  }

  const wbFinal =
    !input.wbSelected || (input.wb.dataMode === "FINAL" && input.wb.coverageComplete);
  const ozonFinal =
    !input.ozonSelected ||
    (input.ozon.dataMode === "FINAL" &&
      input.ozon.coverageComplete &&
      input.ozon.quarantineCount === 0);

  const combinedFinal = wbFinal && ozonFinal && missingEvidence.length === 0;

  return {
    wb: input.wb,
    ozon: input.ozon,
    combined: {
      dataMode: combinedFinal ? "FINAL" : "PRELIMINARY",
      coverageComplete: combinedFinal,
      missingEvidence: [...new Set(missingEvidence)],
    },
  };
}
