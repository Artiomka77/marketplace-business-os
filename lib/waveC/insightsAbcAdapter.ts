/**
 * Wave C Insights/ABC consumer adapter.
 * Reuses Wave B loadProfitReadModel. Never calls getProfitAnalytics*.
 * Ordinary HIT: filter/group/sort/ABC labels/insight rules only.
 */
import { isProfitAnalyticsUnavailable } from "@/lib/analytics/profitAnalytics";
import type { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import type { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import {
  resolveCanonicalPeriodFinality,
  resolveWbPeriodFinality,
} from "@/lib/finance/canonicalPeriodFinality";
import {
  createPrismaProfitReadModelRepository,
  createWaveBProfitTargetPrismaClient,
  loadProfitReadModel,
  type ProfitReadModelRepository,
} from "@/lib/profitReadModel";

export type WbAnalytics = Awaited<ReturnType<typeof getProfitAnalytics>>;
export type OzonAnalytics = Awaited<ReturnType<typeof getProfitAnalyticsOzon>>;

export type WaveCHitPair = {
  status: "HIT";
  companyName: string;
  wb: WbAnalytics;
  ozon: OzonAnalytics;
  wbUnavailable: boolean;
  costIncomplete: boolean;
  insightsCostIncomplete: boolean;
  abcCostIncomplete: boolean;
  dataMode: "FINAL" | "PRELIMINARY";
  insightsDataMode: "FINAL" | "PRELIMINARY";
  heavyFcCalls: 0;
  sourceMarker: "PROFIT_READ_MODEL_HIT";
  wbDataMode: "FINAL" | "PRELIMINARY";
  ozonDataMode: "FINAL" | "PRELIMINARY";
  rebuildEnqueued?: boolean;
};

export type WaveCMissPair = {
  status: "PENDING" | "UNAVAILABLE";
  companyName: string;
  reason: string;
  heavyFcCalls: 0;
  sourceMarker: "PROFIT_READ_MODEL_MISS";
  rebuildEnqueued?: boolean;
};

export type WaveCCompanyLoad = WaveCHitPair | WaveCMissPair;

export function createWaveCProfitRepository(): ProfitReadModelRepository {
  return createPrismaProfitReadModelRepository(
    createWaveBProfitTargetPrismaClient()
  );
}

export function insightsCostIncompleteFromPair(
  wb: WbAnalytics,
  ozon: OzonAnalytics,
  wbUnavailable: boolean
): boolean {
  return (
    (!wbUnavailable && wb.totals?.costCoverageIncomplete === true) ||
    ozon.totals?.costCoverageIncomplete === true
  );
}

export function abcCostIncompleteFromPair(
  wb: WbAnalytics,
  ozon: OzonAnalytics,
  wbUnavailable: boolean
): boolean {
  return (
    (!wbUnavailable &&
      (wb.totals?.costCoverageIncomplete === true ||
        wb.rows.some((row) => row.costCoverageIncomplete === true))) ||
    ozon.totals?.costCoverageIncomplete === true ||
    ozon.rows.some((row) => row.costCoverageIncomplete === true)
  );
}

function insightsDataModeFromHit(params: {
  wb: WbAnalytics;
  ozon: OzonAnalytics;
  wbUnavailable: boolean;
  insightsCostIncomplete: boolean;
  ozonDataMode: "FINAL" | "PRELIMINARY";
}): "FINAL" | "PRELIMINARY" {
  if (params.wbUnavailable || params.insightsCostIncomplete) {
    return "PRELIMINARY";
  }
  const quarantineCount = Number(
    (params.ozon as { quarantineCount?: unknown }).quarantineCount ?? 0
  );
  const combined = resolveCanonicalPeriodFinality({
    wbSelected: true,
    ozonSelected: true,
    wb: resolveWbPeriodFinality({
      dataMode: params.wb.totals?.dataMode,
      sourceOwnershipMode: params.wb.totals?.sourceOwnershipMode,
      sourceOwnershipFinal: params.wb.totals?.sourceOwnershipFinal,
      sourceOwnershipReasons: params.wb.totals?.sourceOwnershipReasons,
    }),
    ozon: {
      dataMode: params.ozonDataMode,
      coverageComplete: params.ozonDataMode === "FINAL",
      quarantineCount,
      missingEvidence:
        params.ozonDataMode === "FINAL" ? [] : ["OZON_READMODEL_PRELIMINARY"],
    },
  });
  return combined.insights;
}

export type WaveCMarketplaceFilter = "ALL" | "WB" | "Ozon";

export type WaveCAbcHit = {
  status: "HIT";
  companyName: string;
  selectedMarketplace: WaveCMarketplaceFilter;
  wb?: WbAnalytics;
  ozon?: OzonAnalytics;
  wbUnavailable: boolean;
  abcCostIncomplete: boolean;
  abcDataMode: "FINAL" | "PRELIMINARY";
  wbDataMode?: "FINAL" | "PRELIMINARY";
  ozonDataMode?: "FINAL" | "PRELIMINARY";
  heavyFcCalls: 0;
  sourceMarker: "PROFIT_READ_MODEL_HIT";
  rebuildEnqueued?: boolean;
};

export type WaveCAbcMiss = {
  status: "PENDING" | "UNAVAILABLE";
  companyName: string;
  selectedMarketplace: WaveCMarketplaceFilter;
  reason: string;
  heavyFcCalls: 0;
  sourceMarker: "PROFIT_READ_MODEL_MISS";
  rebuildEnqueued?: boolean;
};

export type WaveCAbcLoad = WaveCAbcHit | WaveCAbcMiss;

export function abcCostIncompleteFromSelected(params: {
  selectedMarketplace: WaveCMarketplaceFilter;
  wb?: WbAnalytics;
  ozon?: OzonAnalytics;
  wbUnavailable: boolean;
}): boolean {
  const checkWb =
    params.selectedMarketplace === "ALL" || params.selectedMarketplace === "WB";
  const checkOzon =
    params.selectedMarketplace === "ALL" ||
    params.selectedMarketplace === "Ozon";
  let incomplete = false;
  if (checkWb && params.wb && !params.wbUnavailable) {
    incomplete =
      incomplete ||
      params.wb.totals?.costCoverageIncomplete === true ||
      params.wb.rows.some((row) => row.costCoverageIncomplete === true);
  }
  if (checkOzon && params.ozon) {
    incomplete =
      incomplete ||
      params.ozon.totals?.costCoverageIncomplete === true ||
      params.ozon.rows.some((row) => row.costCoverageIncomplete === true);
  }
  return incomplete;
}

export function abcDataModeFromSelectedHit(params: {
  selectedMarketplace: WaveCMarketplaceFilter;
  wb?: WbAnalytics;
  ozon?: OzonAnalytics;
  wbUnavailable: boolean;
  abcCostIncomplete: boolean;
  wbDataMode?: "FINAL" | "PRELIMINARY";
  ozonDataMode?: "FINAL" | "PRELIMINARY";
}): "FINAL" | "PRELIMINARY" {
  if (params.abcCostIncomplete) return "PRELIMINARY";
  const wbSelected =
    params.selectedMarketplace === "ALL" || params.selectedMarketplace === "WB";
  const ozonSelected =
    params.selectedMarketplace === "ALL" ||
    params.selectedMarketplace === "Ozon";
  if (wbSelected) {
    if (params.wbUnavailable) return "PRELIMINARY";
    if (params.wbDataMode !== "FINAL") return "PRELIMINARY";
    const wbCanon = resolveWbPeriodFinality({
      dataMode: params.wb?.totals?.dataMode,
      sourceOwnershipMode: params.wb?.totals?.sourceOwnershipMode,
      sourceOwnershipFinal: params.wb?.totals?.sourceOwnershipFinal,
      sourceOwnershipReasons: params.wb?.totals?.sourceOwnershipReasons,
    });
    if (wbCanon.dataMode !== "FINAL") return "PRELIMINARY";
  }
  if (ozonSelected) {
    if (params.ozonDataMode !== "FINAL") return "PRELIMINARY";
    const quarantineCount = Number(
      (params.ozon as { quarantineCount?: unknown } | undefined)
        ?.quarantineCount ?? 0
    );
    if (quarantineCount > 0) return "PRELIMINARY";
  }
  return "FINAL";
}

export async function loadWaveCAbcCompany(params: {
  companyName: string;
  dateFrom: string;
  dateTo: string;
  repository: ProfitReadModelRepository;
  selectedMarketplace: WaveCMarketplaceFilter;
  enqueueOnMiss?: boolean;
}): Promise<WaveCAbcLoad> {
  const enqueueOnMiss = params.enqueueOnMiss !== false;
  const wantWb =
    params.selectedMarketplace === "ALL" || params.selectedMarketplace === "WB";
  const wantOzon =
    params.selectedMarketplace === "ALL" ||
    params.selectedMarketplace === "Ozon";

  let wbLoaded: Awaited<ReturnType<typeof loadProfitReadModel>> | undefined;
  let ozonLoaded: Awaited<ReturnType<typeof loadProfitReadModel>> | undefined;

  if (wantWb) {
    wbLoaded = await loadProfitReadModel({
      repository: params.repository,
      marketplace: "WB",
      companyScope: params.companyName,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      enqueueOnMiss,
    });
    if (wbLoaded.status !== "HIT") {
      return {
        status: wbLoaded.status,
        companyName: params.companyName,
        selectedMarketplace: params.selectedMarketplace,
        reason: wbLoaded.reason,
        heavyFcCalls: 0,
        sourceMarker: "PROFIT_READ_MODEL_MISS",
        rebuildEnqueued: wbLoaded.rebuildEnqueued,
      };
    }
  }

  if (wantOzon) {
    ozonLoaded = await loadProfitReadModel({
      repository: params.repository,
      marketplace: "OZON",
      companyScope: params.companyName,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      enqueueOnMiss,
    });
    if (ozonLoaded.status !== "HIT") {
      return {
        status: ozonLoaded.status,
        companyName: params.companyName,
        selectedMarketplace: params.selectedMarketplace,
        reason: ozonLoaded.reason,
        heavyFcCalls: 0,
        sourceMarker: "PROFIT_READ_MODEL_MISS",
        rebuildEnqueued: ozonLoaded.rebuildEnqueued,
      };
    }
  }

  const wb = wbLoaded?.status === "HIT" ? (wbLoaded.analytics as WbAnalytics) : undefined;
  const ozon =
    ozonLoaded?.status === "HIT" ? (ozonLoaded.analytics as OzonAnalytics) : undefined;
  const wbUnavailable = wantWb && wb ? isProfitAnalyticsUnavailable(wb) : false;
  const abcCostIncomplete = abcCostIncompleteFromSelected({
    selectedMarketplace: params.selectedMarketplace,
    wb,
    ozon,
    wbUnavailable,
  });
  const wbDataMode =
    wbLoaded?.status === "HIT" ? wbLoaded.dataMode : undefined;
  const ozonDataMode =
    ozonLoaded?.status === "HIT" ? ozonLoaded.dataMode : undefined;
  const abcDataMode = abcDataModeFromSelectedHit({
    selectedMarketplace: params.selectedMarketplace,
    wb,
    ozon,
    wbUnavailable,
    abcCostIncomplete,
    wbDataMode,
    ozonDataMode,
  });

  return {
    status: "HIT",
    companyName: params.companyName,
    selectedMarketplace: params.selectedMarketplace,
    wb,
    ozon,
    wbUnavailable,
    abcCostIncomplete,
    abcDataMode,
    wbDataMode,
    ozonDataMode,
    heavyFcCalls: 0,
    sourceMarker: "PROFIT_READ_MODEL_HIT",
  };
}

export async function loadWaveCCompanyProfitPair(params: {
  companyName: string;
  dateFrom: string;
  dateTo: string;
  repository: ProfitReadModelRepository;
}): Promise<WaveCCompanyLoad> {
  const wbLoaded = await loadProfitReadModel({
    repository: params.repository,
    marketplace: "WB",
    companyScope: params.companyName,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    enqueueOnMiss: true,
  });
  if (wbLoaded.status !== "HIT") {
    return {
      status: wbLoaded.status,
      companyName: params.companyName,
      reason: wbLoaded.reason,
      heavyFcCalls: 0,
      sourceMarker: "PROFIT_READ_MODEL_MISS",
      rebuildEnqueued: wbLoaded.rebuildEnqueued,
    };
  }

  const ozonLoaded = await loadProfitReadModel({
    repository: params.repository,
    marketplace: "OZON",
    companyScope: params.companyName,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    enqueueOnMiss: true,
  });
  if (ozonLoaded.status !== "HIT") {
    return {
      status: ozonLoaded.status,
      companyName: params.companyName,
      reason: ozonLoaded.reason,
      heavyFcCalls: 0,
      sourceMarker: "PROFIT_READ_MODEL_MISS",
      rebuildEnqueued: ozonLoaded.rebuildEnqueued,
    };
  }

  const wb = wbLoaded.analytics as WbAnalytics;
  const ozon = ozonLoaded.analytics as OzonAnalytics;
  const wbUnavailable = isProfitAnalyticsUnavailable(wb);
  const insightsIncomplete = insightsCostIncompleteFromPair(
    wb,
    ozon,
    wbUnavailable
  );
  const abcIncomplete = abcCostIncompleteFromPair(wb, ozon, wbUnavailable);
  const insightsDataMode = insightsDataModeFromHit({
    wb,
    ozon,
    wbUnavailable,
    insightsCostIncomplete: insightsIncomplete,
    ozonDataMode: ozonLoaded.dataMode,
  });

  return {
    status: "HIT",
    companyName: params.companyName,
    wb,
    ozon,
    wbUnavailable,
    costIncomplete: insightsIncomplete,
    insightsCostIncomplete: insightsIncomplete,
    abcCostIncomplete: abcIncomplete,
    dataMode: insightsDataMode,
    insightsDataMode,
    heavyFcCalls: 0,
    sourceMarker: "PROFIT_READ_MODEL_HIT",
    wbDataMode: wbLoaded.dataMode,
    ozonDataMode: ozonLoaded.dataMode,
  };
}

export type InsightSkuRow = {
  companyName: string;
  marketplace: "WB" | "Ozon";
  sku: string;
  vendorCode: string;
  salesQty: number;
  revenue: number;
  profit: number;
  marginPercent: number;
};

function amount(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

/** Exact current Insights SKU mapping from analytics rows. */
export function deriveInsightSkuRows(
  items: Array<{
    companyName: string;
    wb: WbAnalytics;
    ozon: OzonAnalytics;
    wbUnavailable: boolean;
  }>
): InsightSkuRow[] {
  return items.flatMap(
    ({ companyName, wb, ozon, wbUnavailable: companyWbUnavailable }) => [
      ...(companyWbUnavailable
        ? []
        : wb.rows.map((row) => {
            const revenue = amount(row.revenue);
            const profit = amount(row.netProfitAfterTax);
            return {
              companyName,
              marketplace: "WB" as const,
              sku: String(row.nmId ?? ""),
              vendorCode: String(row.vendorCode ?? ""),
              salesQty: amount(row.netSalesQty),
              revenue,
              profit,
              marginPercent: revenue ? (profit / revenue) * 100 : 0,
            };
          })),
      ...ozon.rows.map((row) => {
        const revenue = amount(row.revenue);
        const profit = amount(row.netProfitAfterTax);
        return {
          companyName,
          marketplace: "Ozon" as const,
          sku: String(row.nmId ?? ""),
          vendorCode: String(row.vendorCode ?? ""),
          salesQty: amount(row.netSalesQty),
          revenue,
          profit,
          marginPercent: revenue ? (profit / revenue) * 100 : 0,
        };
      }),
    ]
  );
}

export function deriveInsightClassifications(rows: InsightSkuRow[]) {
  const profitableRows = rows
    .filter((row) => row.profit > 0)
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 20);
  const lossRows = rows
    .filter((row) => row.profit < 0)
    .sort((a, b) => a.profit - b.profit)
    .slice(0, 20);
  const lowMarginRows = rows
    .filter((row) => row.revenue > 0 && row.marginPercent < 5)
    .sort((a, b) => a.marginPercent - b.marginPercent)
    .slice(0, 20);
  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const totalProfit = rows.reduce((sum, row) => sum + row.profit, 0);
  const lossSkuCount = rows.filter((row) => row.profit < 0).length;
  return {
    profitableRows,
    lossRows,
    lowMarginRows,
    totalRevenue,
    totalProfit,
    lossSkuCount,
  };
}

export type AbcRawRow = {
  company: string;
  marketplace: "WB" | "Ozon";
  sku: WbAnalytics["rows"][number]["nmId"];
  vendorCode: WbAnalytics["rows"][number]["vendorCode"];
  salesQty: number;
  revenue: number;
  profit: number;
  abc: "A" | "B" | "C";
};

/** Exact current ABC mapping: keep producer abcByProfit, do not recompute. */
export function deriveAbcRawRows(
  items: Array<{
    companyName: string;
    wb?: WbAnalytics;
    ozon?: OzonAnalytics;
    wbUnavailable: boolean;
  }>,
  marketplace: "ALL" | "WB" | "Ozon"
): AbcRawRow[] {
  const rawRows = items.flatMap(
    ({ companyName, wb, ozon, wbUnavailable: companyWbUnavailable }) => [
      ...(companyWbUnavailable || marketplace === "Ozon" || !wb
        ? []
        : wb.rows
            .filter((row) => row.costCoverageIncomplete !== true)
            .map((row) => ({
              company: companyName,
              marketplace: "WB" as const,
              sku: row.nmId,
              vendorCode: row.vendorCode,
              salesQty: row.netSalesQty,
              revenue: row.revenue,
              profit: row.netProfitAfterTax,
              abc: row.abcByProfit,
            }))),
      ...(marketplace === "WB" || !ozon
        ? []
        : ozon.rows
            .filter((row) => row.costCoverageIncomplete !== true)
            .map((row) => ({
              company: companyName,
              marketplace: "Ozon" as const,
              sku: row.nmId,
              vendorCode: row.vendorCode,
              salesQty: row.netSalesQty,
              revenue: row.revenue,
              profit: row.netProfitAfterTax,
              abc: row.abcByProfit,
            }))),
    ]
  );
  return rawRows
    .filter((row) => marketplace === "ALL" || row.marketplace === marketplace)
    .sort((a, b) => b.profit - a.profit);
}

export function deriveAbcEnriched(rows: AbcRawRow[]) {
  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const totalProfit = rows.reduce((sum, row) => sum + row.profit, 0);
  const totalPositiveProfit = rows.reduce(
    (sum, row) => sum + Math.max(0, row.profit),
    0
  );
  let cumulativeProfit = 0;
  const enrichedRows = rows.map((row) => {
    const positiveProfit = Math.max(0, row.profit);
    cumulativeProfit += positiveProfit;
    return {
      ...row,
      revenueShare: totalRevenue > 0 ? (row.revenue / totalRevenue) * 100 : 0,
      profitShare:
        totalPositiveProfit > 0
          ? (positiveProfit / totalPositiveProfit) * 100
          : 0,
      cumulativeShare:
        totalPositiveProfit > 0
          ? (cumulativeProfit / totalPositiveProfit) * 100
          : 0,
    };
  });
  function groupStats(abc: "A" | "B" | "C") {
    const groupRows = enrichedRows.filter((row) => row.abc === abc);
    const groupRevenue = groupRows.reduce((sum, row) => sum + row.revenue, 0);
    const groupProfit = groupRows.reduce((sum, row) => sum + row.profit, 0);
    return {
      count: groupRows.length,
      revenue: groupRevenue,
      profit: groupProfit,
      revenueShare:
        totalRevenue !== 0 ? (groupRevenue / totalRevenue) * 100 : 0,
      profitShare: totalProfit !== 0 ? (groupProfit / totalProfit) * 100 : 0,
    };
  }
  const cGroupRows = enrichedRows.filter((row) => row.abc === "C");
  const lossRows = cGroupRows.filter((row) => row.profit <= 0);
  const slowRows = cGroupRows.filter((row) => row.salesQty < 3);
  const weakProfitRows = cGroupRows.filter(
    (row) => row.profit > 0 && row.profitShare < 0.2
  );
  const liquidationCandidates = cGroupRows
    .filter(
      (row) => row.profit <= 0 || row.profitShare < 0.2 || row.salesQty < 3
    )
    .sort((a, b) => a.profit - b.profit);
  return {
    totalRevenue,
    totalProfit,
    enrichedRows,
    aStats: groupStats("A"),
    bStats: groupStats("B"),
    cStats: groupStats("C"),
    lossRows,
    slowRows,
    weakProfitRows,
    liquidationCandidates,
  };
}
