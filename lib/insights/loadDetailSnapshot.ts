import "server-only";

import { prisma } from "@/lib/prisma";
import {
  buildProductCostLookup,
  getStockUnitCost,
} from "@/lib/stocks/productCostLookup";

import type {
  InsightSkuRow,
  InsightStockRow,
  InsightsSkuStatus,
  MarketplaceSlice,
} from "@/app/insights/insightsTypes";

import {
  dayStartUtc,
  enqueueWaveBProfitRebuild,
  getAmount,
  marginOrNull,
  normalizeVendorCode,
} from "./shared";

const SKU_FULL_LOAD_CAP = 4000;
const SKU_RANK_SLICE = 400;
/** Warn when a stock channel snapshot is older than this many calendar days. */
const STOCK_STALE_DAYS = 7;

/** Per-company × marketplace presence required before SKU READY. */
function assessSkuSourceCompleteness(params: {
  rows: Array<{ companyScope: string; marketplace: string }>;
  expectedCompanies: string[];
  selectedCompany: string;
}): { complete: boolean; gaps: string[] } {
  const gaps: string[] = [];
  const companies =
    params.selectedCompany === "ALL"
      ? params.expectedCompanies
      : [params.selectedCompany];

  const byCompany = new Map<string, { wb: boolean; ozon: boolean }>();
  for (const name of companies) {
    byCompany.set(name, { wb: false, ozon: false });
  }
  let allScopeWb = false;
  let allScopeOzon = false;

  for (const row of params.rows) {
    const mp = String(row.marketplace ?? "").toUpperCase();
    const scope = String(row.companyScope ?? "");
    if (scope === "ALL") {
      if (mp === "WB") allScopeWb = true;
      if (mp === "OZON") allScopeOzon = true;
      continue;
    }
    const bucket = byCompany.get(scope);
    if (!bucket) continue;
    if (mp === "WB") bucket.wb = true;
    if (mp === "OZON") bucket.ozon = true;
  }

  // ALL READY requires WB+Ozon for every active ИП. ALL-scope rows alone never grant READY.
  // Single-company views still accept that company's per-MP rows (or unambiguous ALL-scope MP).
  if (params.selectedCompany === "ALL") {
    for (const name of companies) {
      const bucket = byCompany.get(name) ?? { wb: false, ozon: false };
      if (!bucket.wb) gaps.push(`${name}:WB_SKU_MISSING`);
      if (!bucket.ozon) gaps.push(`${name}:OZON_SKU_MISSING`);
    }
  } else {
    for (const name of companies) {
      const bucket = byCompany.get(name) ?? { wb: false, ozon: false };
      if (!bucket.wb && !allScopeWb) gaps.push(`${name}:WB_SKU_MISSING`);
      if (!bucket.ozon && !allScopeOzon) gaps.push(`${name}:OZON_SKU_MISSING`);
    }
  }
  return { complete: gaps.length === 0, gaps };
}

function putUnambiguousOwner(
  map: Map<string, string>,
  key: string,
  companyName: string,
) {
  if (!key || !companyName) return;
  const prev = map.get(key);
  if (prev == null) {
    map.set(key, companyName);
    return;
  }
  if (prev !== companyName) {
    // Ambiguous identifier across companies — do not invent ownership.
    map.set(key, "");
  }
}

function lookupUnambiguousOwner(
  map: Map<string, string>,
  key: string,
): string | null {
  if (!key) return null;
  const v = map.get(key);
  return v ? v : null;
}

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

function anomalyFor(revenue: number, profit: number): InsightSkuRow["anomaly"] {
  if (revenue !== 0) return "NONE";
  if (profit > 0) return "PROFIT_WITHOUT_REVENUE";
  if (profit < 0) return "LOSS_WITHOUT_REVENUE";
  return "NONE";
}

export type InsightsDetailSnapshot = {
  skuStatus: InsightsSkuStatus;
  skuStatusReason: string;
  rebuildPending: boolean;
  rebuildDetail: string;
  detailGeneratedAtLabel: string;
  lossSkuCount: number | null;
  lossCountIsUniqueIdentity: boolean;
  stockAtCost: number | null;
  stockAtCostWb: number | null;
  stockAtCostOzon: number | null;
  stockAtCostOwn: number | null;
  stockMissingCostQty: number;
  frozenCoveragePartial: boolean;
  frozenAsOfLabel: string;
  skuDetail: {
    skuRevenue: number | null;
    soldProfit: number | null;
    adjustmentProfit: number | null;
    skuProfitTotal: number | null;
    salesMarginPercent: number | null;
    truncated: boolean;
    totalSkuRows: number | null;
  };
  attention: {
    lossSkuCount: number | null;
    lowMarginSkuCount: number | null;
    profitableSkuCount: number | null;
    stockAtCost: number | null;
  };
  driverSkuPatches: Array<{
    marketplace: "WB" | "Ozon";
    skuRevenue: number | null;
    skuProfit: number | null;
    soldProfit: number | null;
    adjustmentProfit: number | null;
    adjustmentSkuCount: number | null;
  }>;
  problems: {
    uniqueProblemSkuCount: number | null;
    lossSkuCount: number | null;
    lowMarginSkuCount: number | null;
    noMovementSkuCount: number | null;
    excessStockSkuCount: number | null;
  };
  profitablePreview: InsightSkuRow[];
  profitableAll: InsightSkuRow[];
  lossPreview: InsightSkuRow[];
  lossAll: InsightSkuRow[];
  adjustments: InsightSkuRow[];
  adjustmentSummary: {
    skuCount: number | null;
    profitSum: number | null;
    status: "READY" | "PENDING" | "EMPTY";
  };
  lowMarginPreview: InsightSkuRow[];
  lowMarginAll: InsightSkuRow[];
  frozenPreview: InsightStockRow[];
  frozenAll: InsightStockRow[];
};

export async function loadInsightsDetailSnapshot(params: {
  dateFrom: string;
  dateTo: string;
  selectedCompany: string;
}): Promise<InsightsDetailSnapshot> {
  const { dateFrom, dateTo, selectedCompany } = params;
  const rebuildDetails: string[] = [];
  let rebuildPending = false;
  let skuStatus: InsightsSkuStatus = "PENDING";
  let skuStatusReason = "";
  let skuTotalInDb: number | null = null;
  let skuTruncated = false;
  let skuLossCountDb: number | null = null;

  type MappedRow = {
    nmId?: unknown;
    vendorCode?: unknown;
    subject?: unknown;
    revenue?: unknown;
    netProfitAfterTax?: unknown;
    netSalesQty?: unknown;
  };
  const analyticsByCompany: Array<{
    companyName: string;
    wbRows: MappedRow[];
    ozonRows: MappedRow[];
  }> = [];

  const activeCompanies =
    selectedCompany === "ALL"
      ? (
          await prisma.company.findMany({
            where: { isActive: true },
            select: { name: true },
            orderBy: { name: "asc" },
          })
        ).map((c) => c.name)
      : [selectedCompany];

  // Prefer per-company SKU scopes (canonical ownership). For ALL, load each
  // company separately and merge by id — avoids losing one ИП under a shared IN.
  const preferredScopes =
    selectedCompany === "ALL" ? activeCompanies : [selectedCompany];
  let skuLoadMode: "PER_COMPANY" | "ALL_SCOPE" = "PER_COMPANY";

  let skuRows: Awaited<
    ReturnType<typeof prisma.profitSkuPeriodMetric.findMany>
  > = [];

  const dateFromUtc = dayStartUtc(dateFrom);
  const dateToUtc = dayStartUtc(dateTo);

  const mergeSkuRowsById = (
    parts: Array<Awaited<ReturnType<typeof prisma.profitSkuPeriodMetric.findMany>>>,
  ) => {
    const byId = new Map<string, (typeof skuRows)[number]>();
    for (const part of parts) {
      for (const row of part) byId.set(row.id, row);
    }
    return Array.from(byId.values());
  };

  try {
    if (selectedCompany === "ALL" && preferredScopes.length > 1) {
      const parts: Array<
        Awaited<ReturnType<typeof prisma.profitSkuPeriodMetric.findMany>>
      > = [];
      let total = 0;
      for (const scope of preferredScopes) {
        const where = {
          companyScope: scope,
          dateFrom: dateFromUtc,
          dateTo: dateToUtc,
        };
        const n = await prisma.profitSkuPeriodMetric.count({ where });
        total += n;
        if (n > 0) {
          parts.push(await prisma.profitSkuPeriodMetric.findMany({ where }));
        }
      }
      skuTotalInDb = total;
      skuRows = mergeSkuRowsById(parts);
      skuLoadMode = "PER_COMPANY";
      if (skuTotalInDb === 0) {
        const allWhere = {
          companyScope: "ALL",
          dateFrom: dateFromUtc,
          dateTo: dateToUtc,
        };
        skuTotalInDb = await prisma.profitSkuPeriodMetric.count({
          where: allWhere,
        });
        if (skuTotalInDb > 0) {
          skuLoadMode = "ALL_SCOPE";
          skuRows = await prisma.profitSkuPeriodMetric.findMany({
            where: allWhere,
          });
        }
      }
    } else {
      const where = {
        companyScope: preferredScopes[0],
        dateFrom: dateFromUtc,
        dateTo: dateToUtc,
      };
      skuTotalInDb = await prisma.profitSkuPeriodMetric.count({ where });
      if (skuTotalInDb > 0) {
        skuRows = await prisma.profitSkuPeriodMetric.findMany({ where });
      }
    }

    if (skuTotalInDb === 0) {
      skuStatus = "PENDING";
      skuStatusReason = "PROFIT_SKU_PERIOD_EMPTY";
      const scopesToEnqueue =
        selectedCompany === "ALL"
          ? ["ALL", ...activeCompanies]
          : [selectedCompany];
      for (const scope of scopesToEnqueue) {
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
    } else if (skuTotalInDb <= SKU_FULL_LOAD_CAP) {
      const completeness = assessSkuSourceCompleteness({
        rows: skuRows,
        expectedCompanies: activeCompanies,
        selectedCompany,
      });
      if (!completeness.complete) {
        skuStatus = "PENDING";
        skuStatusReason = `SKU_INCOMPLETE:${completeness.gaps.join(",")}`;
        for (const gap of completeness.gaps) {
          const [scope, kind] = gap.split(":");
          const companyScope = scope === "ALL" ? "ALL" : scope;
          if (kind?.startsWith("WB")) {
            const enq = await enqueueWaveBProfitRebuild({
              dateFrom,
              dateTo,
              companyScope,
              marketplace: "WB",
            });
            rebuildDetails.push(enq.detail);
            if (enq.enqueued) rebuildPending = true;
          }
          if (kind?.startsWith("OZON")) {
            const enq = await enqueueWaveBProfitRebuild({
              dateFrom,
              dateTo,
              companyScope,
              marketplace: "OZON",
            });
            rebuildDetails.push(enq.detail);
            if (enq.enqueued) rebuildPending = true;
          }
        }
      } else {
        skuStatus = "READY";
        skuStatusReason = `PROFIT_SKU_PERIOD_HIT:${skuLoadMode}:rows=${skuRows.length}`;
      }
    } else {
      skuTruncated = true;
      const scored = skuRows.map((row) => {
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        const profit = Number(payload.netProfitAfterTax ?? 0);
        return { row, profit: Number.isFinite(profit) ? profit : 0 };
      });
      const topProfit = [...scored]
        .sort((a, b) => b.profit - a.profit)
        .slice(0, SKU_RANK_SLICE);
      const topLoss = [...scored]
        .sort((a, b) => a.profit - b.profit)
        .slice(0, SKU_RANK_SLICE);
      skuLossCountDb = scored.filter((s) => s.profit < 0).length;
      const byId = new Map<string, (typeof skuRows)[number]>();
      for (const item of [...topProfit, ...topLoss]) byId.set(item.row.id, item.row);
      const rankedAll = skuRows;
      skuRows = Array.from(byId.values());
      const completeness = assessSkuSourceCompleteness({
        rows: rankedAll,
        expectedCompanies: activeCompanies,
        selectedCompany,
      });
      if (!completeness.complete) {
        skuStatus = "PENDING";
        skuStatusReason = `SKU_INCOMPLETE:${completeness.gaps.join(",")}`;
        skuTruncated = false;
      } else {
        skuStatus = "PRELIMINARY";
        skuStatusReason = `PROFIT_SKU_PERIOD_HIT_TRUNCATED:${skuLoadMode}:shown=${skuRows.length};total=${skuTotalInDb}`;
      }
    }
  } catch (error) {
    skuStatus = "UNAVAILABLE";
    skuStatusReason = `PROFIT_SKU_PERIOD_ERROR:${error instanceof Error ? error.message : String(error)}`;
  }

  // Canonical company ownership for ALL-scope rows: only unambiguous IDs
  // (WB nmId / Ozon sku). Never invent from ambiguous vendorCode.
  const companyByWbNm = new Map<string, string>();
  const companyByOzonSku = new Map<string, string>();
  if (skuLoadMode === "ALL_SCOPE" && skuRows.length > 0) {
    try {
      const wbCards = await prisma.wbProductCard.findMany({
        where: { companyName: { in: activeCompanies } },
        select: { companyName: true, nmId: true },
        take: 5000,
      });
      for (const card of wbCards) {
        if (!card.companyName || !card.nmId) continue;
        putUnambiguousOwner(
          companyByWbNm,
          String(card.nmId).trim(),
          card.companyName,
        );
      }
      const ozonProducts = await prisma.ozonProduct.findMany({
        where: { companyName: { in: activeCompanies } },
        select: { companyName: true, sku: true },
        take: 5000,
      });
      for (const product of ozonProducts) {
        if (!product.companyName || !product.sku) continue;
        putUnambiguousOwner(
          companyByOzonSku,
          String(product.sku).trim(),
          product.companyName,
        );
      }
    } catch (error) {
      rebuildDetails.push(
        `COMPANY_LOOKUP_ERROR:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const resolveSkuCompanyName = (params: {
    companyScope: string;
    marketplace: string;
    payload: Record<string, unknown>;
  }): string => {
    if (selectedCompany !== "ALL") return selectedCompany;
    const fromPayload = String(params.payload.companyName ?? "").trim();
    if (
      fromPayload &&
      fromPayload !== "ALL" &&
      fromPayload !== "—" &&
      fromPayload !== "н/д"
    ) {
      return fromPayload;
    }
    if (params.companyScope && params.companyScope !== "ALL") {
      return params.companyScope;
    }
    const nmId = String(params.payload.nmId ?? "").trim();
    if (params.marketplace === "WB") {
      const owner = lookupUnambiguousOwner(companyByWbNm, nmId);
      if (owner) return owner;
    }
    if (params.marketplace === "OZON") {
      const owner = lookupUnambiguousOwner(companyByOzonSku, nmId);
      if (owner) return owner;
    }
    return "н/д";
  };

  if (skuRows.length > 0) {
    const byCompanyMp = new Map<
      string,
      { wbRows: MappedRow[]; ozonRows: MappedRow[] }
    >();
    const ensure = (companyName: string) => {
      let bucket = byCompanyMp.get(companyName);
      if (!bucket) {
        bucket = { wbRows: [], ozonRows: [] };
        byCompanyMp.set(companyName, bucket);
      }
      return bucket;
    };
    for (const row of skuRows) {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const companyName = resolveSkuCompanyName({
        companyScope: row.companyScope,
        marketplace: row.marketplace,
        payload,
      });
      const bucket = ensure(companyName);
      const mapped: MappedRow = {
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
        companyName,
        wbRows: bucket.wbRows,
        ozonRows: bucket.ozonRows,
      });
    }
  }

  const rows: InsightSkuRow[] = analyticsByCompany.flatMap(
    ({ companyName, wbRows, ozonRows }) => [
      ...wbRows.map((row) => {
        const revenue = getAmount(row.revenue);
        const profit = getAmount(row.netProfitAfterTax);
        const netQty = getAmount(row.netSalesQty);
        return {
          companyName,
          marketplace: "WB" as const,
          sku: String(row.nmId ?? ""),
          vendorCode: String(row.vendorCode ?? "").trim(),
          subject: String(row.subject ?? "").trim() || "—",
          sizeLabel: "Все размеры",
          sizeStatus: "FAMILY_ALL" as const,
          sizeParts: [],
          salesQty: netQty,
          revenue,
          profit,
          marginPercent: marginOrNull(revenue, profit),
          anomaly: revenue > 0 ? ("NONE" as const) : anomalyFor(0, profit),
        };
      }),
      ...ozonRows.map((row) => {
        const revenue = getAmount(row.revenue);
        const profit = getAmount(row.netProfitAfterTax);
        const netQty = getAmount(row.netSalesQty);
        const vendorCode = String(row.vendorCode ?? "").trim();
        const parsed = parseOzonSizeLabel(vendorCode);
        const hasSales = revenue > 0 || netQty !== 0;
        return {
          companyName,
          marketplace: "Ozon" as const,
          sku: String(row.nmId ?? vendorCode),
          vendorCode,
          subject: String(row.subject ?? "").trim() || "—",
          sizeLabel: parsed.sizeLabel,
          sizeStatus: parsed.sizeStatus,
          sizeParts: [],
          salesQty: netQty,
          revenue,
          profit,
          marginPercent: marginOrNull(revenue, profit),
          anomaly: hasSales ? ("NONE" as const) : anomalyFor(0, profit),
        };
      }),
    ],
  );

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

  const skuRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const skuProfitTotal = rows.reduce((sum, row) => sum + row.profit, 0);
  const soldProfitTotal = rows
    .filter((r) => r.revenue > 0)
    .reduce((s, r) => s + r.profit, 0);
  const adjustmentProfitSum = adjustments.reduce((s, r) => s + r.profit, 0);

  const lossIdentityKeys = new Set<string>();
  for (const row of rows) {
    if (row.profit < 0) {
      lossIdentityKeys.add(
        `${row.companyName}|${row.marketplace}|${normalizeVendorCode(row.vendorCode || row.sku)}`,
      );
    }
  }
  // READY = full per-MP/company SKU sources. PRELIMINARY only for truncated full sources.
  // Incomplete marketplace coverage stays PENDING — do not present partial rankings as full.
  const skuLayerReady =
    skuStatus === "READY" || (skuStatus === "PRELIMINARY" && skuTruncated);
  const lossSkuCount = !skuLayerReady
    ? null
    : skuTruncated && skuLossCountDb != null
      ? skuLossCountDb
      : lossIdentityKeys.size;

  // Stocks — current snapshot only (latest createdAt day per channel).
  // Do not mix historical import days across channels as one trusted total.
  let productCosts: Awaited<ReturnType<typeof prisma.productCost.findMany>> = [];
  let wbStocks: Awaited<ReturnType<typeof prisma.wbStock.findMany>> = [];
  let ozonStocks: Awaited<ReturnType<typeof prisma.ozonStock.findMany>> = [];
  let ownWarehouseStocks: Awaited<
    ReturnType<typeof prisma.ozonWarehouseStock.findMany>
  > = [];
  let wbCardsForCost: Array<{
    companyName: string;
    nmId: string | null;
    vendorCode: string | null;
  }> = [];
  let wbStockAsOf: string | null = null;
  let ozonStockAsOf: string | null = null;
  let ownStockAsOf: string | null = null;
  const stockCompanyWhere =
    selectedCompany !== "ALL" ? { companyName: selectedCompany } : {};

  const latestCreatedDay = async (
    table: "WbStock" | "OzonStock" | "OzonWarehouseStock",
  ): Promise<Date | null> => {
    const rows = await prisma.$queryRawUnsafe<Array<{ d: Date | null }>>(
      `SELECT MAX(DATE("createdAt")) AS d FROM "${table}"`,
    );
    const d = rows[0]?.d;
    return d ? new Date(d) : null;
  };
  const dayRange = (day: Date) => {
    const start = new Date(
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()),
    );
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { gte: start, lt: end };
  };
  const isoDay = (day: Date | null) =>
    day
      ? `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`
      : null;

  try {
    productCosts = await prisma.productCost.findMany({
      orderBy: [{ costDate: "desc" }, { createdAt: "desc" }],
    });
    const wbDay = await latestCreatedDay("WbStock");
    const ozDay = await latestCreatedDay("OzonStock");
    const ownDay = await latestCreatedDay("OzonWarehouseStock");
    wbStockAsOf = isoDay(wbDay);
    ozonStockAsOf = isoDay(ozDay);
    ownStockAsOf = isoDay(ownDay);

    if (wbDay) {
      wbStocks = await prisma.wbStock.findMany({
        where: { ...stockCompanyWhere, createdAt: dayRange(wbDay) },
      });
    }
    if (ozDay) {
      ozonStocks = await prisma.ozonStock.findMany({
        where: { ...stockCompanyWhere, createdAt: dayRange(ozDay) },
      });
    }
    if (ownDay) {
      ownWarehouseStocks = await prisma.ozonWarehouseStock.findMany({
        where: {
          ...(selectedCompany !== "ALL"
            ? { companyName: selectedCompany }
            : {}),
          createdAt: dayRange(ownDay),
        },
      });
    }
    wbCardsForCost = await prisma.wbProductCard.findMany({
      where: stockCompanyWhere,
      select: { companyName: true, nmId: true, vendorCode: true },
      take: 5000,
    });
  } catch (error) {
    rebuildDetails.push(
      `STOCK_LAYER_ERROR:${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const stockCostLookup = buildProductCostLookup(productCosts, [
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
  ]);

  const stockRowsRaw: InsightStockRow[] = [
    ...wbStocks.map((stock) => {
      const quantity =
        getAmount(stock.totalStock) +
        getAmount(stock.inTransitToCustomer) +
        getAmount(stock.inTransitReturns);
      const vendorCode = String(stock.vendorCode ?? "").trim();
      const companyName = String(stock.companyName ?? "").trim() || "н/д";
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
      const quantity =
        getAmount(stock.availableQty) +
        getAmount(stock.preparingQty) +
        getAmount(stock.supplyQty) +
        getAmount(stock.inTransitQty) +
        getAmount(stock.returnQty);
      const vendorCode = String(stock.vendorCode ?? "").trim();
      const parsed = parseOzonSizeLabel(vendorCode);
      const companyName = String(stock.companyName ?? "").trim() || "н/д";
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
        sizeLabel: String(stock.size ?? "").trim() || parsed.sizeLabel || "н/д",
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
      const companyName = String(stock.companyName ?? "").trim() || "н/д";
      const unitCost = getStockUnitCost({
        companyName,
        vendorCode,
        sku: stock.sku != null ? String(stock.sku) : null,
        ownCostPrice: stock.costPrice,
        costs: stockCostLookup,
      });
      return {
        companyName,
        marketplace: "OWN" as const,
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
  const sumChannel = (channel: InsightStockRow["marketplace"]) => {
    const part = stockWithCost.filter((r) => r.marketplace === channel);
    if (part.length === 0) return null;
    return part.reduce((sum, row) => sum + (row.frozenMoney ?? 0), 0);
  };
  const stockAtCostWb = sumChannel("WB");
  const stockAtCostOzon = sumChannel("Ozon");
  const stockAtCostOwn = sumChannel("OWN");
  const stockMissingCostQty = stockRowsRaw.filter(
    (row) => row.costCoverage === "MISSING",
  ).length;
  const stockChannelDates = [wbStockAsOf, ozonStockAsOf, ownStockAsOf].filter(
    (d): d is string => Boolean(d),
  );
  const stockDatesMixed =
    stockChannelDates.length >= 2 &&
    new Set(stockChannelDates).size > 1;
  const todayIso = new Date().toISOString().slice(0, 10);
  const staleDays = (asOf: string | null): number | null => {
    if (!asOf) return null;
    const a = Date.parse(`${asOf}T00:00:00.000Z`);
    const b = Date.parse(`${todayIso}T00:00:00.000Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round((b - a) / 86400000);
  };
  const ozonStaleDays = staleDays(ozonStockAsOf);
  const wbStaleDays = staleDays(wbStockAsOf);
  const ownStaleDays = staleDays(ownStockAsOf);
  const stockStaleWarnings: string[] = [];
  if (ozonStaleDays != null && ozonStaleDays > STOCK_STALE_DAYS) {
    stockStaleWarnings.push(`Ozon FBO устарел ${ozonStaleDays}д (${ozonStockAsOf})`);
  }
  if (wbStaleDays != null && wbStaleDays > STOCK_STALE_DAYS) {
    stockStaleWarnings.push(`WB устарел ${wbStaleDays}д (${wbStockAsOf})`);
  }
  if (ownStaleDays != null && ownStaleDays > STOCK_STALE_DAYS) {
    stockStaleWarnings.push(`свой склад устарел ${ownStaleDays}д (${ownStockAsOf})`);
  }
  // Do not present a single confirmed total when channel as-of dates differ.
  const stockAtCost = stockDatesMixed
    ? null
    : stockWithCost.length > 0
      ? stockWithCost.reduce((sum, row) => sum + (row.frozenMoney ?? 0), 0)
      : null;

  // Photos — sequential
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

  type WbCardPhoto = {
    nmId: string;
    vendorCode: string | null;
    companyName: string;
    photoSmallUrl: string | null;
    photoBigUrl: string | null;
  };
  type OzonProductPhoto = {
    sku: string;
    vendorCode: string;
    companyName: string | null;
    imageSmallUrl: string | null;
    imageUrl: string | null;
  };
  let wbCards: WbCardPhoto[] = [];
  let ozonProducts: OzonProductPhoto[] = [];
  try {
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
    if (wbWhere) {
      wbCards = await prisma.wbProductCard.findMany({
        where: wbWhere,
        select: {
          nmId: true,
          vendorCode: true,
          companyName: true,
          photoSmallUrl: true,
          photoBigUrl: true,
        },
        take: 800,
      });
    }
    if (ozonKeys.length) {
      ozonProducts = await prisma.ozonProduct.findMany({
        where: {
          OR: [{ sku: { in: ozonKeys } }, { vendorCode: { in: ozonKeys } }],
        },
        select: {
          sku: true,
          vendorCode: true,
          companyName: true,
          imageSmallUrl: true,
          imageUrl: true,
        },
        take: 800,
      });
    }
  } catch {
    /* photos optional */
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
      /* keep */
    }
    return url;
  };

  const imageByKey = new Map<string, string>();
  const putImage = (key: string, raw: string | null | undefined) => {
    const url = toDisplayImageUrl(raw);
    if (!url || imageByKey.has(key)) return;
    imageByKey.set(key, url);
  };
  for (const card of wbCards) {
    const company = card.companyName || "";
    const raw = card.photoSmallUrl || card.photoBigUrl;
    putImage(`WB|${company}|id:${card.nmId}`, raw);
    putImage(`WB|id:${card.nmId}`, raw);
    const vc = normalizeVendorCode(card.vendorCode);
    if (vc) {
      putImage(`WB|${company}|vc:${vc}`, raw);
      putImage(`WB|vc:${vc}`, raw);
    }
  }
  for (const product of ozonProducts) {
    const company = product.companyName || "";
    const raw = product.imageSmallUrl || product.imageUrl;
    putImage(`Ozon|${company}|id:${product.sku}`, raw);
    putImage(`Ozon|id:${product.sku}`, raw);
    const vc = normalizeVendorCode(product.vendorCode);
    if (vc) {
      putImage(`Ozon|${company}|vc:${vc}`, raw);
      putImage(`Ozon|vc:${vc}`, raw);
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
    for (const key of candidates) {
      const hit = imageByKey.get(key);
      if (hit) return { ...row, imageUrl: hit };
    }
    return { ...row, imageUrl: null };
  };
  const withImages = <T extends InsightSkuRow | InsightStockRow>(list: T[]) =>
    list.map(attachImage);

  const salesKeys = new Set(
    rows
      .filter((r) => r.revenue > 0)
      .map((r) =>
        `${r.companyName}|${r.marketplace}|${normalizeVendorCode(r.vendorCode || r.sku)}`,
      ),
  );
  const stockKeys = new Set(
    stockRowsRaw.map(
      (r) =>
        `${r.companyName}|${r.marketplace === "OWN" ? "Ozon" : r.marketplace}|${normalizeVendorCode(r.vendorCode || r.sku)}`,
    ),
  );
  let noMovementSkuCount = 0;
  let excessStockSkuCount = 0;
  for (const key of stockKeys) {
    if (!salesKeys.has(key.replace("|OWN|", "|Ozon|")) && !salesKeys.has(key)) {
      noMovementSkuCount += 1;
    }
  }
  for (const row of stockWithCost.slice(0, 200)) {
    if ((row.frozenMoney ?? 0) > 50000) excessStockSkuCount += 1;
  }
  const problemKeys = new Set<string>();
  for (const row of [...soldLoss, ...lowMarginRows]) {
    problemKeys.add(
      `${row.companyName}|${row.marketplace}|${normalizeVendorCode(row.vendorCode || row.sku)}`,
    );
  }

  const driverSkuPatches: InsightsDetailSnapshot["driverSkuPatches"] = [
    { marketplace: "WB", skuRevenue: null, skuProfit: null, soldProfit: null, adjustmentProfit: null, adjustmentSkuCount: null },
    { marketplace: "Ozon", skuRevenue: null, skuProfit: null, soldProfit: null, adjustmentProfit: null, adjustmentSkuCount: null },
  ];
  if (skuLayerReady) {
    for (const slice of driverSkuPatches) {
      slice.skuRevenue = 0;
      slice.skuProfit = 0;
      slice.soldProfit = 0;
      slice.adjustmentProfit = 0;
      slice.adjustmentSkuCount = 0;
    }
    for (const row of rows) {
      const slice = driverSkuPatches.find((d) => d.marketplace === row.marketplace)!;
      slice.skuRevenue = (slice.skuRevenue ?? 0) + row.revenue;
      slice.skuProfit = (slice.skuProfit ?? 0) + row.profit;
      if (row.anomaly !== "NONE") {
        slice.adjustmentProfit = (slice.adjustmentProfit ?? 0) + row.profit;
        slice.adjustmentSkuCount = (slice.adjustmentSkuCount ?? 0) + 1;
      } else if (row.revenue > 0) {
        slice.soldProfit = (slice.soldProfit ?? 0) + row.profit;
      }
    }
  }

  const nowLabel = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  return {
    skuStatus,
    skuStatusReason,
    rebuildPending,
    rebuildDetail: rebuildDetails.join("|"),
    detailGeneratedAtLabel: nowLabel,
    lossSkuCount,
    lossCountIsUniqueIdentity: !(skuTruncated && skuLossCountDb != null),
    stockAtCost,
    stockAtCostWb,
    stockAtCostOzon,
    stockAtCostOwn,
    stockMissingCostQty,
    frozenCoveragePartial:
      stockMissingCostQty > 0 ||
      stockDatesMixed ||
      stockStaleWarnings.length > 0,
    frozenAsOfLabel: [
      stockDatesMixed
        ? "каналы на разных датах — единый итог не подтверждён"
        : "текущий snapshot × ProductCost",
      wbStockAsOf ? `WB ${wbStockAsOf}` : "WB н/д",
      ozonStockAsOf ? `Ozon FBO ${ozonStockAsOf}` : "Ozon FBO н/д",
      ownStockAsOf ? `свой ${ownStockAsOf}` : "свой н/д",
      stockMissingCostQty > 0
        ? `себестоимость частично (без cost: ${stockMissingCostQty} поз.)`
        : null,
      ...stockStaleWarnings,
    ]
      .filter(Boolean)
      .join(" · "),
    skuDetail: {
      skuRevenue: skuLayerReady ? skuRevenue : null,
      soldProfit: skuLayerReady ? soldProfitTotal : null,
      adjustmentProfit: skuLayerReady ? adjustmentProfitSum : null,
      skuProfitTotal: skuLayerReady ? skuProfitTotal : null,
      salesMarginPercent: skuLayerReady
        ? marginOrNull(skuRevenue, soldProfitTotal)
        : null,
      truncated: skuTruncated,
      totalSkuRows: skuTotalInDb,
    },
    attention: {
      lossSkuCount,
      lowMarginSkuCount: skuLayerReady
        ? skuTruncated
          ? null
          : lowMarginRows.length
        : null,
      profitableSkuCount: skuLayerReady
        ? skuTruncated
          ? null
          : soldProfitable.length
        : null,
      stockAtCost,
    },
    driverSkuPatches,
    problems: {
      uniqueProblemSkuCount: skuLayerReady
        ? skuTruncated
          ? null
          : problemKeys.size
        : null,
      lossSkuCount,
      lowMarginSkuCount: skuLayerReady
        ? skuTruncated
          ? null
          : lowMarginRows.length
        : null,
      noMovementSkuCount: skuLayerReady ? noMovementSkuCount : null,
      excessStockSkuCount: skuLayerReady ? excessStockSkuCount : null,
    },
    profitablePreview: skuLayerReady
      ? withImages(soldProfitable.slice(0, 5))
      : [],
    profitableAll: skuLayerReady
      ? withImages(soldProfitable.slice(0, 20))
      : [],
    lossPreview: skuLayerReady ? withImages(soldLoss.slice(0, 5)) : [],
    lossAll: skuLayerReady ? withImages(soldLoss.slice(0, 20)) : [],
    adjustments: withImages(skuLayerReady ? adjustments.slice(0, 30) : []),
    adjustmentSummary: {
      skuCount: skuLayerReady ? adjustments.length : null,
      profitSum: skuLayerReady ? adjustmentProfitSum : null,
      status: !skuLayerReady
        ? "PENDING"
        : adjustments.length > 0
          ? "READY"
          : "EMPTY",
    },
    lowMarginPreview: withImages(
      skuLayerReady && !skuTruncated ? lowMarginRows.slice(0, 5) : [],
    ),
    lowMarginAll: withImages(
      skuLayerReady && !skuTruncated ? lowMarginRows.slice(0, 20) : [],
    ),
    frozenPreview: withImages(stockWithCost.slice(0, 5)),
    frozenAll: withImages(stockWithCost.slice(0, 20)),
  };
}

/** Empty detail shell so Level A can render immediately. */
export function emptyInsightsDetailPending(): InsightsDetailSnapshot {
  return {
    skuStatus: "PENDING",
    skuStatusReason: "DETAIL_ASYNC_PENDING",
    rebuildPending: false,
    rebuildDetail: "",
    detailGeneratedAtLabel: "",
    lossSkuCount: null,
    lossCountIsUniqueIdentity: true,
    stockAtCost: null,
    stockAtCostWb: null,
    stockAtCostOzon: null,
    stockAtCostOwn: null,
    stockMissingCostQty: 0,
    frozenCoveragePartial: false,
    frozenAsOfLabel: "загрузка…",
    skuDetail: {
      skuRevenue: null,
      soldProfit: null,
      adjustmentProfit: null,
      skuProfitTotal: null,
      salesMarginPercent: null,
      truncated: false,
      totalSkuRows: null,
    },
    attention: {
      lossSkuCount: null,
      lowMarginSkuCount: null,
      profitableSkuCount: null,
      stockAtCost: null,
    },
    driverSkuPatches: [
      {
        marketplace: "WB",
        skuRevenue: null,
        skuProfit: null,
        soldProfit: null,
        adjustmentProfit: null,
        adjustmentSkuCount: null,
      },
      {
        marketplace: "Ozon",
        skuRevenue: null,
        skuProfit: null,
        soldProfit: null,
        adjustmentProfit: null,
        adjustmentSkuCount: null,
      },
    ],
    problems: {
      uniqueProblemSkuCount: null,
      lossSkuCount: null,
      lowMarginSkuCount: null,
      noMovementSkuCount: null,
      excessStockSkuCount: null,
    },
    profitablePreview: [],
    profitableAll: [],
    lossPreview: [],
    lossAll: [],
    adjustments: [],
    adjustmentSummary: { skuCount: null, profitSum: null, status: "PENDING" },
    lowMarginPreview: [],
    lowMarginAll: [],
    frozenPreview: [],
    frozenAll: [],
  };
}
