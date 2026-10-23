import { prisma } from "@/lib/prisma";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import { applyCanonicalWbSizeOperation } from "@/lib/analytics/wbSizeAllocation";
import { getDefaultLastCompletedWeekRange } from "@/lib/date/defaultPeriod";
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";
import { snapshotCombinedProfit } from "@/lib/dashboard/managementRevenue";
import {
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  getDefaultV6PeriodReadModelRepository,
  isDashboardV6ReadModelFirstEnabled,
  isTrustedV2HitAttestation,
  loadDashboardV6PeriodReadModel,
  type PeriodCompanyMarketplaceMetricsPayload,
} from "@/lib/dashboard/v6PeriodReadModel";
import {
  createPrismaProfitReadModelRepository,
  createWaveBProfitTargetPrismaClient,
  isWaveBHeavyLiveFallbackEnabled,
  isWaveBProfitReadModelFirstEnabled,
  loadProfitReadModel,
} from "@/lib/profitReadModel";
import {
  buildProductCostLookup,
  getStockUnitCost,
} from "@/lib/stocks/productCostLookup";
import { selectCanonicalWbSaleSource } from "@/lib/wb/sourceOwnership";

import InsightsDashboard from "./InsightsDashboard";
import type {
  InsightSizePart,
  InsightSkuRow,
  InsightStockRow,
  InsightsFinanceStatus,
  InsightsPayload,
  InsightsSkuStatus,
  MarketplaceSlice,
} from "./insightsTypes";

type OzonAnalytics = Awaited<ReturnType<typeof getProfitAnalyticsOzon>>;
type WbAnalytics = Awaited<ReturnType<typeof getProfitAnalytics>>;

/** Period-grain V6 rows without dailyPoints (avoids YTD statement timeouts). */
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

async function loadOzonAnalyticsForInsights(params: {
  companyName: string;
  dateFrom: string;
  dateTo: string;
}): Promise<{
  analytics: OzonAnalytics;
  source: "PROFIT_READ_MODEL_HIT" | "PROFIT_LIVE_FC";
}> {
  const scope =
    !params.companyName || params.companyName === "ALL"
      ? "ALL"
      : params.companyName;

  if (isWaveBProfitReadModelFirstEnabled()) {
    const repository = createPrismaProfitReadModelRepository(
      createWaveBProfitTargetPrismaClient(),
    );
    const { computeCheapProfitSourceVersion } = await import(
      "@/lib/profitReadModel/sourceVersion"
    );
    const loaded = await loadProfitReadModel({
      repository,
      marketplace: "OZON",
      companyScope: scope,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      enqueueOnMiss: false,
      resolveCurrentSourceVersion: () =>
        computeCheapProfitSourceVersion({
          prisma,
          marketplace: "OZON",
          companyScope: scope,
          dateFrom: params.dateFrom,
          dateTo: params.dateTo,
        }),
    });
    if (loaded.status === "HIT") {
      return {
        analytics: loaded.analytics as OzonAnalytics,
        source: "PROFIT_READ_MODEL_HIT",
      };
    }
    if (!isWaveBHeavyLiveFallbackEnabled()) {
      // Prefer live over empty pending — Insights must stay available.
    }
  }

  return {
    analytics: await getProfitAnalyticsOzon({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      companyName: scope === "ALL" ? null : scope,
    }),
    source: "PROFIT_LIVE_FC",
  };
}

function getAmount(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizeVendorCode(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[‐-‒–—−]/g, "-")
    .replace(/\s+/g, "")
    .trim();
}

function getAnyNumber(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = getAmount(row[key]);
    if (value !== 0) return value;
  }
  return 0;
}

function getAnyString(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = String(row[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function marginOrNull(revenue: number | null, profit: number | null): number | null {
  if (revenue == null || profit == null) return null;
  if (!(revenue > 0)) return null;
  return (profit / revenue) * 100;
}

function anomalyFor(revenue: number, profit: number): InsightSkuRow["anomaly"] {
  if (revenue !== 0) return "NONE";
  if (profit > 0) return "PROFIT_WITHOUT_REVENUE";
  if (profit < 0) return "LOSS_WITHOUT_REVENUE";
  return "NONE";
}

function dayStartUtc(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function dayEndExclusiveUtc(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1));
}

/** Confirmed Ozon offer size suffix …-NN / …-NNN (digits only). */
function parseOzonSizeLabel(vendorCode: string): {
  sizeLabel: string;
  sizeStatus: InsightSkuRow["sizeStatus"];
} {
  const raw = String(vendorCode ?? "").trim();
  const m = raw.match(/^(.+)-(\d{2,4})$/);
  if (m) return { sizeLabel: m[2], sizeStatus: "EXACT" };
  if (!raw) return { sizeLabel: "н/д", sizeStatus: "UNKNOWN" };
  return { sizeLabel: "н/д", sizeStatus: "UNKNOWN" };
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    company?: string | string[];
    dateFrom?: string | string[];
    dateTo?: string | string[];
  }>;
}) {
  const raw = searchParams ? await searchParams : {};
  const first = (v: string | string[] | undefined, fallback: string) => {
    if (Array.isArray(v)) {
      for (const entry of v) {
        const t = String(entry ?? "").trim();
        if (t) return t;
      }
      return fallback;
    }
    if (v == null) return fallback;
    const t = String(v).trim();
    return t || fallback;
  };

  const defaultPeriod = getDefaultLastCompletedWeekRange();
  const dateFrom = first(raw.dateFrom, defaultPeriod.dateFrom);
  const dateTo = first(raw.dateTo, defaultPeriod.dateTo);
  const selectedCompany = first(raw.company, "ALL");

  const companies = await prisma.company.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });

  const companyNames =
    selectedCompany === "ALL"
      ? companies.map((company) => company.name)
      : [selectedCompany];

  const periodDays =
    Math.round(
      (Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) /
        86400000,
    ) + 1;
  // Short periods: live FC SKU is safe under pool=1. Long periods: read-model SKU only.
  const useLiveSkuFc = periodDays > 0 && periodDays <= 45;

  // Sequential loads: DATABASE_POOL_MAX=1 — parallel Promise.all causes connect timeouts.
  const analyticsByCompany: Array<{
    companyName: string;
    wb: WbAnalytics;
    ozon: OzonAnalytics;
    ozonSource: "PROFIT_READ_MODEL_HIT" | "PROFIT_LIVE_FC";
  }> = [];
  const ozonSources: string[] = [];
  let skuStatus: InsightsSkuStatus = "PENDING";
  let skuStatusReason = "";

  if (useLiveSkuFc) {
    for (const companyName of companyNames) {
      const wb = await getProfitAnalytics({ dateFrom, dateTo, companyName });
      const ozonLoaded = await loadOzonAnalyticsForInsights({
        companyName,
        dateFrom,
        dateTo,
      });
      ozonSources.push(`${companyName}:${ozonLoaded.source}`);
      analyticsByCompany.push({
        companyName,
        wb,
        ozon: ozonLoaded.analytics,
        ozonSource: ozonLoaded.source,
      });
    }
    skuStatus = "READY";
    skuStatusReason = "LIVE_FC_SKU";
  } else {
    // Long period: ProfitSkuPeriodMetric (Wave B), never heavy live FC in GET.
    const skuScope =
      selectedCompany === "ALL" ? "ALL" : selectedCompany;
    const skuRows = await prisma.profitSkuPeriodMetric.findMany({
      where: {
        companyScope: skuScope,
        dateFrom: dayStartUtc(dateFrom),
        dateTo: dayStartUtc(dateTo),
      },
      take: 5000,
    });
    if (skuRows.length === 0) {
      skuStatus = "UNAVAILABLE";
      skuStatusReason = `PROFIT_SKU_PERIOD_EMPTY:periodDays=${periodDays}`;
      ozonSources.push(skuStatusReason);
    } else {
      const byCompanyMp = new Map<
        string,
        { wbRows: any[]; ozonRows: any[]; modes: string[] }
      >();
      const ensure = (companyName: string) => {
        const key = companyName || skuScope;
        let bucket = byCompanyMp.get(key);
        if (!bucket) {
          bucket = { wbRows: [], ozonRows: [], modes: [] };
          byCompanyMp.set(key, bucket);
        }
        return bucket;
      };
      for (const row of skuRows) {
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        const companyName =
          selectedCompany === "ALL"
            ? String(
                (payload as { companyName?: string }).companyName ??
                  row.companyScope,
              )
            : selectedCompany;
        // ALL-scope SKU table already aggregates — keep under synthetic company for listing.
        const bucket =
          selectedCompany === "ALL"
            ? ensure("ALL")
            : ensure(companyName);
        const mapped = {
          nmId: payload.nmId,
          vendorCode: payload.vendorCode,
          subject: payload.subject,
          revenue: payload.revenue,
          netProfitAfterTax: payload.netProfitAfterTax,
          netSalesQty: payload.netSalesQty,
        };
        if (row.marketplace === "WB") bucket.wbRows.push(mapped);
        else if (row.marketplace === "OZON") bucket.ozonRows.push(mapped);
      }
      for (const [companyName, bucket] of byCompanyMp) {
        analyticsByCompany.push({
          companyName: companyName === "ALL" ? "—" : companyName,
          wb: {
            rows: bucket.wbRows,
            totals: {},
            comparison: null,
          } as unknown as WbAnalytics,
          ozon: {
            rows: bucket.ozonRows,
            totals: {},
          } as unknown as OzonAnalytics,
          ozonSource: "PROFIT_READ_MODEL_HIT",
        });
        ozonSources.push(`${companyName}:PROFIT_SKU_PERIOD`);
      }
      skuStatus = "PRELIMINARY";
      skuStatusReason = `PROFIT_SKU_PERIOD_HIT:rows=${skuRows.length}`;
    }
  }

  // Ozon Wave B totals (COGS tip + fallback finance) — cheap read-model, any period.
  let ozonTotalsOverride: OzonAnalytics["totals"] | null = null;
  let ozonTotalsSource: "PROFIT_READ_MODEL_HIT" | "PROFIT_LIVE_FC" | "SUM_COMPANIES" =
    "SUM_COMPANIES";
  {
    const allOzon = await loadOzonAnalyticsForInsights({
      companyName: selectedCompany === "ALL" ? "ALL" : selectedCompany,
      dateFrom,
      dateTo,
    });
    if (allOzon.source === "PROFIT_READ_MODEL_HIT") {
      ozonTotalsOverride = allOzon.analytics.totals;
      ozonTotalsSource = allOzon.source;
    } else if (useLiveSkuFc) {
      ozonTotalsOverride = allOzon.analytics.totals;
      ozonTotalsSource = allOzon.source;
    }
  }

  // Finance INCLUDE only for short live path; V6 net already includes Finance.
  let financeNetProfitImpact = 0;
  let ownerWithdrawals = 0;
  if (useLiveSkuFc) {
    const financeCategories = await prisma.financeCategory.findMany({
      select: {
        name: true,
        categoryType: true,
        parentName: true,
        profitTreatment: true,
      },
    });
    for (const companyName of companyNames) {
      const transactions = await prisma.financeTransaction.findMany({
        where: {
          companyName,
          operationDate: {
            gte: dayStartUtc(dateFrom),
            lt: dayEndExclusiveUtc(dateTo),
          },
        },
        select: {
          operationType: true,
          category: true,
          subcategory: true,
          amount: true,
          isInternalTransfer: true,
          transferDirection: true,
        },
      });
      const metrics = calculateFinanceMetricsForRows({
        transactions,
        categories: financeCategories,
      });
      financeNetProfitImpact += metrics.netProfitImpact;
      ownerWithdrawals += metrics.ownerWithdrawals;
    }
  }

  const productCosts = await prisma.productCost.findMany({
    orderBy: [{ costDate: "desc" }, { createdAt: "desc" }],
  });
  const stockCompanyWhere =
    selectedCompany !== "ALL" ? { companyName: selectedCompany } : {};
  const wbStocks = await prisma.wbStock.findMany({
    where: stockCompanyWhere,
  });
  const ozonStocks = await prisma.ozonStock.findMany({
    where: stockCompanyWhere,
  });
  const ownWarehouseStocks = await prisma.ozonWarehouseStock.findMany({
    where:
      selectedCompany !== "ALL"
        ? { companyName: selectedCompany }
        : undefined,
  });
  const wbCardsForCost = await prisma.wbProductCard.findMany({
    where: stockCompanyWhere,
    select: {
      companyName: true,
      nmId: true,
      vendorCode: true,
    },
    take: 5000,
  });

  // Same ProductCost resolution as /stocks (supplier article + nmId mapping).
  const stockCostLookup = buildProductCostLookup(
    productCosts,
    [
      ...wbStocks.map((stock) => ({
        companyName: stock.companyName,
        wbArticle: stock.nmId,
        supplierArticle: stock.vendorCode,
      })),
      ...wbCardsForCost.map((card) => ({
        companyName: card.companyName,
        wbArticle: card.nmId,
        supplierArticle: card.vendorCode,
      })),
    ],
  );

  // Canonical management KPIs — never leave numeric 0 on miss/pending.
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
  let sourceGeneratedAtLabel: string | null = null;
  let kpiSource = "UNRESOLVED";

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
    const v6Wb = rowsV6.reduce(
      (s, r) => s + getAmount(r.wbOperatingProfitAfterTax),
      0,
    );
    const v6Oz = rowsV6.reduce(
      (s, r) => s + getAmount(r.ozonOperatingProfitAfterTax),
      0,
    );
    if (v6Wb !== 0 || v6Oz !== 0) {
      wbMpNet = v6Wb;
      ozonMpNet = v6Oz;
    } else if (ozonTotalsOverride) {
      ozonMpNet = getAmount(ozonTotalsOverride.netProfitAfterTax);
      wbMpNet = (marketplaceNetProfit ?? 0) - (ozonMpNet ?? 0);
    } else {
      wbMpNet = marketplaceNetProfit;
      ozonMpNet = 0;
    }
    financeStatus =
      dataMode === "FINAL" ? "VERIFIED_READY" : "PRELIMINARY_WITH_VALUE";
    financeStatusReason = reason;
    kpiSource =
      dataMode === "FINAL" ? "DASHBOARD_V6_HIT" : "DASHBOARD_V6_HIT_PRELIMINARY";
    if (generatedAt) {
      sourceGeneratedAtLabel = new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(generatedAt));
    }
  };

  let financeResolved = false;

  // 1) Prefer lite V6 period rows (no dailyPoints — YTD-safe).
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
      financeStatusReason = lite.reason;
      // 2) Full V6 loader (week/month often HIT; may timeout on YTD — caught).
      try {
        const v6 = await loadDashboardV6PeriodReadModel({
          repository: getDefaultV6PeriodReadModelRepository(),
          dateFrom,
          dateTo,
          companyScope: "ALL",
        });
        if (v6.status === "HIT") {
          const rowsV6 =
            selectedCompany === "ALL"
              ? v6.bundle.companyRows
              : v6.bundle.companyRows.filter(
                  (r) => r.companyName === selectedCompany,
                );
          if (rowsV6.length > 0) {
            applyV6Rows(
              rowsV6,
              v6.bundle.meta?.dataMode ?? null,
              v6.bundle.meta?.generatedAt ?? null,
              "DASHBOARD_V6_FULL_HIT",
            );
            financeResolved = true;
          } else {
            financeStatus = "SOURCE_MISSING";
            financeStatusReason = "V6_HIT_BUT_NO_COMPANY_ROWS";
          }
        } else {
          financeStatus =
            v6.status === "PENDING" ? "PENDING_BUILD" : "SOURCE_MISSING";
          financeStatusReason = `${lite.reason}|FULL:${v6.status}:${v6.reason}`;
        }
      } catch (error) {
        financeStatus = "ERROR";
        financeStatusReason = `${lite.reason}|FULL_ERROR:${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  // 3) Wave B Profit WB+Ozon totals (no live FC) when V6 unavailable.
  if (!financeResolved) {
    const wbWave = await loadProfitReadModel({
      repository: createPrismaProfitReadModelRepository(
        createWaveBProfitTargetPrismaClient(),
      ),
      marketplace: "WB",
      companyScope: selectedCompany === "ALL" ? "ALL" : selectedCompany,
      dateFrom,
      dateTo,
      enqueueOnMiss: false,
    });
    const ozonWave = await loadProfitReadModel({
      repository: createPrismaProfitReadModelRepository(
        createWaveBProfitTargetPrismaClient(),
      ),
      marketplace: "OZON",
      companyScope: selectedCompany === "ALL" ? "ALL" : selectedCompany,
      dateFrom,
      dateTo,
      enqueueOnMiss: false,
    });

    if (wbWave.status === "HIT" || ozonWave.status === "HIT") {
      const wbTotals =
        wbWave.status === "HIT"
          ? ((wbWave.analytics as WbAnalytics).totals as Record<
              string,
              unknown
            >)
          : null;
      const ozTotals =
        ozonWave.status === "HIT"
          ? ((ozonWave.analytics as OzonAnalytics).totals as Record<
              string,
              unknown
            >)
          : ozonTotalsOverride;

      economicTurnoverWb = wbTotals
        ? getAmount(wbTotals.sellerRetailAmount)
        : null;
      economicTurnoverOzon = ozTotals
        ? getAmount(ozTotals.economicTurnover)
        : null;
      wbMpNet = wbTotals ? getAmount(wbTotals.netProfitAfterTax) : null;
      ozonMpNet = ozTotals ? getAmount(ozTotals.netProfitAfterTax) : null;
      wbTotalCost = wbTotals ? getAmount(wbTotals.totalCost) : null;
      ozonTotalCost = ozTotals ? getAmount(ozTotals.totalCost) : null;

      if (wbMpNet != null || ozonMpNet != null) {
        const combined = snapshotCombinedProfit({
          wbNet: wbMpNet ?? 0,
          ozonNet: ozonMpNet ?? 0,
          financeImpact: financeNetProfitImpact,
          ownerWithdrawals,
        });
        marketplaceNetProfit = getAmount(combined.operatingProfitAfterTax);
        // On long periods Finance is not scanned — prefer MP-only until V6.
        businessNetProfit =
          useLiveSkuFc
            ? getAmount(combined.netProfit)
            : marketplaceNetProfit;
        financeImpactForKpi = useLiveSkuFc ? financeNetProfitImpact : null;
        const mode =
          (wbWave.status === "HIT" && wbWave.dataMode === "FINAL" &&
            ozonWave.status === "HIT" && ozonWave.dataMode === "FINAL")
            ? "FINAL"
            : "PRELIMINARY";
        financeStatus =
          mode === "FINAL" ? "VERIFIED_READY" : "PRELIMINARY_WITH_VALUE";
        financeStatusReason = `PROFIT_WAVE_B:WB=${wbWave.status};OZON=${ozonWave.status}`;
        kpiSource = "PROFIT_WAVE_B_HIT";
        financeResolved = true;
      }
    } else if (useLiveSkuFc && analyticsByCompany.length > 0) {
      let etWb = 0;
      let etOz = 0;
      let wbNet = 0;
      let ozNet = 0;
      for (const { wb, ozon } of analyticsByCompany) {
        etWb += getAmount(
          (wb.totals as { sellerRetailAmount?: number }).sellerRetailAmount,
        );
        wbNet += getAmount(
          (wb.totals as { netProfitAfterTax?: number }).netProfitAfterTax,
        );
        wbTotalCost =
          (wbTotalCost ?? 0) +
          getAmount((wb.totals as { totalCost?: number }).totalCost);
        if (!ozonTotalsOverride) {
          etOz += getAmount(
            (ozon.totals as { economicTurnover?: number }).economicTurnover,
          );
          ozNet += getAmount(
            (ozon.totals as { netProfitAfterTax?: number }).netProfitAfterTax,
          );
          ozonTotalCost =
            (ozonTotalCost ?? 0) +
            getAmount((ozon.totals as { totalCost?: number }).totalCost);
        }
      }
      if (ozonTotalsOverride) {
        etOz = getAmount(ozonTotalsOverride.economicTurnover);
        ozNet = getAmount(ozonTotalsOverride.netProfitAfterTax);
        ozonTotalCost = getAmount(
          (ozonTotalsOverride as { totalCost?: number }).totalCost,
        );
      }
      economicTurnoverWb = etWb;
      economicTurnoverOzon = etOz;
      wbMpNet = wbNet;
      ozonMpNet = ozNet;
      const combined = snapshotCombinedProfit({
        wbNet,
        ozonNet: ozNet,
        financeImpact: financeNetProfitImpact,
        ownerWithdrawals,
      });
      marketplaceNetProfit = getAmount(combined.operatingProfitAfterTax);
      businessNetProfit = getAmount(combined.netProfit);
      financeImpactForKpi = financeNetProfitImpact;
      financeStatus = "PRELIMINARY_WITH_VALUE";
      financeStatusReason = "LIVE_SUM_COMPANIES";
      kpiSource = "LIVE_SUM_COMPANIES";
      financeResolved = true;
    } else if (!financeResolved) {
      if (financeStatus === "PENDING_BUILD" && !financeStatusReason) {
        financeStatusReason = "NO_V6_NO_WAVE_B";
      }
      // Keep all KPI numbers null — UI shows н/д / «формируется», never fake 0.
    }
  }

  if (ozonTotalsOverride && ozonTotalCost == null) {
    ozonTotalCost = getAmount(
      (ozonTotalsOverride as { totalCost?: number }).totalCost,
    );
  }

  const economicTurnover =
    economicTurnoverWb != null || economicTurnoverOzon != null
      ? getAmount(economicTurnoverWb) + getAmount(economicTurnoverOzon)
      : null;

  const rows: InsightSkuRow[] = analyticsByCompany.flatMap(
    ({ companyName, wb, ozon }) => [
      ...wb.rows.map((row) => {
        const revenue = getAmount(row.revenue);
        const profit = getAmount(row.netProfitAfterTax);
        return {
          companyName,
          marketplace: "WB" as const,
          sku: String(row.nmId ?? ""),
          vendorCode: String(row.vendorCode ?? ""),
          subject: String(row.subject ?? ""),
          sizeLabel: "Все размеры",
          sizeStatus: "FAMILY_ALL" as const,
          sizeParts: [] as InsightSizePart[],
          salesQty: getAmount(row.netSalesQty),
          revenue,
          profit,
          marginPercent: marginOrNull(revenue, profit),
          anomaly: anomalyFor(revenue, profit),
        };
      }),
      ...ozon.rows.map((row) => {
        const revenue = getAmount(row.revenue);
        const profit = getAmount(row.netProfitAfterTax);
        const netQty = getAmount(row.netSalesQty);
        const vendorCode = String(row.vendorCode ?? "");
        const size = parseOzonSizeLabel(vendorCode);
        // Sales if taxable revenue or net qty; adjustments only if both zero.
        const hasSales = revenue > 0 || netQty !== 0;
        return {
          companyName,
          marketplace: "Ozon" as const,
          sku: String(row.nmId ?? ""),
          vendorCode,
          subject: String((row as { subject?: string }).subject ?? ""),
          sizeLabel: size.sizeLabel,
          sizeStatus: size.sizeStatus,
          sizeParts:
            size.sizeStatus === "EXACT"
              ? [
                  {
                    sizeLabel: size.sizeLabel,
                    salesQty: netQty,
                    revenue,
                    profit: null,
                    note: "Offer size exact; P&L размера не доказан отдельно",
                  },
                ]
              : [],
          salesQty: netQty,
          revenue,
          profit,
          marginPercent: marginOrNull(revenue, profit),
          anomaly: hasSales ? "NONE" : anomalyFor(0, profit),
        };
      }),
    ],
  );

  // WB size qty: ONLY canonical owned sales + SALE/RETURN classification (netSalesQty).
  const enableWbSizeDrilldown = useLiveSkuFc;

  const wbRankVendorCodes = enableWbSizeDrilldown
    ? Array.from(
        new Set(
          rows
            .filter((r) => r.marketplace === "WB" && r.vendorCode)
            .map((r) => r.vendorCode.trim())
            .filter(Boolean),
        ),
      ).slice(0, 80)
    : [];

  if (wbRankVendorCodes.length > 0) {
    const partsByKey = new Map<string, InsightSizePart[]>();
    const companiesForSizes =
      selectedCompany === "ALL" ? companyNames : [selectedCompany];
    for (const companyName of companiesForSizes) {
      const canonical = await selectCanonicalWbSaleSource({
        dateFrom,
        dateTo,
        companyName,
      });
      const sizeMapByVendor = new Map<
        string,
        Map<
          string,
          {
            size: string;
            barcode: string;
            economicTurnover: number;
            salesQty: number;
            returnsQty: number;
            netSalesQty: number;
          }
        >
      >();
      for (const sale of canonical.rows) {
        const vendorCode = String(sale.vendorCode ?? "").trim();
        if (!vendorCode) continue;
        const vendorKey = normalizeVendorCode(vendorCode);
        if (!wbRankVendorCodes.some((v) => normalizeVendorCode(v) === vendorKey)) {
          continue;
        }
        const size =
          String(sale.size ?? "").trim() || "Без размера";
        const barcode = String(sale.barcode ?? "").trim();
        const sizeKey = `${size}__${barcode}`;
        const vendorMap =
          sizeMapByVendor.get(vendorKey) ??
          new Map<
            string,
            {
              size: string;
              barcode: string;
              economicTurnover: number;
              salesQty: number;
              returnsQty: number;
              netSalesQty: number;
            }
          >();
        const current =
          vendorMap.get(sizeKey) ??
          {
            size,
            barcode,
            economicTurnover: 0,
            salesQty: 0,
            returnsQty: 0,
            netSalesQty: 0,
          };
        applyCanonicalWbSizeOperation(current, sale);
        vendorMap.set(sizeKey, current);
        sizeMapByVendor.set(vendorKey, vendorMap);
      }
      for (const [vendorKey, sizeMap] of sizeMapByVendor) {
        const key = `${companyName}|${vendorKey}`;
        const parts: InsightSizePart[] = Array.from(sizeMap.values())
          .filter(
            (s) =>
              s.salesQty !== 0 ||
              s.returnsQty !== 0 ||
              s.netSalesQty !== 0,
          )
          .map((s) => ({
            sizeLabel: s.size,
            salesQty: s.netSalesQty,
            revenue: null,
            profit: null,
            note: `Канон WB: продажи ${s.salesQty} − возвраты ${s.returnsQty} = ${s.netSalesQty}; P&L размера н/д`,
          }))
          .sort((a, b) => Math.abs(b.salesQty ?? 0) - Math.abs(a.salesQty ?? 0));
        if (parts.length > 0) partsByKey.set(key, parts);
      }
    }
    for (const row of rows) {
      if (row.marketplace !== "WB") continue;
      const key = `${row.companyName}|${normalizeVendorCode(row.vendorCode)}`;
      const parts = partsByKey.get(key);
      if (!parts || parts.length === 0) {
        row.sizeParts = [];
        continue;
      }
      const partsNet = parts.reduce((s, p) => s + (p.salesQty ?? 0), 0);
      const familyNet = row.salesQty;
      // Only attach if size net reconciles to family netSalesQty (allow 0.5 rounding).
      if (Math.abs(partsNet - familyNet) <= 0.51) {
        row.sizeParts = parts;
      } else {
        row.sizeParts = [
          {
            sizeLabel: "сверка н/д",
            salesQty: familyNet,
            revenue: null,
            profit: null,
            note: `Сумма размеров ${partsNet} ≠ семья ${familyNet}; размеры не показаны как факт`,
          },
        ];
        row.sizeLabel = "Все размеры";
        row.sizeStatus = "FAMILY_ALL";
      }
    }
  }

  const soldProfitable = rows
    .filter((row) => row.profit > 0 && row.revenue > 0)
    .sort((a, b) => b.profit - a.profit);

  const soldLoss = rows
    .filter((row) => row.profit < 0 && row.revenue > 0)
    .sort((a, b) => a.profit - b.profit);

  const adjustments = rows
    .filter((row) => row.anomaly !== "NONE")
    .sort((a, b) => Math.abs(b.profit) - Math.abs(a.profit));

  const lowMarginRows = rows
    .filter(
      (row) =>
        row.revenue > 0 &&
        row.marginPercent != null &&
        row.marginPercent >= 0 &&
        row.marginPercent < 5,
    )
    .sort((a, b) => (a.marginPercent ?? 999) - (b.marginPercent ?? 999));

  // Transparent SKU-layer aggregates (NOT business KPIs).
  const skuRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const skuProfitTotal = rows.reduce((sum, row) => sum + row.profit, 0);
  const soldProfitTotal = rows
    .filter((r) => r.revenue > 0)
    .reduce((s, r) => s + r.profit, 0);
  const adjustmentProfitSum = adjustments.reduce((s, r) => s + r.profit, 0);

  // Loss count: unique company×MP×vendor identity among negative profit rows.
  const lossIdentityKeys = new Set<string>();
  for (const row of rows) {
    if (row.profit < 0) {
      lossIdentityKeys.add(
        `${row.companyName}|${row.marketplace}|${normalizeVendorCode(row.vendorCode || row.sku)}`,
      );
    }
  }
  const skuLayerReady =
    skuStatus === "READY" || skuStatus === "PRELIMINARY";
  const lossSkuCount = skuLayerReady ? lossIdentityKeys.size : null;

  // Stock valuation = same formula as /stocks summaries (no field cascade fallbacks).
  // WB: totalStock + inTransitToCustomer + inTransitReturns
  // Ozon FBO: availableQty + preparingQty + supplyQty + inTransitQty + returnQty
  //   (availableQty may be 0 — do NOT substitute other marketplaces' fields)
  // Own warehouse: warehouseQty × (own costPrice or ProductCost)
  const stockRowsRaw: InsightStockRow[] = [
    ...wbStocks.map((stock) => {
      const quantity =
        getAmount(stock.totalStock) +
        getAmount(stock.inTransitToCustomer) +
        getAmount(stock.inTransitReturns);
      const vendorCode = String(stock.vendorCode ?? "").trim();
      const companyName = String(stock.companyName ?? "—");
      const unitCost = getStockUnitCost({
        companyName,
        vendorCode,
        nmId: stock.nmId != null ? String(stock.nmId) : null,
        costs: stockCostLookup,
      });
      return {
        companyName,
        marketplace: "WB" as const,
        sku: String(stock.nmId ?? stock.barcode ?? ""),
        vendorCode,
        sizeLabel: String(stock.size ?? "").trim() || "н/д",
        quantity,
        unitCost,
        frozenMoney: unitCost == null ? null : quantity * unitCost,
        costCoverage:
          unitCost == null ? ("MISSING" as const) : ("FULL" as const),
      };
    }),
    ...ozonStocks.map((stock) => {
      const availableQty = getAmount(stock.availableQty);
      const quantity =
        availableQty +
        getAmount(stock.preparingQty) +
        getAmount(stock.supplyQty) +
        getAmount(stock.inTransitQty) +
        getAmount(stock.returnQty);
      const vendorCode = String(stock.vendorCode ?? "").trim();
      const parsed = parseOzonSizeLabel(vendorCode);
      const companyName = String(stock.companyName ?? "—");
      const unitCost = getStockUnitCost({
        companyName,
        vendorCode,
        sku: stock.sku != null ? String(stock.sku) : null,
        costs: stockCostLookup,
      });
      return {
        companyName,
        marketplace: "Ozon" as const,
        sku: String(stock.sku ?? ""),
        vendorCode,
        sizeLabel:
          String(stock.size ?? "").trim() || parsed.sizeLabel || "н/д",
        quantity,
        unitCost,
        frozenMoney: unitCost == null ? null : quantity * unitCost,
        costCoverage:
          unitCost == null ? ("MISSING" as const) : ("FULL" as const),
      };
    }),
    ...ownWarehouseStocks.map((stock) => {
      const quantity = getAmount(stock.warehouseQty);
      const vendorCode = String(stock.vendorCode ?? "").trim();
      const companyName = String(stock.companyName ?? "—");
      const unitCost = getStockUnitCost({
        companyName,
        vendorCode,
        sku: stock.sku != null ? String(stock.sku) : null,
        ownCostPrice: stock.costPrice,
        costs: stockCostLookup,
      });
      return {
        companyName,
        marketplace: "Ozon" as const,
        sku: String(stock.sku ?? ""),
        vendorCode,
        sizeLabel: String(stock.size ?? "").trim() || "н/д",
        quantity,
        unitCost,
        frozenMoney: unitCost == null ? null : quantity * unitCost,
        costCoverage:
          unitCost == null ? ("MISSING" as const) : ("FULL" as const),
      };
    }),
  ].filter((row) => row.quantity > 0);

  const stockWithCost = stockRowsRaw
    .filter((row) => row.frozenMoney != null && (row.frozenMoney ?? 0) > 0)
    .sort((a, b) => (b.frozenMoney ?? 0) - (a.frozenMoney ?? 0));

  const stockAtCost = stockWithCost.reduce(
    (sum, row) => sum + (row.frozenMoney ?? 0),
    0,
  );
  const stockMissingCost = stockRowsRaw.some(
    (row) => row.costCoverage === "MISSING",
  );

  const salesKeys = new Set(
    rows
      .filter((r) => r.salesQty > 0 || r.revenue > 0)
      .map((r) => `${r.marketplace}|${normalizeVendorCode(r.vendorCode)}`),
  );

  const noMovementSkuCount = stockRowsRaw.filter((s) => {
    const key = `${s.marketplace}|${normalizeVendorCode(s.vendorCode)}`;
    return s.quantity > 0 && !salesKeys.has(key);
  }).length;

  const excessStockSkuCount = stockWithCost.filter((s) => {
    const key = `${s.marketplace}|${normalizeVendorCode(s.vendorCode)}`;
    return !salesKeys.has(key);
  }).length;

  const problemKeys = new Set<string>();
  for (const row of rows) {
    if (row.profit < 0) {
      problemKeys.add(
        `${row.marketplace}|${normalizeVendorCode(row.vendorCode || row.sku)}`,
      );
    }
  }
  for (const row of lowMarginRows) {
    problemKeys.add(
      `${row.marketplace}|${normalizeVendorCode(row.vendorCode || row.sku)}`,
    );
  }

  // Drivers: comparable management ET + MP net; SKU adjustments kept separate.
  const driversMap = new Map<string, MarketplaceSlice>();
  driversMap.set("WB", {
    marketplace: "WB",
    economicTurnover: economicTurnoverWb,
    marketplaceNetProfit: wbMpNet,
    skuRevenue: 0,
    skuProfit: 0,
    soldProfit: 0,
    marginPercent: marginOrNull(economicTurnoverWb, wbMpNet),
    adjustmentProfit: 0,
    adjustmentSkuCount: 0,
  });
  driversMap.set("Ozon", {
    marketplace: "Ozon",
    economicTurnover: economicTurnoverOzon,
    marketplaceNetProfit: ozonMpNet,
    skuRevenue: 0,
    skuProfit: 0,
    soldProfit: 0,
    marginPercent: marginOrNull(economicTurnoverOzon, ozonMpNet),
    adjustmentProfit: 0,
    adjustmentSkuCount: 0,
  });
  for (const row of rows) {
    const slice = driversMap.get(row.marketplace)!;
    slice.skuRevenue += row.revenue;
    slice.skuProfit += row.profit;
    if (row.anomaly !== "NONE") {
      slice.adjustmentProfit += row.profit;
      slice.adjustmentSkuCount += 1;
    } else if (row.revenue > 0) {
      slice.soldProfit += row.profit;
    }
  }

  const toDisplayImageUrl = (raw: string | null | undefined): string | null => {
    const url = String(raw ?? "").trim();
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (/^basket-\d+\.wbbasket\.ru$/i.test(parsed.hostname)) {
        return `/api/media/wb-image?u=${encodeURIComponent(url)}`;
      }
    } catch {
      /* keep raw */
    }
    return url;
  };

  const wbNmIds = Array.from(
    new Set(
      rows
        .filter((r) => r.marketplace === "WB" && r.sku)
        .map((r) => String(r.sku).trim())
        .filter(Boolean),
    ),
  ).slice(0, 500);
  const wbVendorCodes = Array.from(
    new Set(
      rows
        .filter((r) => r.marketplace === "WB" && r.vendorCode)
        .map((r) => String(r.vendorCode).trim())
        .filter(Boolean),
    ),
  ).slice(0, 500);
  const ozonKeys = Array.from(
    new Set(
      rows
        .filter((r) => r.marketplace === "Ozon")
        .flatMap((r) => [r.sku, r.vendorCode].map((x) => String(x ?? "").trim()))
        .filter(Boolean),
    ),
  ).slice(0, 500);

  const wbWhere =
    wbNmIds.length || wbVendorCodes.length
      ? {
          OR: [
            ...(wbNmIds.length ? [{ nmId: { in: wbNmIds } }] : []),
            ...(wbVendorCodes.length
              ? [{ vendorCode: { in: wbVendorCodes } }]
              : []),
          ],
        }
      : null;

  const [wbCards, ozonProducts] = await Promise.all([
    wbWhere
      ? prisma.wbProductCard.findMany({
          where: wbWhere,
          select: {
            nmId: true,
            vendorCode: true,
            companyName: true,
            photoSmallUrl: true,
            photoBigUrl: true,
          },
          take: 800,
        })
      : Promise.resolve([]),
    ozonKeys.length
      ? prisma.ozonProduct.findMany({
          where: {
            OR: [
              { sku: { in: ozonKeys } },
              { vendorCode: { in: ozonKeys } },
            ],
          },
          select: {
            sku: true,
            vendorCode: true,
            companyName: true,
            imageSmallUrl: true,
            imageUrl: true,
          },
          take: 800,
        })
      : Promise.resolve([]),
  ]);

  const imageByKey = new Map<string, string>();
  const putImage = (key: string, raw: string | null | undefined) => {
    const display = toDisplayImageUrl(raw);
    if (!display || imageByKey.has(key)) return;
    imageByKey.set(key, display);
  };
  for (const card of wbCards) {
    const raw = card.photoSmallUrl?.trim() || card.photoBigUrl?.trim() || "";
    if (!raw) continue;
    if (card.nmId) {
      putImage(`WB|id:${card.nmId}`, raw);
      putImage(`WB|${card.companyName}|id:${card.nmId}`, raw);
    }
    const vc = normalizeVendorCode(card.vendorCode);
    if (vc) {
      putImage(`WB|vc:${vc}`, raw);
      putImage(`WB|${card.companyName}|vc:${vc}`, raw);
    }
  }
  for (const product of ozonProducts) {
    const raw =
      product.imageSmallUrl?.trim() || product.imageUrl?.trim() || "";
    if (!raw) continue;
    const company = product.companyName || "";
    if (product.sku) {
      putImage(`Ozon|id:${product.sku}`, raw);
      if (company) putImage(`Ozon|${company}|id:${product.sku}`, raw);
      putImage(`Ozon|vc:${normalizeVendorCode(product.sku)}`, raw);
    }
    const vc = normalizeVendorCode(product.vendorCode);
    if (vc) {
      putImage(`Ozon|vc:${vc}`, raw);
      if (company) putImage(`Ozon|${company}|vc:${vc}`, raw);
    }
  }

  const attachImage = <T extends InsightSkuRow | InsightStockRow>(row: T): T => {
    const company = row.companyName || "";
    const candidates = [
      `${row.marketplace}|${company}|id:${row.sku}`,
      `${row.marketplace}|id:${row.sku}`,
      `${row.marketplace}|${company}|vc:${normalizeVendorCode(row.vendorCode)}`,
      `${row.marketplace}|vc:${normalizeVendorCode(row.vendorCode)}`,
    ];
    let imageUrl: string | null = null;
    for (const key of candidates) {
      const hit = imageByKey.get(key);
      if (hit) {
        imageUrl = hit;
        break;
      }
    }
    return { ...row, imageUrl };
  };

  const withImages = <T extends InsightSkuRow | InsightStockRow>(list: T[]) =>
    list.map(attachImage);

  const dataModes = Array.from(
    new Set(
      [
        `finance:${financeStatus}`,
        `sku:${skuStatus}`,
        financeStatusReason ? `financeReason:${financeStatusReason}` : "",
        skuStatusReason ? `skuReason:${skuStatusReason}` : "",
        ...analyticsByCompany.flatMap(({ wb, ozon }) => {
          const modes: string[] = [];
          const wbMode = (wb.totals as { dataMode?: string } | undefined)
            ?.dataMode;
          if (wbMode) modes.push(`WB:${wbMode}`);
          const ozonMode = (
            ozon.totals as { netProfitStatus?: string } | undefined
          )?.netProfitStatus;
          if (ozonMode) modes.push(`Ozon:${ozonMode}`);
          return modes;
        }),
      ].filter(Boolean),
    ),
  );

  const nowLabel = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  const payload: InsightsPayload = {
    company: selectedCompany,
    dateFrom,
    dateTo,
    companies: companies.map((c) => ({ id: c.id, name: c.name })),
    generatedAtLabel: nowLabel,
    dataModes,
    financeStatus,
    financeStatusReason,
    skuStatus,
    skuStatusReason,
    sourceGeneratedAtLabel,
    kpi: {
      economicTurnover,
      economicTurnoverWb,
      economicTurnoverOzon,
      businessNetProfit,
      marketplaceNetProfit,
      financeNetProfitImpact: financeImpactForKpi,
      businessMarginPercent: marginOrNull(economicTurnover, businessNetProfit),
      lossSkuCount,
      lossCountIsUniqueIdentity: true,
      stockAtCost: stockWithCost.length > 0 ? stockAtCost : null,
      frozenCoveragePartial: stockMissingCost,
      frozenAsOfLabel: "как /stocks: WB+Ozon FBO+свой склад × ProductCost",
      skuDetail: {
        skuRevenue,
        soldProfit: soldProfitTotal,
        adjustmentProfit: adjustmentProfitSum,
        skuProfitTotal,
        salesMarginPercent: marginOrNull(skuRevenue, soldProfitTotal),
      },
      ozonProfitSource: `${kpiSource}; ozon=${ozonTotalsSource}; ${ozonSources.join("|")}`,
      ozonTotalCost,
      wbTotalCost,
    },
    attention: {
      lossSkuCount,
      lowMarginSkuCount: skuLayerReady ? lowMarginRows.length : null,
      profitableSkuCount: skuLayerReady ? soldProfitable.length : null,
      stockAtCost: stockWithCost.length > 0 ? stockAtCost : null,
    },
    drivers: Array.from(driversMap.values()),
    problems: {
      uniqueProblemSkuCount: skuLayerReady ? problemKeys.size : null,
      lossSkuCount,
      lowMarginSkuCount: skuLayerReady ? lowMarginRows.length : null,
      noMovementSkuCount: skuLayerReady ? noMovementSkuCount : null,
      excessStockSkuCount: skuLayerReady ? excessStockSkuCount : null,
    },
    profitablePreview: withImages(soldProfitable.slice(0, 5)),
    profitableAll: withImages(soldProfitable.slice(0, 20)),
    lossPreview: withImages(soldLoss.slice(0, 5)),
    lossAll: withImages(soldLoss.slice(0, 20)),
    adjustments: withImages(adjustments.slice(0, 30)),
    adjustmentSummary: {
      skuCount: adjustments.length,
      profitSum: adjustmentProfitSum,
    },
    lowMarginPreview: withImages(lowMarginRows.slice(0, 5)),
    lowMarginAll: withImages(lowMarginRows.slice(0, 20)),
    frozenPreview: withImages(stockWithCost.slice(0, 5)),
    frozenAll: withImages(stockWithCost.slice(0, 20)),
  };

  return <InsightsDashboard data={payload} />;
}
