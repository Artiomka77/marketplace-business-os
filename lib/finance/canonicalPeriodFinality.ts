import {
  evaluateCombinedMarketplaceFinality,
  type CombinedMarketplaceFinality,
  type CombinedMarketplaceFinalityInput,
  type MarketplaceDataMode,
} from "@/lib/finance/combinedMarketplaceFinality";
import {
  listInclusiveDateStrings,
  type OzonAccrualDayStatusRecord,
} from "@/lib/ozon/accrualDayStatus";
import { normalizeExpectedOzonCompanyNames } from "@/lib/ozon/expectedOzonCompanies";

export type CanonicalWbFinality = CombinedMarketplaceFinalityInput["wb"] & {
  sourceOwner: string | null;
};

export type CanonicalOzonFinality = CombinedMarketplaceFinalityInput["ozon"];

export type CanonicalPeriodFinality = CombinedMarketplaceFinality & {
  profitOzon: MarketplaceDataMode;
  telegram: MarketplaceDataMode;
  dashboard: MarketplaceDataMode;
  insights: MarketplaceDataMode;
};

export function resolveWbPeriodFinality(input: {
  dataMode?: MarketplaceDataMode | null;
  sourceOwnershipMode?: string | null;
  sourceOwnershipFinal?: boolean | null;
  sourceOwnershipReasons?: string[] | null;
}): CanonicalWbFinality {
  const sourceOwner = input.sourceOwnershipMode ?? null;
  const ownershipFinal = input.sourceOwnershipFinal === true;
  const dataMode: MarketplaceDataMode =
    input.dataMode === "FINAL" && ownershipFinal ? "FINAL" : "PRELIMINARY";
  const missingEvidence = [
    ...(input.sourceOwnershipReasons ?? []),
    ...(dataMode === "FINAL" ? [] : ["WB_NOT_FINAL"]),
  ];
  return {
    dataMode,
    sourceOwner,
    coverageComplete: dataMode === "FINAL",
    missingEvidence,
  };
}

export function resolveOzonPeriodFinality(input: {
  companyName?: string | null;
  dateFrom: string;
  dateTo: string;
  days: OzonAccrualDayStatusRecord[];
  /**
   * Authoritative expected Ozon companies for companyName=ALL.
   * Required for ALL to avoid false FINAL when a whole company has zero day rows.
   * Empty array => PRELIMINARY (EXPECTED_OZON_COMPANY_SET_EMPTY).
   * Omitted for ALL => PRELIMINARY (EXPECTED_OZON_COMPANY_SET_REQUIRED).
   */
  expectedCompanyNames?: string[] | null;
}): CanonicalOzonFinality {
  const expectedDates = listInclusiveDateStrings(input.dateFrom, input.dateTo);
  const missingEvidence: string[] = [];
  let quarantineCount = 0;
  let allFinal = expectedDates.length > 0;
  const sessionIds = new Set<string>();

  let scopedCompanies: string[];
  if (input.companyName && input.companyName !== "ALL") {
    scopedCompanies = [input.companyName];
  } else if (input.expectedCompanyNames != null) {
    scopedCompanies = normalizeExpectedOzonCompanyNames(input.expectedCompanyNames);
    if (scopedCompanies.length === 0) {
      return {
        dataMode: "PRELIMINARY",
        coverageComplete: false,
        quarantineCount: 0,
        missingEvidence: ["EXPECTED_OZON_COMPANY_SET_EMPTY"],
        canonicalImportSession: null,
      };
    }
  } else {
    // Fail closed: do not derive ALL expected set from day rows alone.
    return {
      dataMode: "PRELIMINARY",
      coverageComplete: false,
      quarantineCount: 0,
      missingEvidence: ["EXPECTED_OZON_COMPANY_SET_REQUIRED"],
      canonicalImportSession: null,
    };
  }

  for (const companyName of scopedCompanies) {
    for (const date of expectedDates) {
      const row = input.days.find(
        (item) => item.companyName === companyName && item.date === date,
      );
      if (!row) {
        allFinal = false;
        missingEvidence.push(`MISSING_OZON_ACCRUAL_DAY_STATUS:${companyName}:${date}`);
        continue;
      }
      sessionIds.add(row.importSessionId);
      quarantineCount += row.quarantineCount;
      if (row.phase === "RAW") {
        allFinal = false;
        missingEvidence.push(`OZON_RAW_PHASE:${companyName}:${date}`);
      }
      if (row.dataMode !== "FINAL" || !row.coverageComplete || row.quarantineCount > 0) {
        allFinal = false;
        missingEvidence.push(...row.missingEvidence);
      }
    }
  }

  if (quarantineCount > 0) {
    missingEvidence.push("OZON_QUARANTINE");
  }

  const uniqueMissing = [...new Set(missingEvidence)];
  const dataMode: MarketplaceDataMode =
    allFinal && quarantineCount === 0 && uniqueMissing.length === 0
      ? "FINAL"
      : "PRELIMINARY";

  return {
    dataMode,
    coverageComplete: dataMode === "FINAL",
    quarantineCount,
    missingEvidence: uniqueMissing,
    canonicalImportSession: sessionIds.size === 1 ? [...sessionIds][0] : null,
  };
}

export function applyOzonCanonicalIngestFinality<
  T extends {
    netProfitStatus: MarketplaceDataMode;
    taxRevenueCoverageComplete?: boolean;
    discountPointsCoverageComplete?: boolean;
  },
>(totals: T, ozon: CanonicalOzonFinality): T {
  const summaryCoverage =
    totals.taxRevenueCoverageComplete !== false &&
    totals.discountPointsCoverageComplete !== false;
  const ingestFinal =
    ozon.dataMode === "FINAL" &&
    ozon.coverageComplete &&
    ozon.quarantineCount === 0 &&
    (ozon.missingEvidence?.length ?? 0) === 0;
  totals.netProfitStatus = summaryCoverage && ingestFinal ? "FINAL" : "PRELIMINARY";
  return totals;
}

export function resolveCanonicalPeriodFinality(
  input: CombinedMarketplaceFinalityInput,
): CanonicalPeriodFinality {
  const combined = evaluateCombinedMarketplaceFinality(input);
  const dataMode = combined.combined.dataMode;
  const profitOzon = applyOzonCanonicalIngestFinality(
    {
      netProfitStatus: "FINAL",
      taxRevenueCoverageComplete: true,
      discountPointsCoverageComplete: true,
    },
    input.ozon,
  ).netProfitStatus;
  return {
    ...combined,
    profitOzon,
    telegram: dataMode,
    dashboard: dataMode,
    insights: dataMode,
  };
}

export function aggregatedSurfacesAgree(finality: CanonicalPeriodFinality) {
  return (
    finality.telegram === finality.combined.dataMode &&
    finality.dashboard === finality.combined.dataMode &&
    finality.insights === finality.combined.dataMode
  );
}
