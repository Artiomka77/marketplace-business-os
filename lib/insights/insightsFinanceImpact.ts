/**
 * Canonical Finance P&L impact for Insights bridge — same path as V6 producer:
 * getEffectiveFinanceTransactions (due LoanPayment synthesis + dedup) →
 * calculateFinanceMetricsForRows with real FinanceCategory catalog.
 *
 * Does not invent metrics from an empty category catalog.
 */

import { getEffectiveFinanceTransactions } from "@/lib/finance/effectiveFinanceTransactions";
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";

export type InsightsFinanceImpactResult = {
  netProfitImpact: number | null;
  status: "OK" | "EMPTY_CATALOG" | "SOURCE_ERROR" | "EMPTY_PERIOD";
  reason: string;
  transactionCount: number;
  categoryCount: number;
  syntheticLoanFacts: number;
};

export async function loadCanonicalInsightsFinanceImpact(params: {
  prisma: any;
  companyScope: string;
  dateFromUtc: Date;
  dateToExclusive: Date;
  asOfDate: Date;
}): Promise<InsightsFinanceImpactResult> {
  try {
    const companyName =
      params.companyScope === "ALL" ? null : params.companyScope;

    const [rows, categories] = await Promise.all([
      getEffectiveFinanceTransactions({
        prisma: params.prisma,
        companyName,
        dateFrom: params.dateFromUtc,
        dateToExclusive: params.dateToExclusive,
        asOfDate: params.asOfDate,
      }),
      params.prisma.financeCategory.findMany({
        select: {
          name: true,
          categoryType: true,
          parentName: true,
          profitTreatment: true,
        },
      }),
    ]);

    const categoryCount = Array.isArray(categories) ? categories.length : 0;
    const transactionCount = Array.isArray(rows) ? rows.length : 0;
    const syntheticLoanFacts = Array.isArray(rows)
      ? rows.filter((r: { __effectiveFactSynthetic?: boolean }) =>
          Boolean(r.__effectiveFactSynthetic),
        ).length
      : 0;

    if (transactionCount > 0 && categoryCount === 0) {
      return {
        netProfitImpact: null,
        status: "EMPTY_CATALOG",
        reason: "FINANCE_ROWS_PRESENT_CATEGORY_CATALOG_EMPTY",
        transactionCount,
        categoryCount,
        syntheticLoanFacts,
      };
    }

    if (transactionCount === 0) {
      return {
        netProfitImpact: categoryCount > 0 ? 0 : null,
        status: categoryCount > 0 ? "EMPTY_PERIOD" : "SOURCE_ERROR",
        reason:
          categoryCount > 0
            ? "NO_FINANCE_ROWS_KNOWN_EMPTY"
            : "NO_FINANCE_ROWS_AND_NO_CATEGORIES",
        transactionCount,
        categoryCount,
        syntheticLoanFacts,
      };
    }

    const metrics = calculateFinanceMetricsForRows({
      transactions: rows as never,
      categories: categories as never,
    });

    return {
      netProfitImpact: metrics.netProfitImpact,
      status: "OK",
      reason: "EFFECTIVE_FINANCE_PLUS_CATEGORY_CATALOG",
      transactionCount,
      categoryCount,
      syntheticLoanFacts,
    };
  } catch (err) {
    return {
      netProfitImpact: null,
      status: "SOURCE_ERROR",
      reason: `FINANCE_LOAD_ERROR:${err instanceof Error ? err.message : String(err)}`,
      transactionCount: 0,
      categoryCount: 0,
      syntheticLoanFacts: 0,
    };
  }
}
