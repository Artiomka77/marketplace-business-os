import "server-only";

import { snapshotCombinedProfit } from "@/lib/dashboard/managementRevenue";
import {
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  getDefaultV6PeriodReadModelRepository,
  isDashboardV6ReadModelFirstEnabled,
  isTrustedV2HitAttestation,
  type PeriodCompanyMarketplaceMetricsPayload,
} from "@/lib/dashboard/v6PeriodReadModel";
import {
  createPrismaProfitReadModelRepository,
  createWaveBProfitTargetPrismaClient,
  isWaveBProfitReadModelFirstEnabled,
  loadProfitReadModel,
} from "@/lib/profitReadModel";

import type {
  InsightsFinanceStatus,
  MarketplaceSlice,
} from "@/app/insights/insightsTypes";

import {
  enqueueV6PeriodRebuild,
  enqueueWaveBProfitRebuild,
  formatGeneratedAt,
  getAmount,
  marginOrNull,
} from "./shared";

export type FinanceCoverage =
  | "FULL"
  | "PARTIAL_WB"
  | "PARTIAL_OZON"
  | "NONE";

export type InsightsFinanceSnapshot = {
  financeStatus: InsightsFinanceStatus;
  financeStatusReason: string;
  financeCoverage: FinanceCoverage;
  rebuildPending: boolean;
  rebuildDetail: string;
  sourceGeneratedAtLabel: string | null;
  kpiSource: string;
  economicTurnover: number | null;
  economicTurnoverWb: number | null;
  economicTurnoverOzon: number | null;
  businessNetProfit: number | null;
  businessNetIncludesFinance: boolean;
  marketplaceNetProfit: number | null;
  financeNetProfitImpact: number | null;
  businessMarginPercent: number | null;
  wbMpNet: number | null;
  ozonMpNet: number | null;
  ozonTotalCost: number | null;
  wbTotalCost: number | null;
  drivers: MarketplaceSlice[];
  dataModes: string[];
};

async function loadV6PeriodCompanyRowsLite(params: {
  dateFrom: string;
  dateTo: string;
  selectedCompany: string;
}): Promise<{
  status: "HIT" | "MISS" | "UNTRUSTED" | "INCOMPLETE" | "ERROR";
  reason: string;
  dataMode: "FINAL" | "PRELIMINARY" | null;
  generatedAt: string | null;
  rows: PeriodCompanyMarketplaceMetricsPayload[];
}> {
  try {
    const repository = getDefaultV6PeriodReadModelRepository();
    const allPeriod = await repository.findPeriod({
      companyScope: "ALL",
      marketplace: "ALL",
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    });
    if (!allPeriod) {
      return {
        status: "MISS",
        reason: "V6_PERIOD_ALL_ROW_MISSING",
        dataMode: null,
        generatedAt: null,
        rows: [],
      };
    }
    if (
      !isTrustedV2HitAttestation({
        meta: allPeriod.meta,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        companyScope: "ALL",
      })
    ) {
      return {
        status: "UNTRUSTED",
        reason: "V2_SAFETY_ATTESTATION_MISSING_OR_UNSAFE",
        dataMode: allPeriod.dataMode,
        generatedAt: allPeriod.meta?.generatedAt ?? allPeriod.generatedAt ?? null,
        rows: [],
      };
    }
    if (allPeriod.coverageStatus !== "COMPLETE") {
      return {
        status: "INCOMPLETE",
        reason: `COVERAGE_${allPeriod.coverageStatus}`,
        dataMode: allPeriod.dataMode,
        generatedAt: allPeriod.meta?.generatedAt ?? allPeriod.generatedAt ?? null,
        rows: [],
      };
    }

    const scopes =
      params.selectedCompany === "ALL"
        ? await repository.listPeriodCompanyScopes({
            dateFrom: params.dateFrom,
            dateTo: params.dateTo,
            formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
          })
        : [params.selectedCompany];

    const rows: PeriodCompanyMarketplaceMetricsPayload[] = [];
    for (const companyName of scopes) {
      const row = await repository.findPeriod({
        companyScope: companyName,
        marketplace: "ALL",
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      });
      if (!row || row.coverageStatus !== "COMPLETE") continue;
      if (
        !isTrustedV2HitAttestation({
          meta: row.meta,
          dateFrom: params.dateFrom,
          dateTo: params.dateTo,
          companyScope: companyName,
        })
      ) {
        continue;
      }
      rows.push(row.payload);
    }

    if (rows.length === 0) {
      return {
        status: "MISS",
        reason: "V6_PERIOD_COMPANY_ROWS_EMPTY",
        dataMode: allPeriod.dataMode,
        generatedAt: allPeriod.meta?.generatedAt ?? allPeriod.generatedAt ?? null,
        rows: [],
      };
    }

    return {
      status: "HIT",
      reason:
        allPeriod.dataMode === "FINAL"
          ? "DASHBOARD_V6_PERIOD_HIT"
          : "DASHBOARD_V6_PERIOD_HIT_PRELIMINARY",
      dataMode: allPeriod.dataMode,
      generatedAt: allPeriod.meta?.generatedAt ?? allPeriod.generatedAt ?? null,
      rows,
    };
  } catch (error) {
    return {
      status: "ERROR",
      reason: `V6_LITE_ERROR:${error instanceof Error ? error.message : String(error)}`,
      dataMode: null,
      generatedAt: null,
      rows: [],
    };
  }
}

/**
 * Level A — financial fast path only.
 * Never calls live getProfitAnalytics / getProfitAnalyticsOzon / Finance scan.
 */
export async function loadInsightsFinanceSnapshot(params: {
  dateFrom: string;
  dateTo: string;
  selectedCompany: string;
}): Promise<InsightsFinanceSnapshot> {
  const { dateFrom, dateTo, selectedCompany } = params;
  const rebuildDetails: string[] = [];
  let rebuildPending = false;

  let economicTurnoverWb: number | null = null;
  let economicTurnoverOzon: number | null = null;
  let wbMpNet: number | null = null;
  let ozonMpNet: number | null = null;
  let ozonTotalCost: number | null = null;
  let wbTotalCost: number | null = null;
  let businessNetProfit: number | null = null;
  let marketplaceNetProfit: number | null = null;
  let financeImpactForKpi: number | null = null;
  let financeStatus: InsightsFinanceStatus = "PENDING_BUILD";
  let financeStatusReason = "";
  let financeCoverage: FinanceCoverage = "NONE";
  let sourceGeneratedAtLabel: string | null = null;
  let kpiSource = "UNRESOLVED";
  let financeResolved = false;

  const applyV6Rows = (
    rowsV6: PeriodCompanyMarketplaceMetricsPayload[],
    dataMode: "FINAL" | "PRELIMINARY" | null,
    generatedAt: string | null,
    reason: string,
  ) => {
    economicTurnoverWb = rowsV6.reduce((s, r) => s + getAmount(r.wbRevenue), 0);
    economicTurnoverOzon = rowsV6.reduce(
      (s, r) => s + getAmount(r.ozonRevenue),
      0,
    );
    marketplaceNetProfit = rowsV6.reduce(
      (s, r) => s + getAmount(r.operatingProfitAfterTax),
      0,
    );
    businessNetProfit = rowsV6.reduce((s, r) => s + getAmount(r.netProfit), 0);
    financeImpactForKpi =
      (businessNetProfit ?? 0) - (marketplaceNetProfit ?? 0);
    wbMpNet = rowsV6.reduce(
      (s, r) => s + getAmount(r.wbOperatingProfitAfterTax),
      0,
    );
    ozonMpNet = rowsV6.reduce(
      (s, r) => s + getAmount(r.ozonOperatingProfitAfterTax),
      0,
    );
    financeCoverage = "FULL";
    financeStatus =
      dataMode === "FINAL" ? "VERIFIED_READY" : "PRELIMINARY_WITH_VALUE";
    financeStatusReason = reason;
    kpiSource =
      dataMode === "FINAL" ? "DASHBOARD_V6_HIT" : "DASHBOARD_V6_HIT_PRELIMINARY";
    sourceGeneratedAtLabel = formatGeneratedAt(generatedAt);
  };

  if (isDashboardV6ReadModelFirstEnabled()) {
    const lite = await loadV6PeriodCompanyRowsLite({
      dateFrom,
      dateTo,
      selectedCompany,
    });
    if (lite.status === "HIT") {
      applyV6Rows(lite.rows, lite.dataMode, lite.generatedAt, lite.reason);
      financeResolved = true;
    } else {
      financeStatus =
        lite.status === "ERROR" ? "ERROR" : "PENDING_BUILD";
      financeStatusReason = `${lite.reason}|AWAIT_V6_REBUILD`;
      const enq = await enqueueV6PeriodRebuild({
        dateFrom,
        dateTo,
        companyScope: selectedCompany,
      });
      rebuildDetails.push(enq.detail);
      if (enq.enqueued) rebuildPending = true;
    }
  }

  // Wave B fallback — never live FC. Never rename MP net as business net.
  if (!financeResolved && isWaveBProfitReadModelFirstEnabled()) {
    try {
      const scope = selectedCompany === "ALL" ? "ALL" : selectedCompany;
      const repository = createPrismaProfitReadModelRepository(
        createWaveBProfitTargetPrismaClient(),
      );
      const wbWave = await loadProfitReadModel({
        repository,
        marketplace: "WB",
        companyScope: scope,
        dateFrom,
        dateTo,
        enqueueOnMiss: true,
      });
      const ozonWave = await loadProfitReadModel({
        repository,
        marketplace: "OZON",
        companyScope: scope,
        dateFrom,
        dateTo,
        enqueueOnMiss: true,
      });
      if (wbWave.rebuildEnqueued || ozonWave.rebuildEnqueued) {
        rebuildPending = true;
        rebuildDetails.push(
          `WAVE_B_WB:${wbWave.status}:${wbWave.rebuildEnqueued ? "enq" : "-"}`,
          `WAVE_B_OZ:${ozonWave.status}:${ozonWave.rebuildEnqueued ? "enq" : "-"}`,
        );
      }

      const wbTotals =
        wbWave.status === "HIT"
          ? ((wbWave.analytics as { totals?: Record<string, unknown> }).totals ??
            null)
          : null;
      const ozTotals =
        ozonWave.status === "HIT"
          ? ((ozonWave.analytics as { totals?: Record<string, unknown> }).totals ??
            null)
          : null;

      if (wbTotals) {
        economicTurnoverWb = getAmount(wbTotals.sellerRetailAmount);
        wbMpNet = getAmount(wbTotals.netProfitAfterTax);
        wbTotalCost = getAmount(wbTotals.totalCost);
      }
      if (ozTotals) {
        economicTurnoverOzon = getAmount(ozTotals.economicTurnover);
        ozonMpNet = getAmount(ozTotals.netProfitAfterTax);
        ozonTotalCost = getAmount(ozTotals.totalCost);
      }

      const wbOk = economicTurnoverWb != null;
      const ozOk = economicTurnoverOzon != null;
      if (wbOk && ozOk) {
        financeCoverage = "FULL";
      } else if (wbOk) {
        financeCoverage = "PARTIAL_WB";
      } else if (ozOk) {
        financeCoverage = "PARTIAL_OZON";
      } else {
        financeCoverage = "NONE";
      }

      if (wbMpNet != null || ozonMpNet != null) {
        const combined = snapshotCombinedProfit({
          wbNet: wbMpNet ?? 0,
          ozonNet: ozonMpNet ?? 0,
          financeImpact: 0,
          ownerWithdrawals: 0,
        });
        marketplaceNetProfit = getAmount(combined.operatingProfitAfterTax);
        // Business net requires Finance INCLUDE (V6) — never invent from MP sum.
        businessNetProfit = null;
        financeImpactForKpi = null;
        financeStatus = "PRELIMINARY_WITH_VALUE";
        financeStatusReason =
          financeCoverage === "FULL"
            ? `PROFIT_WAVE_B_MP_ONLY:WB=${wbWave.status};OZON=${ozonWave.status}|BUSINESS_NET_AWAITS_V6_FINANCE`
            : `PROFIT_WAVE_B_PARTIAL:${financeCoverage}|BUSINESS_NET_AWAITS_V6_FINANCE`;
        kpiSource = "PROFIT_WAVE_B_MP_ONLY";
        financeResolved = true;
        const enq = await enqueueV6PeriodRebuild({
          dateFrom,
          dateTo,
          companyScope: selectedCompany,
        });
        rebuildDetails.push(enq.detail);
        if (enq.enqueued) rebuildPending = true;
      } else {
        financeStatus = "PENDING_BUILD";
        financeStatusReason = `WAVE_B_PENDING:WB=${wbWave.status};OZON=${ozonWave.status}`;
        if (!rebuildPending) {
          const wbEnq = await enqueueWaveBProfitRebuild({
            dateFrom,
            dateTo,
            companyScope: scope,
            marketplace: "WB",
          });
          const ozEnq = await enqueueWaveBProfitRebuild({
            dateFrom,
            dateTo,
            companyScope: scope,
            marketplace: "OZON",
          });
          rebuildDetails.push(wbEnq.detail, ozEnq.detail);
          if (wbEnq.enqueued || ozEnq.enqueued) rebuildPending = true;
        }
      }
    } catch (error) {
      financeStatus = "ERROR";
      financeStatusReason = `WAVE_B_ERROR:${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // Total ET only when FULL coverage — never present partial as WB+Ozon total.
  const economicTurnover =
    financeCoverage === "FULL" &&
    (economicTurnoverWb != null || economicTurnoverOzon != null)
      ? getAmount(economicTurnoverWb) + getAmount(economicTurnoverOzon)
      : null;

  const drivers: MarketplaceSlice[] = [
    {
      marketplace: "WB",
      economicTurnover: economicTurnoverWb,
      marketplaceNetProfit: wbMpNet,
      skuRevenue: null,
      skuProfit: null,
      soldProfit: null,
      marginPercent: marginOrNull(economicTurnoverWb, wbMpNet),
      adjustmentProfit: null,
      adjustmentSkuCount: null,
    },
    {
      marketplace: "Ozon",
      economicTurnover: economicTurnoverOzon,
      marketplaceNetProfit: ozonMpNet,
      skuRevenue: null,
      skuProfit: null,
      soldProfit: null,
      marginPercent: marginOrNull(economicTurnoverOzon, ozonMpNet),
      adjustmentProfit: null,
      adjustmentSkuCount: null,
    },
  ];

  const dataModes = [
    `finance:${financeStatus}`,
    `coverage:${financeCoverage}`,
    financeStatusReason ? `financeReason:${financeStatusReason}` : "",
    rebuildPending ? "rebuild:PENDING" : "",
    ...rebuildDetails,
  ].filter(Boolean);

  return {
    financeStatus,
    financeStatusReason,
    financeCoverage,
    rebuildPending,
    rebuildDetail: rebuildDetails.join("|"),
    sourceGeneratedAtLabel,
    kpiSource,
    economicTurnover,
    economicTurnoverWb,
    economicTurnoverOzon,
    businessNetProfit,
    businessNetIncludesFinance:
      businessNetProfit != null && kpiSource.startsWith("DASHBOARD_V6"),
    marketplaceNetProfit,
    financeNetProfitImpact: financeImpactForKpi,
    businessMarginPercent: marginOrNull(economicTurnover, businessNetProfit),
    wbMpNet,
    ozonMpNet,
    ozonTotalCost,
    wbTotalCost,
    drivers,
    dataModes,
  };
}
