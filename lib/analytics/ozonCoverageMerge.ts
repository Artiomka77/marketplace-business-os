/** Shared Ozon coverage-flag merge used by mergeOzonTotals (production path). */

export type OzonCoverageFlags = {
  quantityCoverageComplete?: boolean;
  productCostCoverageComplete?: boolean;
  cogsCoverageComplete?: boolean;
  costCoverageIncomplete?: boolean;
  quantityMissingDays?: string[];
  taxRevenueCoverageComplete?: boolean;
  discountPointsCoverageComplete?: boolean;
  taxRevenueMissingDays?: string[];
  discountPointsMissingDays?: string[];
  netProfitStatus?: "FINAL" | "PRELIMINARY";
};

export function mergeOzonCoverageFlags(
  flagsList: OzonCoverageFlags[],
): OzonCoverageFlags {
  const result: OzonCoverageFlags = {
    quantityCoverageComplete: true,
    productCostCoverageComplete: true,
    cogsCoverageComplete: true,
    costCoverageIncomplete: false,
    quantityMissingDays: [],
    taxRevenueCoverageComplete: true,
    discountPointsCoverageComplete: true,
    taxRevenueMissingDays: [],
    discountPointsMissingDays: [],
    netProfitStatus: "FINAL",
  };

  for (const flags of flagsList) {
    result.taxRevenueCoverageComplete =
      Boolean(result.taxRevenueCoverageComplete) &&
      Boolean(flags.taxRevenueCoverageComplete);
    result.discountPointsCoverageComplete =
      Boolean(result.discountPointsCoverageComplete) &&
      Boolean(flags.discountPointsCoverageComplete);
    result.costCoverageIncomplete =
      Boolean(result.costCoverageIncomplete) ||
      Boolean(flags.costCoverageIncomplete);
    result.quantityCoverageComplete =
      result.quantityCoverageComplete !== false &&
      flags.quantityCoverageComplete !== false;
    result.productCostCoverageComplete =
      result.productCostCoverageComplete !== false &&
      flags.productCostCoverageComplete !== false;
    result.quantityMissingDays = Array.from(
      new Set([
        ...(result.quantityMissingDays ?? []),
        ...(flags.quantityMissingDays ?? []),
      ]),
    ).sort();
    result.taxRevenueMissingDays = Array.from(
      new Set([
        ...(result.taxRevenueMissingDays ?? []),
        ...(flags.taxRevenueMissingDays ?? []),
      ]),
    );
    result.discountPointsMissingDays = Array.from(
      new Set([
        ...(result.discountPointsMissingDays ?? []),
        ...(flags.discountPointsMissingDays ?? []),
      ]),
    );
  }

  if (result.quantityCoverageComplete === false) {
    result.costCoverageIncomplete = true;
  }
  result.cogsCoverageComplete =
    result.quantityCoverageComplete !== false &&
    result.productCostCoverageComplete !== false &&
    !result.costCoverageIncomplete;
  if (result.costCoverageIncomplete) {
    result.netProfitStatus = "PRELIMINARY";
  }
  return result;
}
