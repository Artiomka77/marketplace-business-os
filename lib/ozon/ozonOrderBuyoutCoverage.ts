import { listInclusiveDateStrings } from "@/lib/ozon/accrualDayStatus";

export type OzonOrderBuyoutCoverage = {
  expectedDays: number;
  loadedDaysByCompany: Record<string, number>;
  /** True only when every scoped company has a distinct order day for every period date. */
  companyDayCoverageComplete: boolean;
  /**
   * MarketplaceDailyOrderStat has no SKU grain in this product — SKU / family
   * buyout denominators cannot be proven from orders alone.
   */
  skuGrainDenominatorProven: boolean;
  /** Precise buyout % may be shown only when both company-day and SKU grain are proven. */
  preciseBuyoutAllowed: boolean;
  reason: string;
};

export type OzonOrderCoverageClient = {
  $queryRaw: <T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<T>;
};

/**
 * Buyout safety for Profit Ozon.
 * Order-day gaps (e.g. Lebedeva 171d) or missing SKU-grain order facts must not
 * produce false-precision buyout percentages.
 */
export async function loadOzonOrderBuyoutCoverage(input: {
  client: OzonOrderCoverageClient;
  dateFrom: string;
  dateTo: string;
  companyNames: string[];
}): Promise<OzonOrderBuyoutCoverage> {
  const expectedDates = listInclusiveDateStrings(input.dateFrom, input.dateTo);
  const expectedDays = expectedDates.length;
  const companyNames = [
    ...new Set(
      input.companyNames
        .map((name) => String(name ?? "").trim())
        .filter(Boolean),
    ),
  ];

  const loadedDaysByCompany: Record<string, number> = {};
  for (const companyName of companyNames) {
    const rows = await input.client.$queryRaw<Array<{ d: number }>>`
      SELECT COUNT(DISTINCT "orderDate")::int AS d
      FROM "MarketplaceDailyOrderStat"
      WHERE marketplace = 'OZON'
        AND "companyName" = ${companyName}
        AND "orderDate"::date >= CAST(${input.dateFrom} AS date)
        AND "orderDate"::date <= CAST(${input.dateTo} AS date)
    `;
    loadedDaysByCompany[companyName] = Number(rows[0]?.d ?? 0);
  }

  const companyDayCoverageComplete =
    companyNames.length > 0 &&
    companyNames.every(
      (companyName) => loadedDaysByCompany[companyName] >= expectedDays,
    );

  // Product contract: MarketplaceDailyOrderStat is company-day only (no SKU grain).
  const skuGrainDenominatorProven = false;

  const preciseBuyoutAllowed =
    companyDayCoverageComplete && skuGrainDenominatorProven;

  let reason = "OK";
  if (!companyDayCoverageComplete) {
    const gaps = companyNames
      .filter((name) => loadedDaysByCompany[name] < expectedDays)
      .map(
        (name) =>
          `${name}:${expectedDays - (loadedDaysByCompany[name] ?? 0)}d_missing`,
      );
    reason = `ORDER_DAY_COVERAGE_INCOMPLETE:${gaps.join("|") || "NO_COMPANIES"}`;
  } else if (!skuGrainDenominatorProven) {
    reason = "ORDER_SKU_GRAIN_DENOMINATOR_NOT_PROVEN";
  }

  return {
    expectedDays,
    loadedDaysByCompany,
    companyDayCoverageComplete,
    skuGrainDenominatorProven,
    preciseBuyoutAllowed,
    reason,
  };
}
