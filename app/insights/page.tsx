import { prisma } from "@/lib/prisma";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import { getDefaultLastCompletedWeekRange } from "@/lib/date/defaultPeriod";

import InsightsDashboard from "./InsightsDashboard";
import type {
  InsightSkuRow,
  InsightStockRow,
  InsightsPayload,
  MarketplaceSlice,
} from "./insightsTypes";

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

function marginOrNull(revenue: number, profit: number): number | null {
  if (!(revenue > 0)) return null;
  return (profit / revenue) * 100;
}

function anomalyFor(revenue: number, profit: number): InsightSkuRow["anomaly"] {
  if (revenue !== 0) return "NONE";
  if (profit > 0) return "PROFIT_WITHOUT_REVENUE";
  if (profit < 0) return "LOSS_WITHOUT_REVENUE";
  return "NONE";
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

  const [analyticsByCompany, productCosts, wbStocks, ozonStocks] =
    await Promise.all([
      Promise.all(
        companyNames.map(async (companyName) => {
          const [wb, ozon] = await Promise.all([
            getProfitAnalytics({ dateFrom, dateTo, companyName }),
            getProfitAnalyticsOzon({ dateFrom, dateTo, companyName }),
          ]);
          return { companyName, wb, ozon };
        }),
      ),
      prisma.productCost.findMany({
        orderBy: [{ costDate: "desc" }, { createdAt: "desc" }],
      }),
      prisma.wbStock.findMany({
        where: selectedCompany !== "ALL" ? { companyName: selectedCompany } : {},
      }),
      prisma.ozonStock.findMany({
        where: selectedCompany !== "ALL" ? { companyName: selectedCompany } : {},
      }),
    ]);

  const costByVendorCode = new Map<string, number>();
  for (const cost of productCosts) {
    const key = normalizeVendorCode(cost.vendorCode);
    if (key && !costByVendorCode.has(key)) {
      costByVendorCode.set(key, getAmount(cost.costPrice));
    }
  }

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
        return {
          companyName,
          marketplace: "Ozon" as const,
          sku: String(row.nmId ?? ""),
          vendorCode: String(row.vendorCode ?? ""),
          subject: String((row as { subject?: string }).subject ?? ""),
          salesQty: getAmount(row.netSalesQty),
          revenue,
          profit,
          marginPercent: marginOrNull(revenue, profit),
          anomaly: anomalyFor(revenue, profit),
        };
      }),
    ],
  );

  const soldProfitable = rows
    .filter((row) => row.profit > 0 && row.revenue > 0)
    .sort((a, b) => b.profit - a.profit);

  const soldLoss = rows
    .filter((row) => row.profit < 0)
    .sort((a, b) => a.profit - b.profit);

  const adjustments = rows
    .filter((row) => row.anomaly !== "NONE")
    .sort((a, b) => Math.abs(b.profit) - Math.abs(a.profit));

  const lowMarginRows = rows
    .filter(
      (row) =>
        row.revenue > 0 &&
        row.marginPercent != null &&
        row.marginPercent < 5,
    )
    .sort(
      (a, b) => (a.marginPercent ?? 999) - (b.marginPercent ?? 999),
    );

  // Same aggregation as previous Insights page (SKU-row sum) for BEFORE/AFTER parity.
  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const totalProfit = rows.reduce((sum, row) => sum + row.profit, 0);
  const lossSkuCount = rows.filter((row) => row.profit < 0).length;

  const stockRowsRaw: InsightStockRow[] = [
    ...wbStocks.map((stock) => {
      const row = stock as unknown as Record<string, unknown>;
      const vendorCode = getAnyString(row, [
        "vendorCode",
        "supplierArticle",
        "article",
        "sku",
      ]);
      const quantity = getAnyNumber(row, [
        "quantity",
        "qty",
        "stockQty",
        "availableQty",
        "available",
        "quantityFull",
      ]);
      const key = normalizeVendorCode(vendorCode);
      const hasCost = key ? costByVendorCode.has(key) : false;
      const unitCost = hasCost ? (costByVendorCode.get(key) ?? 0) : null;
      return {
        companyName: getAnyString(row, ["companyName"]) || "—",
        marketplace: "WB" as const,
        sku: getAnyString(row, ["nmId", "sku", "barcode"]),
        vendorCode,
        quantity,
        unitCost,
        frozenMoney:
          unitCost == null ? null : quantity * unitCost,
        costCoverage: hasCost ? ("FULL" as const) : ("MISSING" as const),
      };
    }),
    ...ozonStocks.map((stock) => {
      const row = stock as unknown as Record<string, unknown>;
      const vendorCode = getAnyString(row, [
        "vendorCode",
        "offerId",
        "article",
        "sku",
      ]);
      const quantity = getAnyNumber(row, [
        "quantity",
        "qty",
        "stockQty",
        "availableQty",
        "available",
        "availableToSell",
      ]);
      const key = normalizeVendorCode(vendorCode);
      const hasCost = key ? costByVendorCode.has(key) : false;
      const unitCost = hasCost ? (costByVendorCode.get(key) ?? 0) : null;
      return {
        companyName: getAnyString(row, ["companyName"]) || "—",
        marketplace: "Ozon" as const,
        sku: getAnyString(row, ["sku", "productId", "barcode"]),
        vendorCode,
        quantity,
        unitCost,
        frozenMoney:
          unitCost == null ? null : quantity * unitCost,
        costCoverage: hasCost ? ("FULL" as const) : ("MISSING" as const),
      };
    }),
  ].filter((row) => row.quantity > 0);

  const stockWithCost = stockRowsRaw
    .filter((row) => row.frozenMoney != null && (row.frozenMoney ?? 0) > 0)
    .sort((a, b) => (b.frozenMoney ?? 0) - (a.frozenMoney ?? 0));

  const frozenMoney = stockWithCost.reduce(
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

  // Excess stock heuristic: in stock, no sales in period, with known COGS (залежавшиеся).
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
    if (
      row.revenue > 0 &&
      row.marginPercent != null &&
      row.marginPercent < 5
    ) {
      problemKeys.add(
        `${row.marketplace}|${normalizeVendorCode(row.vendorCode || row.sku)}`,
      );
    }
  }

  const driversMap = new Map<string, MarketplaceSlice>();
  for (const mp of ["WB", "Ozon"] as const) {
    driversMap.set(mp, {
      marketplace: mp,
      revenue: 0,
      profit: 0,
      marginPercent: null,
    });
  }
  for (const row of rows) {
    const slice = driversMap.get(row.marketplace)!;
    slice.revenue += row.revenue;
    slice.profit += row.profit;
  }
  for (const slice of driversMap.values()) {
    slice.marginPercent = marginOrNull(slice.revenue, slice.profit);
  }

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
      revenue: totalRevenue,
      netProfit: totalProfit,
      netMarginPercent: marginOrNull(totalRevenue, totalProfit),
      lossSkuCount,
      frozenMoney: stockWithCost.length > 0 ? frozenMoney : null,
      frozenCoveragePartial: stockMissingCost,
      frozenAsOfLabel: "текущий снимок остатков",
    },
    attention: {
      lossSkuCount,
      lowMarginSkuCount: lowMarginRows.length,
      profitableSkuCount: soldProfitable.length,
      frozenMoney: stockWithCost.length > 0 ? frozenMoney : null,
    },
    drivers: Array.from(driversMap.values()),
    problems: {
      uniqueProblemSkuCount: problemKeys.size,
      lossSkuCount,
      lowMarginSkuCount: lowMarginRows.length,
      noMovementSkuCount,
      excessStockSkuCount,
    },
    profitablePreview: soldProfitable.slice(0, 5),
    profitableAll: soldProfitable.slice(0, 20),
    lossPreview: soldLoss.slice(0, 5),
    lossAll: soldLoss.slice(0, 20),
    adjustments: adjustments.slice(0, 30),
    lowMarginPreview: lowMarginRows.slice(0, 5),
    lowMarginAll: lowMarginRows.slice(0, 20),
    frozenPreview: stockWithCost.slice(0, 5),
    frozenAll: stockWithCost.slice(0, 20),
  };

  return <InsightsDashboard data={payload} />;
}
