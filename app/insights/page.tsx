import { prisma } from "@/lib/prisma";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import { applyCanonicalWbSizeOperation } from "@/lib/analytics/wbSizeAllocation";
import { getDefaultLastCompletedWeekRange } from "@/lib/date/defaultPeriod";
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";
import { snapshotCombinedProfit } from "@/lib/dashboard/managementRevenue";
import {
  getDefaultV6PeriodReadModelRepository,
  isDashboardV6ReadModelFirstEnabled,
  loadDashboardV6PeriodReadModel,
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
  InsightsPayload,
  MarketplaceSlice,
} from "./insightsTypes";

type OzonAnalytics = Awaited<ReturnType<typeof getProfitAnalyticsOzon>>;
type WbAnalytics = Awaited<ReturnType<typeof getProfitAnalytics>>;

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
  // Long periods (month+/YTD): prefer V6 KPIs; skip heavy per-company FC SKU scans
  // that statement-timeout under DATABASE_POOL_MAX=1 (availability first).
  const heavySkuAnalytics = periodDays > 0 && periodDays <= 45;

  // Sequential loads: DATABASE_POOL_MAX=1 — parallel Promise.all causes connect timeouts on ALL+YTD.
  // Ozon KPIs: same Wave B profit read-model path as /profit-ozon when HIT (includes COGS).
  const analyticsByCompany: Array<{
    companyName: string;
    wb: WbAnalytics;
    ozon: OzonAnalytics;
    ozonSource: "PROFIT_READ_MODEL_HIT" | "PROFIT_LIVE_FC";
  }> = [];
  const ozonSources: string[] = [];
  if (heavySkuAnalytics) {
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
  } else {
    ozonSources.push(`SKIP_SKU_FC:periodDays=${periodDays}`);
  }

  // Prefer single ALL-scope Ozon Wave B totals when viewing ALL (matches Profit Ozon ALL).
  let ozonTotalsOverride: OzonAnalytics["totals"] | null = null;
  let ozonTotalsSource: "PROFIT_READ_MODEL_HIT" | "PROFIT_LIVE_FC" | "SUM_COMPANIES" =
    "SUM_COMPANIES";
  if (selectedCompany === "ALL" && heavySkuAnalytics) {
    const allOzon = await loadOzonAnalyticsForInsights({
      companyName: "ALL",
      dateFrom,
      dateTo,
    });
    ozonTotalsOverride = allOzon.analytics.totals;
    ozonTotalsSource = allOzon.source;
  }

  // Finance INCLUDE for the same company scope / period (Dashboard netProfit contract).
  // On long periods V6 net already includes Finance — skip heavy transaction scan.
  let financeNetProfitImpact = 0;
  let ownerWithdrawals = 0;
  if (heavySkuAnalytics) {
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

  // Canonical management KPIs: Dashboard V6 HIT first (identical to /), else live/Wave B.
  let economicTurnoverWb = 0;
  let economicTurnoverOzon = 0;
  let wbMpNet = 0;
  let ozonMpNet = 0;
  let ozonTotalCost = 0;
  let wbTotalCost = 0;
  let businessNetProfit = 0;
  let marketplaceNetProfit = 0;
  let financeImpactForKpi = financeNetProfitImpact;
  let kpiSource:
    | "DASHBOARD_V6_HIT"
    | "OZON_WAVE_B_PLUS_WB_LIVE"
    | "LIVE_SUM_COMPANIES" = "LIVE_SUM_COMPANIES";

  let v6Applied = false;
  if (isDashboardV6ReadModelFirstEnabled()) {
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
        economicTurnoverWb = rowsV6.reduce(
          (s, r) => s + getAmount(r.wbRevenue),
          0,
        );
        economicTurnoverOzon = rowsV6.reduce(
          (s, r) => s + getAmount(r.ozonRevenue),
          0,
        );
        marketplaceNetProfit = rowsV6.reduce(
          (s, r) => s + getAmount(r.operatingProfitAfterTax),
          0,
        );
        businessNetProfit = rowsV6.reduce(
          (s, r) => s + getAmount(r.netProfit),
          0,
        );
        financeImpactForKpi = businessNetProfit - marketplaceNetProfit;
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
          wbMpNet = marketplaceNetProfit - ozonMpNet;
        } else {
          wbMpNet = marketplaceNetProfit;
          ozonMpNet = 0;
        }
        v6Applied = true;
        kpiSource = "DASHBOARD_V6_HIT";
      }
    } catch {
      v6Applied = false;
    }
  }

  if (!v6Applied) {
    for (const { wb, ozon } of analyticsByCompany) {
      economicTurnoverWb += getAmount(
        (wb.totals as { sellerRetailAmount?: number }).sellerRetailAmount,
      );
      wbMpNet += getAmount(
        (wb.totals as { netProfitAfterTax?: number }).netProfitAfterTax,
      );
      wbTotalCost += getAmount((wb.totals as { totalCost?: number }).totalCost);
      if (!ozonTotalsOverride) {
        economicTurnoverOzon += getAmount(
          (ozon.totals as { economicTurnover?: number }).economicTurnover,
        );
        ozonMpNet += getAmount(
          (ozon.totals as { netProfitAfterTax?: number }).netProfitAfterTax,
        );
        ozonTotalCost += getAmount(
          (ozon.totals as { totalCost?: number }).totalCost,
        );
      }
    }
    if (ozonTotalsOverride) {
      economicTurnoverOzon = getAmount(ozonTotalsOverride.economicTurnover);
      ozonMpNet = getAmount(ozonTotalsOverride.netProfitAfterTax);
      ozonTotalCost = getAmount(
        (ozonTotalsOverride as { totalCost?: number }).totalCost,
      );
      kpiSource = "OZON_WAVE_B_PLUS_WB_LIVE";
    }
    const combined = snapshotCombinedProfit({
      wbNet: wbMpNet,
      ozonNet: ozonMpNet,
      financeImpact: financeNetProfitImpact,
      ownerWithdrawals,
    });
    marketplaceNetProfit = getAmount(combined.operatingProfitAfterTax);
    businessNetProfit = getAmount(combined.netProfit);
    financeImpactForKpi = financeNetProfitImpact;
  }

  if (ozonTotalsOverride) {
    ozonTotalCost = getAmount(
      (ozonTotalsOverride as { totalCost?: number }).totalCost,
    );
  }
  for (const { wb } of analyticsByCompany) {
    wbTotalCost += getAmount((wb.totals as { totalCost?: number }).totalCost);
  }

  const economicTurnover = economicTurnoverWb + economicTurnoverOzon;

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
  const enableWbSizeDrilldown = heavySkuAnalytics;

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
  const lossSkuCount = lossIdentityKeys.size;

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
      analyticsByCompany.flatMap(({ wb, ozon }) => {
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
      lowMarginSkuCount: lowMarginRows.length,
      profitableSkuCount: soldProfitable.length,
      stockAtCost: stockWithCost.length > 0 ? stockAtCost : null,
    },
    drivers: Array.from(driversMap.values()),
    problems: {
      uniqueProblemSkuCount: problemKeys.size,
      lossSkuCount,
      lowMarginSkuCount: lowMarginRows.length,
      noMovementSkuCount,
      excessStockSkuCount,
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
