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

  // Prefer per-company SKU scopes (canonical ownership). ALL-scope rows often
  // omit payload.companyName — do not invent "—".
  const preferredScopes =
    selectedCompany === "ALL" ? activeCompanies : [selectedCompany];
  let skuWhere: {
    companyScope: string | { in: string[] };
    dateFrom: Date;
    dateTo: Date;
  } = {
    companyScope:
      preferredScopes.length === 1
        ? preferredScopes[0]
        : { in: preferredScopes },
    dateFrom: dayStartUtc(dateFrom),
    dateTo: dayStartUtc(dateTo),
  };
  let skuLoadMode: "PER_COMPANY" | "ALL_SCOPE" = "PER_COMPANY";

  let skuRows: Awaited<
    ReturnType<typeof prisma.profitSkuPeriodMetric.findMany>
  > = [];

  try {
    skuTotalInDb = await prisma.profitSkuPeriodMetric.count({ where: skuWhere });
    if (skuTotalInDb === 0 && selectedCompany === "ALL") {
      skuWhere = {
        companyScope: "ALL",
        dateFrom: dayStartUtc(dateFrom),
        dateTo: dayStartUtc(dateTo),
      };
      skuLoadMode = "ALL_SCOPE";
      skuTotalInDb = await prisma.profitSkuPeriodMetric.count({
        where: skuWhere,
      });
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
      skuRows = await prisma.profitSkuPeriodMetric.findMany({ where: skuWhere });
      skuStatus = "READY";
      skuStatusReason = `PROFIT_SKU_PERIOD_HIT:${skuLoadMode}:rows=${skuRows.length}`;
    } else {
      skuTruncated = true;
      const ranked = await prisma.profitSkuPeriodMetric.findMany({
        where: skuWhere,
        take: SKU_FULL_LOAD_CAP,
      });
      // Rank in memory under pool=1 — avoid ambiguous ALL/IN raw SQL.
      const scored = ranked.map((row) => {
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
      const byId = new Map<string, (typeof ranked)[number]>();
      for (const item of [...topProfit, ...topLoss]) byId.set(item.row.id, item.row);
      skuRows = Array.from(byId.values());
      skuStatus = "PRELIMINARY";
      skuStatusReason = `PROFIT_SKU_PERIOD_HIT_TRUNCATED:${skuLoadMode}:shown=${skuRows.length};total=${skuTotalInDb}`;
    }
  } catch (error) {
    skuStatus = "UNAVAILABLE";
    skuStatusReason = `PROFIT_SKU_PERIOD_ERROR:${error instanceof Error ? error.message : String(error)}`;
  }

  // Canonical company ownership lookup for ALL-scope rows lacking payload.companyName.
  const companyByWbNm = new Map<string, string>();
  const companyByWbVendor = new Map<string, string>();
  const companyByOzonSku = new Map<string, string>();
  const companyByOzonVendor = new Map<string, string>();
  if (skuLoadMode === "ALL_SCOPE" && skuRows.length > 0) {
    try {
      const wbCards = await prisma.wbProductCard.findMany({
        where: { companyName: { in: activeCompanies } },
        select: { companyName: true, nmId: true, vendorCode: true },
        take: 5000,
      });
      for (const card of wbCards) {
        if (!card.companyName) continue;
        if (card.nmId) companyByWbNm.set(String(card.nmId).trim(), card.companyName);
        const vc = normalizeVendorCode(card.vendorCode);
        if (vc) companyByWbVendor.set(vc, card.companyName);
      }
      const ozonProducts = await prisma.ozonProduct.findMany({
        where: { companyName: { in: activeCompanies } },
        select: { companyName: true, sku: true, vendorCode: true },
        take: 5000,
      });
      for (const product of ozonProducts) {
        if (!product.companyName) continue;
        if (product.sku) {
          companyByOzonSku.set(String(product.sku).trim(), product.companyName);
        }
        const vc = normalizeVendorCode(product.vendorCode);
        if (vc) companyByOzonVendor.set(vc, product.companyName);
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
    if (fromPayload && fromPayload !== "ALL" && fromPayload !== "—") {
      return fromPayload;
    }
    if (params.companyScope && params.companyScope !== "ALL") {
      return params.companyScope;
    }
    const nmId = String(params.payload.nmId ?? "").trim();
    const vendorCode = normalizeVendorCode(params.payload.vendorCode);
    if (params.marketplace === "WB") {
      if (nmId && companyByWbNm.has(nmId)) return companyByWbNm.get(nmId)!;
      if (vendorCode && companyByWbVendor.has(vendorCode)) {
        return companyByWbVendor.get(vendorCode)!;
      }
    }
    if (params.marketplace === "OZON") {
      if (nmId && companyByOzonSku.has(nmId)) return companyByOzonSku.get(nmId)!;
      if (vendorCode && companyByOzonVendor.has(vendorCode)) {
        return companyByOzonVendor.get(vendorCode)!;
      }
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
  const skuLayerReady =
    skuStatus === "READY" || skuStatus === "PRELIMINARY";
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
  const stockAtCost = stockWithCost.reduce(
    (sum, row) => sum + (row.frozenMoney ?? 0),
    0,
  );
  const stockMissingCostQty = stockRowsRaw.filter(
    (row) => row.costCoverage === "MISSING",
  ).length;

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
    stockAtCost: stockWithCost.length > 0 ? stockAtCost : null,
    stockAtCostWb,
    stockAtCostOzon,
    stockAtCostOwn,
    stockMissingCostQty,
    frozenCoveragePartial:
      stockMissingCostQty > 0 ||
      (wbStockAsOf != null &&
        ozonStockAsOf != null &&
        wbStockAsOf !== ozonStockAsOf) ||
      (ownStockAsOf != null &&
        wbStockAsOf != null &&
        ownStockAsOf !== wbStockAsOf),
    frozenAsOfLabel: [
      "текущий snapshot × ProductCost",
      wbStockAsOf ? `WB ${wbStockAsOf}` : "WB н/д",
      ozonStockAsOf ? `Ozon FBO ${ozonStockAsOf}` : "Ozon FBO н/д",
      ownStockAsOf ? `свой ${ownStockAsOf}` : "свой н/д",
    ].join(" · "),
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
      stockAtCost: stockWithCost.length > 0 ? stockAtCost : null,
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
    profitablePreview: withImages(soldProfitable.slice(0, 5)),
    profitableAll: withImages(soldProfitable.slice(0, 20)),
    lossPreview: withImages(soldLoss.slice(0, 5)),
    lossAll: withImages(soldLoss.slice(0, 20)),
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
