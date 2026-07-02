import Link from "next/link";
import type { ReactNode } from "react";

import { prisma } from "@/lib/prisma";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";

type SortKey =
  | "revenue"
  | "netSalesQty"
  | "expenses"
  | "netProfitAfterTax"
  | "buyoutPercent"
  | "marginAfterTaxPercent"
  | "adsCost"
  | "drrPercent";

type SortDir = "asc" | "desc";
type AbcFilter = "ALL" | "A" | "B" | "C" | "LOSS";

type OzonAnalyticsResult = Awaited<ReturnType<typeof getProfitAnalyticsOzon>>;
type OzonRow = OzonAnalyticsResult["rows"][number];

type SearchParams = {
  dateFrom?: string;
  dateTo?: string;
  usnRate?: string;
  vatRate?: string;
  companyName?: string;
  sort?: string;
  dir?: string;
  q?: string;
  abc?: string;
  pageSize?: string;
};

type ProductMeta = {
  productName: string;
  subject: string;
  sku: string;
  vendorCode: string;
  imageUrl?: string | null;
};

type SkuBreakdownRow = {
  sku: string;
  vendorCode: string;
  sizeLabel: string;
  revenue: number;
  netSalesQty: number;
  salesQty: number;
  returnsQty: number;
  expenses: number;
  netProfitAfterTax: number;
  buyoutPercent: number | null;
  marginAfterTaxPercent: number;
  abcByRevenue: "A" | "B" | "C";
  abcByProfit: "A" | "B" | "C";
};

type RawSkuMetric = {
  sku: string;
  vendorCode: string;
  revenue: number;
  salesQty: number;
  returnsQty: number;
  netSalesQty: number;
};

type EnrichedOzonRow = OzonRow & {
  abcByRevenue: "A" | "B" | "C";
  productMeta: ProductMeta;
  skuRows: SkuBreakdownRow[];
};

type OzonProductRecord = {
  vendorCode: string;
  sku: string;
  productName: string | null;
  imageUrl: string | null;
  imageSmallUrl: string | null;
};

type OzonFinanceBreakdownRecord = {
  accrualDate: Date | null;
  sku: string | null;
  vendorCode: string | null;
  quantity: number | null;
  salesAmount: unknown;
  totalAmount: unknown;
  importSessionId: string | null;
  createdAt: Date;
};

const DEFAULT_DATE_FROM = "2026-05-18";
const DEFAULT_DATE_TO = "2026-05-24";
const DEFAULT_PAGE_SIZE = 15;
const PAGE_SIZE_OPTIONS = [10, 15, 20, 30, 50];

const ABC_FILTERS: { key: AbcFilter; label: string }[] = [
  { key: "ALL", label: "Все" },
  { key: "A", label: "A" },
  { key: "B", label: "B" },
  { key: "C", label: "C" },
  { key: "LOSS", label: "Убыточные" },
];

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  if (typeof value === "object" && "toNumber" in value) {
    return (value as { toNumber: () => number }).toNumber();
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function startOfDay(value: string) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function nextDayStart(value: string) {
  const date = startOfDay(value);
  date.setDate(date.getDate() + 1);
  return date;
}

function createDateWhere(dateFrom?: string | null, dateTo?: string | null) {
  return dateFrom || dateTo
    ? {
        ...(dateFrom ? { gte: startOfDay(dateFrom) } : {}),
        ...(dateTo ? { lt: nextDayStart(dateTo) } : {}),
      }
    : undefined;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatCompactMoney(value: number) {
  const safe = Number.isFinite(value) ? value : 0;

  if (Math.abs(safe) >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(1).replace(".", ",")} млн ₽`;
  }

  if (Math.abs(safe) >= 1_000) {
    return `${Math.round(safe / 1_000).toLocaleString("ru-RU")} тыс. ₽`;
  }

  return formatMoney(safe);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function formatDateRu(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatDeltaPercent(value: number, inverse = false) {
  if (!Number.isFinite(value) || value === 0) {
    return {
      text: "0.0%",
      className: "text-slate-500",
    };
  }

  const isGood = inverse ? value < 0 : value > 0;
  const sign = value > 0 ? "+" : "";

  return {
    text: `${sign}${value.toFixed(1)}%`,
    className: isGood ? "text-emerald-600" : "text-red-600",
  };
}

function formatShare(value: number, total: number, label = "от выручки") {
  if (!total || total <= 0) return `0.0% ${label}`;
  return `${((value / total) * 100).toFixed(1)}% ${label}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function profitTextColor(value: number) {
  if (value < 0) return "text-red-600";
  return "text-emerald-600";
}

function metricBarColor(value: number) {
  if (value < 0) return "bg-red-500";
  if (value < 10) return "bg-orange-400";
  return "bg-emerald-500";
}

function rowExpenses(row: OzonRow) {
  return row.revenue - row.netProfitAfterTax;
}

function rowBuyoutPercent(row: OzonRow) {
  const denominator = row.salesQty + row.returnsQty;
  if (denominator <= 0) return null;
  return (Math.max(0, row.netSalesQty) / denominator) * 100;
}

function calculateAbcByPositiveValue<T>(
  rows: T[],
  getValue: (row: T) => number
): Map<T, "A" | "B" | "C"> {
  const result = new Map<T, "A" | "B" | "C">();

  const sorted = [...rows].sort(
    (a, b) => Math.max(0, getValue(b)) - Math.max(0, getValue(a))
  );

  const total = sorted.reduce((sum, row) => sum + Math.max(0, getValue(row)), 0);

  if (total <= 0) {
    for (const row of rows) result.set(row, "C");
    return result;
  }

  let cumulative = 0;

  for (const row of sorted) {
    const positive = Math.max(0, getValue(row));

    if (positive <= 0) {
      result.set(row, "C");
      continue;
    }

    const shareBefore = cumulative / total;
    cumulative += positive;

    if (shareBefore < 0.8) {
      result.set(row, "A");
    } else if (shareBefore < 0.95) {
      result.set(row, "B");
    } else {
      result.set(row, "C");
    }
  }

  return result;
}

function getSortValue(row: EnrichedOzonRow, sortKey: SortKey) {
  if (sortKey === "expenses") return rowExpenses(row);
  if (sortKey === "buyoutPercent") return rowBuyoutPercent(row) ?? -1;

  return Number(row[sortKey] ?? 0);
}

function buildQueryHref(
  params: SearchParams,
  patch: Partial<
    SearchParams & { abc: AbcFilter; sort: SortKey; dir: SortDir; pageSize: string }
  >
) {
  const query = new URLSearchParams();

  const next = {
    dateFrom: params.dateFrom ?? DEFAULT_DATE_FROM,
    dateTo: params.dateTo ?? DEFAULT_DATE_TO,
    usnRate: params.usnRate ?? "1",
    vatRate: params.vatRate ?? "5",
    companyName: params.companyName ?? "ALL",
    sort: params.sort ?? "netProfitAfterTax",
    dir: params.dir ?? "desc",
    q: params.q ?? "",
    abc: params.abc ?? "ALL",
    pageSize: params.pageSize ?? String(DEFAULT_PAGE_SIZE),
    ...patch,
  };

  query.set("dateFrom", next.dateFrom);
  query.set("dateTo", next.dateTo);
  query.set("usnRate", next.usnRate);
  query.set("vatRate", next.vatRate);
  query.set("companyName", next.companyName);
  query.set("sort", next.sort);
  query.set("dir", next.dir);
  query.set("abc", next.abc);
  query.set("pageSize", next.pageSize);

  if (next.q) query.set("q", next.q);

  return `/profit-ozon?${query.toString()}`;
}

function getSortLabel(sort: SortKey) {
  const labels: Record<SortKey, string> = {
    revenue: "выручке",
    netSalesQty: "количеству",
    expenses: "расходам",
    netProfitAfterTax: "прибыли",
    buyoutPercent: "проценту выкупа",
    marginAfterTaxPercent: "маржинальности",
    adsCost: "рекламе",
    drrPercent: "ДРР",
  };

  return labels[sort] ?? "прибыли";
}

function getCompanyLabel(companyName: string) {
  if (companyName === "ALL") return "Все компании";
  return companyName;
}

function parseOzonVendorCode(vendorCode: string) {
  const clean = cleanText(vendorCode);
  const parts = clean.split(/[-_]+/).filter(Boolean);
  const sizeParts: string[] = [];

  if (parts.length >= 2 && /^\d{2,4}$/.test(parts[parts.length - 1])) {
    sizeParts.unshift(parts.pop() ?? "");

    if (parts.length >= 2 && /^\d{2,4}$/.test(parts[parts.length - 1])) {
      sizeParts.unshift(parts.pop() ?? "");
    }
  }

  return {
    original: clean,
    baseArticle: parts.join("-") || clean,
    sizeLabel: sizeParts.filter(Boolean).join(" / ") || clean || "SKU",
  };
}

function getOzonGroupKey(vendorCode: string) {
  return parseOzonVendorCode(vendorCode).baseArticle;
}

function getOzonSizeLabel(vendorCode: string) {
  return parseOzonVendorCode(vendorCode).sizeLabel;
}

function stripOzonSizeSuffix(value: string) {
  return cleanText(value)
    .replace(/(?:[-_\s]+\d{2,4}){1,2}$/g, "")
    .trim();
}

function buildOzonProductLookup(products: OzonProductRecord[]) {
  const normalizedVendorCodeBySku = new Map<string, string>();
  const displayVendorCodeBySku = new Map<string, string>();
  const productNameBySku = new Map<string, string>();
  const productNameByVendorCode = new Map<string, string>();

  for (const product of products) {
    const sku = normalizeText(product.sku);
    const normalizedVendorCode = normalizeText(product.vendorCode);
    const displayVendorCode = cleanText(product.vendorCode);
    const productName = cleanText(product.productName);

    if (sku && normalizedVendorCode) {
      normalizedVendorCodeBySku.set(sku, normalizedVendorCode);
      displayVendorCodeBySku.set(sku, displayVendorCode || normalizedVendorCode);
    }

    if (sku && productName) {
      productNameBySku.set(sku, productName);
    }

    if (normalizedVendorCode && productName) {
      productNameByVendorCode.set(normalizedVendorCode, productName);
    }
  }

  return {
    normalizedVendorCodeBySku,
    displayVendorCodeBySku,
    productNameBySku,
    productNameByVendorCode,
  };
}

async function findLatestOzonFinanceRowsForBreakdown(params: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}) {
  const accrualDateWhere = createDateWhere(params.dateFrom, params.dateTo);

  const latestRow = await prisma.ozonFinance.findFirst({
    where: {
      ...(accrualDateWhere ? { accrualDate: accrualDateWhere } : {}),
      ...(params.companyName ? { companyName: params.companyName } : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!latestRow) return [] as OzonFinanceBreakdownRecord[];

  if (latestRow.importSessionId) {
    return prisma.ozonFinance.findMany({
      where: {
        importSessionId: latestRow.importSessionId,
        ...(accrualDateWhere ? { accrualDate: accrualDateWhere } : {}),
        ...(params.companyName ? { companyName: params.companyName } : {}),
      },
      select: {
        accrualDate: true,
        sku: true,
        vendorCode: true,
        quantity: true,
        salesAmount: true,
        totalAmount: true,
        importSessionId: true,
        createdAt: true,
      },
      orderBy: {
        accrualDate: "desc",
      },
    });
  }

  return prisma.ozonFinance.findMany({
    where: {
      ...(accrualDateWhere ? { accrualDate: accrualDateWhere } : {}),
      ...(params.companyName ? { companyName: params.companyName } : {}),
      createdAt: {
        gte: new Date(latestRow.createdAt.getTime() - 10 * 60 * 1000),
        lte: new Date(latestRow.createdAt.getTime() + 10 * 60 * 1000),
      },
    },
    select: {
      accrualDate: true,
      sku: true,
      vendorCode: true,
      quantity: true,
      salesAmount: true,
      totalAmount: true,
      importSessionId: true,
      createdAt: true,
    },
    orderBy: {
      accrualDate: "desc",
    },
  });
}

async function buildProductMetaAndSkuRows(params: {
  rows: OzonRow[];
  dateFrom: string;
  dateTo: string;
  companyName: string;
}) {
  const companyName = params.companyName === "ALL" ? null : params.companyName;

  const [financeRows, ozonProducts, productCosts] = await Promise.all([
    findLatestOzonFinanceRowsForBreakdown({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      companyName,
    }),
    prisma.ozonProduct.findMany({
      where: {
        ...(companyName ? { companyName } : {}),
      },
      select: {
        vendorCode: true,
        sku: true,
        productName: true,
        imageUrl: true,
        imageSmallUrl: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    }),
    prisma.productCost.findMany({
      select: {
        vendorCode: true,
        nmId: true,
        name: true,
      },
      orderBy: {
        costDate: "desc",
      },
    }),
  ]);

  const lookup = buildOzonProductLookup(ozonProducts);
  const metaByVendorCode = new Map<string, ProductMeta>();
  const rawSkuByVendorCode = new Map<string, Map<string, RawSkuMetric>>();

  for (const cost of productCosts) {
    const vendorKey = normalizeText(cost.vendorCode);
    if (!vendorKey || metaByVendorCode.has(vendorKey)) continue;

    metaByVendorCode.set(vendorKey, {
      productName: cost.name ?? cost.vendorCode,
      subject: "Ozon",
      sku: cost.nmId ?? "",
      vendorCode: cost.vendorCode,
      imageUrl: null,
    });
  }

  for (const product of ozonProducts) {
    const vendorKey = normalizeText(product.vendorCode);
    if (!vendorKey) continue;

    const current = metaByVendorCode.get(vendorKey);

    metaByVendorCode.set(vendorKey, {
      productName:
        cleanText(product.productName) ||
        current?.productName ||
        product.vendorCode,
      subject: "Ozon",
      sku: product.sku || current?.sku || "",
      vendorCode: product.vendorCode || current?.vendorCode || vendorKey,
      imageUrl: product.imageSmallUrl ?? product.imageUrl ?? current?.imageUrl ?? null,
    });
  }

  for (const financeRow of financeRows) {
    const skuKey = normalizeText(financeRow.sku);
    const directVendorCodeKey = normalizeText(financeRow.vendorCode);
    const mappedVendorCodeKey = skuKey
      ? lookup.normalizedVendorCodeBySku.get(skuKey) ?? ""
      : "";

    const vendorKey = directVendorCodeKey || mappedVendorCodeKey || skuKey;
    if (!vendorKey) continue;

    const displayVendorCode =
      cleanText(financeRow.vendorCode) ||
      (skuKey ? lookup.displayVendorCodeBySku.get(skuKey) : "") ||
      cleanText(financeRow.sku) ||
      vendorKey;

    const productName =
      (skuKey ? lookup.productNameBySku.get(skuKey) : "") ||
      lookup.productNameByVendorCode.get(vendorKey) ||
      displayVendorCode;

    const currentMeta = metaByVendorCode.get(vendorKey);

    metaByVendorCode.set(vendorKey, {
      productName: currentMeta?.productName || productName || displayVendorCode,
      subject: currentMeta?.subject || "Ozon",
      sku: currentMeta?.sku || cleanText(financeRow.sku),
      vendorCode: currentMeta?.vendorCode || displayVendorCode,
      imageUrl: currentMeta?.imageUrl ?? null,
    });

    const sku = cleanText(financeRow.sku) || displayVendorCode;
    const skuMap = rawSkuByVendorCode.get(vendorKey) ?? new Map<string, RawSkuMetric>();

    const current =
      skuMap.get(sku) ??
      {
        sku,
        vendorCode: displayVendorCode,
        revenue: 0,
        salesQty: 0,
        returnsQty: 0,
        netSalesQty: 0,
      };

    const quantity = Math.abs(Number(financeRow.quantity ?? 0));
    const revenue = toNumber(financeRow.salesAmount);
    const totalAmount = toNumber(financeRow.totalAmount);

    if (revenue > 0 || quantity > 0) {
      current.salesQty += quantity;
      current.netSalesQty += quantity;
      current.revenue += revenue;
    }

    if (revenue < 0 || totalAmount < 0) {
      current.returnsQty += quantity;
      current.netSalesQty -= quantity;
      current.revenue += revenue;
    }

    skuMap.set(sku, current);
    rawSkuByVendorCode.set(vendorKey, skuMap);
  }

  const skuRowsByVendorCode = new Map<string, SkuBreakdownRow[]>();

  for (const row of params.rows) {
    const vendorKey = normalizeText(row.vendorCode);
    const skuMap = rawSkuByVendorCode.get(vendorKey);

    if (!skuMap || skuMap.size === 0) continue;

    const rawSkuRows = Array.from(skuMap.values())
      .filter((skuRow) => skuRow.salesQty > 0 || skuRow.revenue !== 0)
      .sort((a, b) => b.revenue - a.revenue);

    const rawRevenueTotal = rawSkuRows.reduce(
      (sum, skuRow) => sum + Math.max(0, skuRow.revenue),
      0
    );

    const rawQtyTotal = rawSkuRows.reduce(
      (sum, skuRow) => sum + Math.max(0, skuRow.netSalesQty),
      0
    );

    const expenses = rowExpenses(row);
    const abcByRevenue = calculateAbcByPositiveValue(
      rawSkuRows,
      (skuRow) => skuRow.revenue
    );

    const provisionalProfitRows = rawSkuRows.map((skuRow) => {
      const share =
        rawRevenueTotal > 0
          ? Math.max(0, skuRow.revenue) / rawRevenueTotal
          : rawQtyTotal > 0
            ? Math.max(0, skuRow.netSalesQty) / rawQtyTotal
            : 1 / Math.max(1, rawSkuRows.length);

      return {
        skuRow,
        value: row.netProfitAfterTax * share,
      };
    });

    const abcByProfit = calculateAbcByPositiveValue(
      provisionalProfitRows,
      (item) => item.value
    );

    const enrichedSkuRows = provisionalProfitRows.map((item) => {
      const skuRow = item.skuRow;
      const share =
        rawRevenueTotal > 0
          ? Math.max(0, skuRow.revenue) / rawRevenueTotal
          : rawQtyTotal > 0
            ? Math.max(0, skuRow.netSalesQty) / rawQtyTotal
            : 1 / Math.max(1, rawSkuRows.length);

      const allocatedRevenue = row.revenue * share;
      const allocatedExpenses = expenses * share;
      const allocatedProfit = row.netProfitAfterTax * share;
      const denominator = skuRow.salesQty + skuRow.returnsQty;
      const buyoutPercent =
        denominator > 0
          ? (Math.max(0, skuRow.netSalesQty) / denominator) * 100
          : null;

      return {
        sku: skuRow.sku,
        vendorCode: skuRow.vendorCode,
        sizeLabel: getOzonSizeLabel(skuRow.vendorCode),
        revenue: allocatedRevenue,
        netSalesQty: skuRow.netSalesQty,
        salesQty: skuRow.salesQty,
        returnsQty: skuRow.returnsQty,
        expenses: allocatedExpenses,
        netProfitAfterTax: allocatedProfit,
        buyoutPercent,
        marginAfterTaxPercent:
          allocatedRevenue > 0 ? (allocatedProfit / allocatedRevenue) * 100 : 0,
        abcByRevenue: abcByRevenue.get(skuRow) ?? "C",
        abcByProfit: abcByProfit.get(item) ?? "C",
      };
    });

    skuRowsByVendorCode.set(vendorKey, enrichedSkuRows);
  }

  return {
    metaByVendorCode,
    skuRowsByVendorCode,
  };
}

function createSkuRowFromProductRow(row: EnrichedOzonRow): SkuBreakdownRow {
  return {
    sku: row.nmId || row.productMeta.sku || row.vendorCode,
    vendorCode: row.vendorCode,
    sizeLabel: getOzonSizeLabel(row.vendorCode),
    revenue: row.revenue,
    netSalesQty: row.netSalesQty,
    salesQty: row.salesQty,
    returnsQty: row.returnsQty,
    expenses: rowExpenses(row),
    netProfitAfterTax: row.netProfitAfterTax,
    buyoutPercent: rowBuyoutPercent(row),
    marginAfterTaxPercent: row.marginAfterTaxPercent,
    abcByRevenue: row.abcByRevenue,
    abcByProfit: row.abcByProfit,
  };
}

function recalculateGroupedOzonRow(row: EnrichedOzonRow) {
  row.drrPercent = row.revenue > 0 ? (row.adsCost / row.revenue) * 100 : 0;
  row.marginProfitPercent =
    row.revenue > 0 ? (row.marginProfit / row.revenue) * 100 : 0;
  row.marginAfterTaxPercent =
    row.revenue > 0 ? (row.netProfitAfterTax / row.revenue) * 100 : 0;
  row.costPrice = row.netSalesQty > 0 ? row.totalCost / row.netSalesQty : 0;
}

function groupOzonRowsByBaseArticle(rows: EnrichedOzonRow[]) {
  const groups = new Map<string, EnrichedOzonRow>();

  for (const row of rows) {
    const groupKey = getOzonGroupKey(row.vendorCode);
    const existing = groups.get(groupKey);

    if (!existing) {
      const productName =
        stripOzonSizeSuffix(row.productMeta.productName) ||
        row.productMeta.productName ||
        groupKey;

      groups.set(groupKey, {
        ...row,
        vendorCode: groupKey,
        productMeta: {
          ...row.productMeta,
          productName,
          vendorCode: groupKey,
        },
        skuRows: [createSkuRowFromProductRow(row)],
      });

      continue;
    }

    existing.salesQty += row.salesQty;
    existing.returnsQty += row.returnsQty;
    existing.netSalesQty += row.netSalesQty;

    existing.revenue += row.revenue;
    existing.sellerPayout += row.sellerPayout;
    existing.wbCommission += row.wbCommission;
    existing.logisticsCost += row.logisticsCost;
    existing.storageCost += row.storageCost;
    existing.acceptanceCost += row.acceptanceCost;
    existing.penaltiesAmount += row.penaltiesAmount;
    existing.deductions += row.deductions;
    existing.paymentServiceCost += row.paymentServiceCost;
    existing.adsCost += row.adsCost;
    existing.totalCost += row.totalCost;
    existing.marginProfit += row.marginProfit;
    existing.taxesAmount += row.taxesAmount;
    existing.netProfitAfterTax += row.netProfitAfterTax;

    if (!existing.productMeta.imageUrl && row.productMeta.imageUrl) {
      existing.productMeta.imageUrl = row.productMeta.imageUrl;
    }

    existing.skuRows.push(createSkuRowFromProductRow(row));
  }

  const groupedRows = Array.from(groups.values());

  for (const group of groupedRows) {
    recalculateGroupedOzonRow(group);

    const childAbcByRevenue = calculateAbcByPositiveValue(
      group.skuRows,
      (row) => row.revenue
    );

    const childAbcByProfit = calculateAbcByPositiveValue(
      group.skuRows,
      (row) => row.netProfitAfterTax
    );

    group.skuRows = group.skuRows
      .map((row) => ({
        ...row,
        abcByRevenue: childAbcByRevenue.get(row) ?? "C",
        abcByProfit: childAbcByProfit.get(row) ?? "C",
      }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  const totalRevenue = groupedRows.reduce((sum, row) => sum + row.revenue, 0);
  const groupAbcByRevenue = calculateAbcByPositiveValue(
    groupedRows,
    (row) => row.revenue
  );
  const groupAbcByProfit = calculateAbcByPositiveValue(
    groupedRows,
    (row) => row.netProfitAfterTax
  );

  for (const row of groupedRows) {
    row.revenueSharePercent =
      totalRevenue > 0 ? (row.revenue / totalRevenue) * 100 : 0;
    row.abcByRevenue = groupAbcByRevenue.get(row) ?? "C";
    row.abcByProfit = groupAbcByProfit.get(row) ?? "C";
  }

  return groupedRows;
}

function polarToCartesian(
  centerX: number,
  centerY: number,
  radius: number,
  angleInDegrees: number
) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;

  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function describeDonutArc(
  startAngle: number,
  endAngle: number,
  outerRadius: number,
  innerRadius: number
) {
  const center = 130;
  const startOuter = polarToCartesian(center, center, outerRadius, endAngle);
  const endOuter = polarToCartesian(center, center, outerRadius, startAngle);
  const startInner = polarToCartesian(center, center, innerRadius, startAngle);
  const endInner = polarToCartesian(center, center, innerRadius, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

  return [
    "M",
    startOuter.x,
    startOuter.y,
    "A",
    outerRadius,
    outerRadius,
    0,
    largeArcFlag,
    0,
    endOuter.x,
    endOuter.y,
    "L",
    startInner.x,
    startInner.y,
    "A",
    innerRadius,
    innerRadius,
    0,
    largeArcFlag,
    1,
    endInner.x,
    endInner.y,
    "Z",
  ].join(" ");
}

function MiniTrendLine({
  points,
  tone = "indigo",
}: {
  points?: number[];
  tone?: "indigo" | "emerald" | "red" | "orange";
}) {
  const values =
    points && points.length >= 2 ? points : [8, 14, 10, 18, 16, 24, 20, 28];
  const width = 88;
  const height = 40;
  const padding = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const linePoints = values
    .map((value, index) => {
      const x = padding + (index * (width - padding * 2)) / (values.length - 1);
      const y =
        height - padding - ((value - min) / range) * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");

  const areaPoints = `${padding},${height - padding} ${linePoints} ${
    width - padding
  },${height - padding}`;

  const stroke =
    tone === "emerald"
      ? "#10b981"
      : tone === "red"
        ? "#ef4444"
        : tone === "orange"
          ? "#f97316"
          : "#2563eb";

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-10 w-24 shrink-0">
      <path d={`M ${areaPoints}`} fill={stroke} fillOpacity="0.08" />
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={linePoints}
      />
      {linePoints ? (
        <circle
          cx={linePoints.split(" ").slice(-1)[0].split(",")[0]}
          cy={linePoints.split(" ").slice(-1)[0].split(",")[1]}
          r="2.5"
          fill={stroke}
        />
      ) : null}
    </svg>
  );
}

function KpiCard({
  title,
  value,
  helper,
  delta,
  inverseDelta = false,
  sparkTone = "indigo",
  sparkPoints,
}: {
  title: string;
  value: ReactNode;
  helper: ReactNode;
  delta?: number;
  inverseDelta?: boolean;
  sparkTone?: "indigo" | "emerald" | "red" | "orange";
  sparkPoints?: number[];
}) {
  const formattedDelta =
    typeof delta === "number" ? formatDeltaPercent(delta, inverseDelta) : null;

  return (
    <div className="rounded-[26px] border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/40">
      <div className="flex items-center gap-1 text-sm font-black text-slate-700">
        <span>{title}</span>
        <span className="text-slate-300">ⓘ</span>
      </div>

      <div className="mt-2 text-[1.9rem] font-black leading-none tracking-tight text-slate-950">
        {value}
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          {formattedDelta ? (
            <div className={`text-sm font-black ${formattedDelta.className}`}>
              {formattedDelta.text}
            </div>
          ) : (
            <div className="text-sm font-black text-slate-400">&nbsp;</div>
          )}

          <div className="mt-1 text-xs font-semibold text-slate-500">
            {helper}
          </div>
        </div>

        <MiniTrendLine points={sparkPoints} tone={sparkTone} />
      </div>
    </div>
  );
}

function AbcBadge({ value }: { value: "A" | "B" | "C" }) {
  const className =
    value === "A"
      ? "bg-emerald-100 text-emerald-700 ring-emerald-200"
      : value === "B"
        ? "bg-amber-100 text-amber-700 ring-amber-200"
        : "bg-red-100 text-red-700 ring-red-200";

  return (
    <span
      className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-xs font-black ring-1 ${className}`}
    >
      {value}
    </span>
  );
}

function ProductImagePlaceholder({ meta }: { meta: ProductMeta }) {
  const initials =
    meta.productName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "OZ";

  return (
    <div className="flex h-16 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-sky-50 to-slate-100 text-xs font-black text-sky-400">
      {meta.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={meta.imageUrl}
          alt={meta.productName}
          className="h-full w-full object-cover"
        />
      ) : (
        initials
      )}
    </div>
  );
}

function MoneyWithShare({
  value,
  share,
  valueClassName = "text-slate-950",
}: {
  value: number;
  share: string;
  valueClassName?: string;
}) {
  return (
    <div>
      <div className={`text-base font-black ${valueClassName}`}>
        {formatMoney(value)}
      </div>
      <div className="mt-1 text-xs font-semibold text-slate-500">{share}</div>
    </div>
  );
}

function MarginBar({ value }: { value: number }) {
  const width = clamp((Math.max(0, value) / 30) * 100, 4, 100);

  return (
    <div>
      <div className={`text-base font-black ${profitTextColor(value)}`}>
        {formatPercent(value)}
      </div>
      <div className="mt-2 h-2 w-32 max-w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full ${metricBarColor(value)}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <span
        tabIndex={0}
        title={text}
        className="inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full bg-slate-100 text-[11px] font-black text-slate-400 ring-1 ring-slate-200 transition hover:bg-blue-50 hover:text-blue-700 hover:ring-blue-100"
      >
        ?
      </span>
      <span className="pointer-events-none absolute left-1/2 top-7 z-50 hidden w-80 -translate-x-1/2 rounded-2xl border border-slate-200 bg-white p-3 text-left text-xs font-semibold leading-5 text-slate-600 shadow-xl shadow-slate-200/70 group-hover:block group-focus-within:block">
        {text}
      </span>
    </span>
  );
}

function ExpenseDonut({
  rows,
  revenue,
}: {
  rows: { label: string; value: number; colorHex: string }[];
  revenue: number;
}) {
  const positiveRows = rows.filter((row) => row.value > 0);
  const positiveTotal = positiveRows.reduce((sum, row) => sum + row.value, 0);

  let cursor = 0;

  const segments = positiveRows.map((row) => {
    const size = positiveTotal > 0 ? (row.value / positiveTotal) * 360 : 0;
    const startAngle = cursor;
    const endAngle = cursor + Math.max(size, positiveRows.length === 1 ? 359.99 : 0);
    cursor += size;

    return {
      ...row,
      startAngle,
      endAngle,
      path: describeDonutArc(startAngle, endAngle, 112, 68),
    };
  });

  return (
    <div className="relative flex h-64 w-64 items-center justify-center">
      <svg
        viewBox="0 0 260 260"
        className="h-64 w-64 drop-shadow-sm"
        role="img"
        aria-label="Структура расходов Ozon"
      >
        <circle cx="130" cy="130" r="112" fill="#f1f5f9" />

        {segments.map((segment) => (
          <path
            key={segment.label}
            d={segment.path}
            fill={segment.colorHex}
            className="cursor-help transition hover:opacity-80"
          >
            <title>
              {`${segment.label}: ${formatMoney(segment.value)} · ${formatPercent(
                revenue > 0 ? (segment.value / revenue) * 100 : 0
              )} от выручки`}
            </title>
          </path>
        ))}

        <circle cx="130" cy="130" r="68" fill="white" />
      </svg>

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-black text-slate-950">
            {formatCompactMoney(revenue)}
          </div>
          <div className="mt-1 text-xs font-black uppercase tracking-[0.12em] text-slate-400">
            Экон. оборот
          </div>
        </div>
      </div>
    </div>
  );
}

function StructureLegendRow({
  label,
  value,
  share,
  colorHex,
}: {
  label: string;
  value: number;
  share: number;
  colorHex: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_105px_62px] items-center gap-3 text-sm">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: colorHex }}
        />
        <span className="truncate font-bold text-slate-600">{label}</span>
      </div>
      <div className="text-right font-black text-slate-900">
        {formatMoney(value)}
      </div>
      <div className="text-right font-bold text-slate-500">
        {formatPercent(share)}
      </div>
    </div>
  );
}

function AttentionItem({
  title,
  text,
  value,
  tone,
}: {
  title: string;
  text: string;
  value: string;
  tone: "red" | "orange" | "blue" | "violet";
}) {
  const styles =
    tone === "red"
      ? {
          row: "border-red-100 bg-red-50/70",
          icon: "bg-red-100 text-red-500 ring-red-100",
          title: "text-red-700",
          value: "text-red-600",
        }
      : tone === "orange"
        ? {
            row: "border-orange-100 bg-orange-50/70",
            icon: "bg-orange-100 text-orange-500 ring-orange-100",
            title: "text-orange-700",
            value: "text-orange-600",
          }
        : tone === "blue"
          ? {
              row: "border-sky-100 bg-sky-50/70",
              icon: "bg-sky-100 text-sky-500 ring-sky-100",
              title: "text-sky-700",
              value: "text-sky-600",
            }
          : {
              row: "border-violet-100 bg-violet-50/70",
              icon: "bg-violet-100 text-violet-500 ring-violet-100",
              title: "text-violet-700",
              value: "text-violet-600",
            };

  const icon =
    tone === "red" ? "!" : tone === "orange" ? "△" : tone === "blue" ? "◻" : "◔";

  return (
    <div className={`rounded-[22px] border px-4 py-4 ${styles.row}`}>
      <div className="flex items-center gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-black ring-1 ${styles.icon}`}
        >
          {icon}
        </span>

        <div className="min-w-0 flex-1">
          <div className={`text-base font-black ${styles.title}`}>{title}</div>
          <div className="mt-1 text-sm font-semibold text-slate-500">{text}</div>
        </div>

        <div className={`shrink-0 text-right text-xl font-black ${styles.value}`}>
          {value}
        </div>
        <span className="shrink-0 text-lg font-black text-slate-400">›</span>
      </div>
    </div>
  );
}

function TableHeader() {
  return (
    <div className="grid min-w-[1180px] grid-cols-[minmax(330px,1.7fr)_minmax(140px,0.8fr)_minmax(150px,0.85fr)_minmax(150px,0.85fr)_minmax(130px,0.7fr)_minmax(150px,0.8fr)] items-center border-b border-slate-200 bg-white px-5 py-4 text-sm font-black text-slate-500">
      <div>Товар</div>
      <div className="flex items-center gap-1">
        Выкупы
        <InfoTooltip text="Выкупы — сумма и количество фактически реализованных продаж по Ozon за выбранный период. Доля показывает вклад артикула в общую выручку Ozon. Бейдж A/B/C — ABC по выручке/выкупам." />
      </div>
      <div className="flex items-center gap-1">
        Расходы
        <InfoTooltip text="Расходы — все затраты по артикулу за выбранный период: себестоимость, комиссия Ozon, логистика, удержания/сторно, реклама и налоги." />
      </div>
      <div className="flex items-center gap-1">
        Прибыль
        <InfoTooltip text="Прибыль — прибыль после налогов: выручка минус все расходы. Процент под суммой показывает долю прибыли в выручке артикула. Бейдж A/B/C — ABC по прибыли." />
      </div>
      <div className="flex items-center gap-1">
        Процент выкупа
        <InfoTooltip text="Процент выкупа считается за выбранный период как чистые продажи / (продажи + возвраты) по данным Ozon Finance. Если данных для расчёта нет, показывается прочерк." />
      </div>
      <div className="flex items-center gap-1">
        Маржинальность
        <InfoTooltip text="Маржинальность — прибыль после налогов / выручка артикула × 100% за выбранный период. Шкала помогает быстро увидеть качество маржи." />
      </div>
    </div>
  );
}

function SkuRow({
  row,
  parentRevenue,
}: {
  row: SkuBreakdownRow;
  parentRevenue: number;
}) {
  return (
    <div className="grid min-w-[1180px] grid-cols-[minmax(330px,1.7fr)_minmax(140px,0.8fr)_minmax(150px,0.85fr)_minmax(150px,0.85fr)_minmax(130px,0.7fr)_minmax(150px,0.8fr)] items-center border-t border-slate-100 bg-slate-50/50 px-5 py-4 text-sm">
      <div className="flex items-center gap-3 pl-9">
        <div className="h-8 border-l border-dashed border-slate-300" />
        <div>
          <div className="font-black text-slate-800">
            Размер / SKU: {row.sizeLabel}
          </div>
          <div className="mt-1 text-xs font-semibold text-slate-400">
            {row.vendorCode} · {row.sku || "SKU не указан"}
          </div>
        </div>
      </div>

      <div className="flex items-start gap-2">
        <MoneyWithShare
          value={row.revenue}
          share={`${formatNumber(row.netSalesQty)} шт. · ${formatShare(
            row.revenue,
            parentRevenue,
            "от товара"
          )}`}
        />
        <AbcBadge value={row.abcByRevenue} />
      </div>

      <MoneyWithShare value={row.expenses} share={formatShare(row.expenses, row.revenue)} />

      <div className="flex items-start gap-2">
        <MoneyWithShare
          value={row.netProfitAfterTax}
          share={formatShare(row.netProfitAfterTax, row.revenue)}
          valueClassName={profitTextColor(row.netProfitAfterTax)}
        />
        <AbcBadge value={row.abcByProfit} />
      </div>

      <div className="text-base font-black text-slate-800">
        {formatPercent(row.buyoutPercent)}
      </div>

      <MarginBar value={row.marginAfterTaxPercent} />
    </div>
  );
}

function ProductRow({
  row,
  index,
  totalRevenue,
}: {
  row: EnrichedOzonRow;
  index: number;
  totalRevenue: number;
}) {
  const expenses = rowExpenses(row);
  const buyoutPercent = rowBuyoutPercent(row);
  const hasSkuDetails = row.skuRows.length > 1;
  const defaultOpen = index === 0 && hasSkuDetails;

  return (
    <details className="group border-t border-slate-100 first:border-t-0" open={defaultOpen}>
      <summary className="grid min-w-[1180px] cursor-pointer list-none grid-cols-[minmax(330px,1.7fr)_minmax(140px,0.8fr)_minmax(150px,0.85fr)_minmax(150px,0.85fr)_minmax(130px,0.7fr)_minmax(150px,0.8fr)] items-center px-5 py-4 transition hover:bg-slate-50">
        <div className="flex min-w-0 items-center gap-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl text-slate-500 transition group-open:rotate-180">
            {hasSkuDetails ? "⌄" : ""}
          </span>

          <ProductImagePlaceholder meta={row.productMeta} />

          <div className="min-w-0">
            <div className="max-w-[360px] truncate text-sm font-black text-slate-950">
              {row.productMeta.productName || row.vendorCode || "Товар Ozon"}
            </div>

            <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs font-semibold text-slate-500">
              <span>Артикул: {row.vendorCode || "—"}</span>
              <span>·</span>
              <span>{hasSkuDetails ? `${row.skuRows.length} SKU / размеров` : `SKU Ozon: ${row.nmId || row.productMeta.sku || "—"}`}</span>
            </div>

            <div className="mt-1 text-xs font-semibold text-slate-400">
              {row.productMeta.subject || row.subject || "Ozon"}
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <MoneyWithShare
            value={row.revenue}
            share={`${formatNumber(row.netSalesQty)} шт. · ${formatShare(
              row.revenue,
              totalRevenue,
              "от итога"
            )}`}
          />
          <AbcBadge value={row.abcByRevenue} />
        </div>

        <MoneyWithShare value={expenses} share={formatShare(expenses, row.revenue)} />

        <div className="flex items-start gap-2">
          <MoneyWithShare
            value={row.netProfitAfterTax}
            share={formatShare(row.netProfitAfterTax, row.revenue)}
            valueClassName={profitTextColor(row.netProfitAfterTax)}
          />
          <AbcBadge value={row.abcByProfit} />
        </div>

        <div className="text-base font-black text-slate-800">
          {formatPercent(buyoutPercent)}
        </div>

        <div className="flex items-center justify-between gap-3">
          <MarginBar value={row.marginAfterTaxPercent} />
          <span className="text-xl font-black text-slate-300">⋮</span>
        </div>
      </summary>

      {hasSkuDetails ? (
        <div>
          {row.skuRows.map((skuRow) => (
            <SkuRow
              key={`${row.vendorCode}-${skuRow.sku}`}
              row={skuRow}
              parentRevenue={row.revenue}
            />
          ))}
        </div>
      ) : null}
    </details>
  );
}

export default async function ProfitOzonPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = (await searchParams) ?? {};

  const dateFrom = params.dateFrom ?? DEFAULT_DATE_FROM;
  const dateTo = params.dateTo ?? DEFAULT_DATE_TO;
  const usnRate = params.usnRate ?? "1";
  const vatRate = params.vatRate ?? "5";
  const companyName = params.companyName ?? "ALL";
  const sort = (params.sort ?? "netProfitAfterTax") as SortKey;
  const dir = (params.dir === "asc" ? "asc" : "desc") as SortDir;
  const q = params.q ?? "";
  const abc = (params.abc ?? "ALL") as AbcFilter;
  const requestedPageSize = Number(params.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = PAGE_SIZE_OPTIONS.includes(requestedPageSize)
    ? requestedPageSize
    : DEFAULT_PAGE_SIZE;

  const { rows, totals, comparison } = await getProfitAnalyticsOzon({
    dateFrom,
    dateTo,
    usnRate,
    vatRate,
    companyName,
  });

  const abcByRevenue = calculateAbcByPositiveValue(rows, (row) => row.revenue);

  const { metaByVendorCode, skuRowsByVendorCode } =
    await buildProductMetaAndSkuRows({
      rows,
      dateFrom,
      dateTo,
      companyName,
    });

  const enrichedRows: EnrichedOzonRow[] = rows.map((row) => {
    const vendorKey = normalizeText(row.vendorCode);
    const fallbackMeta = {
      productName: row.vendorCode || "Товар Ozon",
      subject: row.subject || "Ozon",
      sku: row.nmId || "",
      vendorCode: row.vendorCode || "",
      imageUrl: null,
    };

    return {
      ...row,
      abcByRevenue: abcByRevenue.get(row) ?? "C",
      productMeta: metaByVendorCode.get(vendorKey) ?? fallbackMeta,
      skuRows: skuRowsByVendorCode.get(vendorKey) ?? [],
    };
  });

  const groupedRows = groupOzonRowsByBaseArticle(enrichedRows);

  const filteredRows = groupedRows.filter((row) => {
    const query = normalizeText(q);
    const haystack = normalizeText(
      [
        row.vendorCode,
        row.nmId,
        row.subject,
        row.productMeta.productName,
        row.productMeta.subject,
        row.skuRows.map((skuRow) => `${skuRow.vendorCode} ${skuRow.sku}`).join(" "),
      ].join(" ")
    );

    if (query && !haystack.includes(query)) return false;

    if (abc === "LOSS") return row.netProfitAfterTax < 0;
    if (abc === "A" || abc === "B" || abc === "C") {
      return row.abcByProfit === abc || row.abcByRevenue === abc;
    }

    return true;
  });

  const sortedRows = [...filteredRows].sort((a, b) => {
    const aValue = getSortValue(a, sort);
    const bValue = getSortValue(b, sort);

    if (dir === "asc") return aValue - bValue;
    return bValue - aValue;
  });

  const displayedRows = sortedRows.slice(0, pageSize);

  const shareBase = totals.expenseShareBase || totals.economicTurnover || totals.revenue;
  const economicTurnover = totals.economicTurnover || totals.revenue;
  const discountPointsAmount = totals.discountPointsAmount || 0;
  const clickAdsCost = totals.clickAdsCost || Math.max(0, totals.adsCost - (totals.orderAdsCost || 0));
  const orderAdsCost = totals.orderAdsCost || 0;
  const otherDeductions = totals.penaltiesAmount + totals.deductions;
  const grossOzonExpenses =
    totals.grossOzonExpenses ||
    totals.wbCommission + totals.logisticsCost + totals.adsCost + otherDeductions;
  const netOzonExpenses =
    totals.netOzonExpenses || grossOzonExpenses - discountPointsAmount;

  const lossRows = rows.filter((row) => row.netProfitAfterTax < 0);
  const highDrrRows = rows.filter((row) => row.drrPercent > 20);
  const lowMarginRows = rows.filter(
    (row) => row.revenue > 0 && row.marginAfterTaxPercent < 10
  );
  const cRows = rows.filter((row) => row.abcByProfit === "C");

  const structureRows = [
    {
      label: "Себестоимость товаров",
      value: totals.totalCost,
      colorHex: "#2563eb",
    },
    {
      label: "Комиссия Ozon",
      value: totals.wbCommission,
      colorHex: "#8b5cf6",
    },
    {
      label: "Логистика Ozon",
      value: totals.logisticsCost,
      colorHex: "#0ea5e9",
    },
    {
      label: "Реклама: оплата за клик",
      value: clickAdsCost,
      colorHex: "#ec4899",
    },
    {
      label: "Реклама: оплата за заказ",
      value: orderAdsCost,
      colorHex: "#f97316",
    },
    {
      label: "Удержания / сторно",
      value: otherDeductions,
      colorHex: "#f59e0b",
    },
    {
      label: "Налоги",
      value: totals.taxesAmount,
      colorHex: "#14b8a6",
    },
    {
      label: "Баллы за скидки / соинвест Ozon",
      value: -discountPointsAmount,
      colorHex: "#10b981",
    },
  ];

  const currentSortDirLabel = dir === "desc" ? "сначала высокая" : "сначала низкая";

  return (
    <main className="page-shell">
      <div className="page-container">
        <section className="panel p-5 sm:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <div className="inline-flex rounded-full bg-sky-50 px-3 py-1 text-xs font-black uppercase tracking-[0.12em] text-sky-700 ring-1 ring-sky-100">
                Ozon аналитика
              </div>

              <h1 className="mt-3 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
                Прибыль Ozon по SKU
              </h1>

              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-500">
                Unit economics по Ozon: налоговая выручка, экономический оборот,
                баллы за скидки, комиссии, логистика, реклама и налоги.
              </p>
            </div>

            <form className="grid gap-3 rounded-[28px] border border-slate-200 bg-white p-3 shadow-sm md:grid-cols-[160px_160px_190px_140px]">
              <input type="hidden" name="sort" value={sort} />
              <input type="hidden" name="dir" value={dir} />
              <input type="hidden" name="abc" value={abc} />
              <input type="hidden" name="q" value={q} />
              <input type="hidden" name="pageSize" value={pageSize} />
              <input type="hidden" name="usnRate" value={usnRate} />
              <input type="hidden" name="vatRate" value={vatRate} />

              <label className="block">
                <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                  Дата от
                </span>
                <input
                  type="date"
                  name="dateFrom"
                  defaultValue={dateFrom}
                  className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 outline-none transition focus:border-blue-200 focus:bg-white"
                />
              </label>

              <label className="block">
                <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                  Дата до
                </span>
                <input
                  type="date"
                  name="dateTo"
                  defaultValue={dateTo}
                  className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 outline-none transition focus:border-blue-200 focus:bg-white"
                />
              </label>

              <label className="block">
                <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                  Компания
                </span>
                <select
                  name="companyName"
                  defaultValue={companyName}
                  className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 outline-none transition focus:border-blue-200 focus:bg-white"
                >
                  <option value="ALL">Все компании</option>
                  <option value="ИП Петров">ИП Петров</option>
                  <option value="ИП Лебедева">ИП Лебедева</option>
                </select>
              </label>

              <div className="flex items-end">
                <button className="w-full rounded-2xl bg-blue-600 px-4 py-2.5 text-sm font-black text-white shadow-lg shadow-blue-200 transition hover:bg-blue-700">
                  Применить
                </button>
              </div>
            </form>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-end gap-2 text-sm">
            <span className="text-slate-500">Сравнение с предыдущим периодом</span>
            <span className="rounded-2xl bg-emerald-50 px-3 py-1 font-black text-emerald-700 ring-1 ring-emerald-100">
              {formatDateRu(dateFrom)} — {formatDateRu(dateTo)}
            </span>
            <Link
              href="/import"
              className="rounded-2xl border border-slate-200 bg-white px-4 py-2 font-black text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              Импорт данных
            </Link>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-8">
          <KpiCard
            title="Налоговая выручка"
            value={formatMoney(totals.revenue)}
            helper="сумма после баллов Ozon"
            delta={comparison.revenue.diffPercent}
            sparkTone="indigo"
            sparkPoints={[10, 12, 18, 14, 14, 21, 19, 28]}
          />

          <KpiCard
            title="Экономический оборот"
            value={formatMoney(economicTurnover)}
            helper={`${formatShare(totals.revenue, shareBase, "налоговая база")}`}
            delta={comparison.economicTurnover.diffPercent}
            sparkTone="indigo"
            sparkPoints={[8, 11, 15, 14, 18, 22, 21, 27]}
          />

          <KpiCard
            title="Баллы за скидки"
            value={formatMoney(discountPointsAmount)}
            helper={`${formatShare(discountPointsAmount, shareBase, "от экон. оборота")}`}
            delta={comparison.discountPointsAmount.diffPercent}
            sparkTone="emerald"
            sparkPoints={[11, 13, 15, 17, 18, 19, 21, 23]}
          />

          <KpiCard
            title="Реклама Ozon"
            value={formatMoney(totals.adsCost)}
            helper={`${formatPercent(totals.drrPercent)} ДРР от экон. оборота`}
            delta={comparison.adsCost.diffPercent}
            inverseDelta
            sparkTone="orange"
            sparkPoints={[18, 17, 22, 16, 14, 13, 15, 23]}
          />

          <KpiCard
            title="Оплата за клик"
            value={formatMoney(clickAdsCost)}
            helper={`${formatShare(clickAdsCost, shareBase, "от экон. оборота")}`}
            delta={comparison.clickAdsCost.diffPercent}
            inverseDelta
            sparkTone="orange"
            sparkPoints={[12, 12, 13, 14, 13, 14, 15, 15]}
          />

          <KpiCard
            title="Оплата за заказ"
            value={formatMoney(orderAdsCost)}
            helper={`${formatShare(orderAdsCost, shareBase, "от экон. оборота")}`}
            delta={comparison.orderAdsCost.diffPercent}
            inverseDelta
            sparkTone="orange"
            sparkPoints={[4, 5, 5, 6, 7, 8, 8, 9]}
          />

          <KpiCard
            title="Комиссия Ozon"
            value={formatMoney(totals.wbCommission)}
            helper={`${formatShare(totals.wbCommission, shareBase, "от экон. оборота")}`}
            delta={comparison.wbCommission.diffPercent}
            inverseDelta
            sparkTone="red"
            sparkPoints={[8, 10, 9, 15, 14, 18, 23, 21]}
          />

          <KpiCard
            title="Логистика Ozon"
            value={formatMoney(totals.logisticsCost)}
            helper={`${formatShare(totals.logisticsCost, shareBase, "от экон. оборота")}`}
            delta={comparison.logisticsCost.diffPercent}
            inverseDelta
            sparkTone="red"
            sparkPoints={[7, 9, 10, 10, 12, 12, 13, 15]}
          />
        </section>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,4fr)_minmax(340px,2fr)]">
          <section className="panel min-w-0 p-5 sm:p-6">
            <div className="flex items-center gap-2">
              <h2 className="text-[1.7rem] font-black tracking-tight text-slate-950">
                Структура расходов и компенсаций Ozon
              </h2>
              <span className="text-slate-300">ⓘ</span>
            </div>

            <div className="mt-5 grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)] lg:items-center">
              <div className="flex justify-center">
                <ExpenseDonut rows={structureRows} revenue={shareBase} />
              </div>

              <div className="space-y-3">
                {structureRows.map((row) => (
                  <StructureLegendRow
                    key={row.label}
                    label={row.label}
                    value={row.value}
                    share={shareBase > 0 ? (row.value / shareBase) * 100 : 0}
                    colorHex={row.colorHex}
                  />
                ))}

                <div className="grid grid-cols-[minmax(0,1fr)_105px_62px] items-center gap-3 border-t border-slate-100 pt-4">
                  <div className="font-black text-slate-700">
                    Валовые расходы Ozon
                  </div>
                  <div className="text-right font-black text-slate-900">
                    {formatMoney(grossOzonExpenses)}
                  </div>
                  <div className="text-right font-black text-slate-700">
                    {formatPercent(shareBase > 0 ? (grossOzonExpenses / shareBase) * 100 : 0)}
                  </div>
                </div>

                <div className="grid grid-cols-[minmax(0,1fr)_105px_62px] items-center gap-3">
                  <div className="font-black text-emerald-600">
                    Чистые расходы Ozon после баллов
                  </div>
                  <div className="text-right font-black text-emerald-600">
                    {formatMoney(netOzonExpenses)}
                  </div>
                  <div className="text-right font-black text-emerald-600">
                    {formatPercent(shareBase > 0 ? (netOzonExpenses / shareBase) * 100 : 0)}
                  </div>
                </div>

                <div className="grid grid-cols-[minmax(0,1fr)_105px_62px] items-center gap-3 border-t border-slate-100 pt-4">
                  <div className="font-black text-emerald-600">
                    Прибыль после налогов
                  </div>
                  <div className="text-right font-black text-emerald-600">
                    {formatMoney(totals.netProfitAfterTax)}
                  </div>
                  <div className="text-right font-black text-emerald-600">
                    {formatPercent(totals.marginAfterTaxPercent)}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <aside className="panel min-w-0 p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-[1.7rem] font-black tracking-tight text-slate-950">
                  Что требует внимания
                </h2>
                <span className="text-slate-300">ⓘ</span>
              </div>

              <button
                type="button"
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-black text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
              >
                Смотреть все
              </button>
            </div>

            <div className="mt-5 space-y-3">
              <AttentionItem
                title="Убыточные товары"
                text={`${formatNumber(lossRows.length)} SKU с отрицательной прибылью`}
                value={formatMoney(lossRows.reduce((sum, row) => sum + row.netProfitAfterTax, 0))}
                tone="red"
              />

              <AttentionItem
                title="Высокий ДРР (>20%)"
                text={`${formatNumber(highDrrRows.length)} SKU с ДРР выше 20%`}
                value={formatMoney(highDrrRows.reduce((sum, row) => sum + row.adsCost, 0))}
                tone="orange"
              />

              <AttentionItem
                title="Низкая маржинальность (<10%)"
                text={`${formatNumber(lowMarginRows.length)} SKU с маржинальностью ниже 10%`}
                value={formatMoney(lowMarginRows.reduce((sum, row) => sum + row.revenue, 0))}
                tone="blue"
              />

              <AttentionItem
                title="Товары C-класса"
                text={`${formatNumber(cRows.length)} SKU с низким вкладом в прибыль`}
                value={formatMoney(cRows.reduce((sum, row) => sum + row.revenue, 0))}
                tone="violet"
              />
            </div>
          </aside>
        </section>

        <section className="panel overflow-hidden">
          <div className="border-b border-slate-200 p-5 sm:p-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <div className="section-eyebrow">SKU</div>
                <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950">
                  Сводная таблица по артикулам
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  Рабочий список товаров Ozon: размеры объединены в одну группу по базовому артикулу, внутри видны отдельные SKU.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Link
                  href="/import"
                  className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-black text-blue-700 transition hover:bg-blue-100"
                >
                  Управление себестоимостью
                </Link>

                <button
                  type="button"
                  disabled
                  className="cursor-not-allowed rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-black text-slate-400"
                  title="Экспорт добавим отдельным шагом"
                >
                  Выгрузить список
                </button>
              </div>
            </div>

            <form className="mt-5 flex flex-col gap-3 xl:flex-row xl:items-center">
              <input type="hidden" name="dateFrom" value={dateFrom} />
              <input type="hidden" name="dateTo" value={dateTo} />
              <input type="hidden" name="companyName" value={companyName} />
              <input type="hidden" name="abc" value={abc} />
              <input type="hidden" name="usnRate" value={usnRate} />
              <input type="hidden" name="vatRate" value={vatRate} />

              <div className="relative w-full xl:max-w-[330px]">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">
                  🔎
                </span>
                <input
                  type="text"
                  name="q"
                  defaultValue={q}
                  placeholder="Артикул или SKU"
                  className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-11 pr-10 text-sm font-bold text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-blue-200 focus:ring-4 focus:ring-blue-50"
                />
                {q ? (
                  <Link
                    href={buildQueryHref(params, { q: "" })}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400"
                  >
                    ×
                  </Link>
                ) : null}
              </div>

              <div className="flex flex-wrap rounded-2xl bg-slate-100 p-1">
                {ABC_FILTERS.map((filter) => {
                  const active = abc === filter.key;

                  return (
                    <Link
                      key={filter.key}
                      href={buildQueryHref(params, { abc: filter.key })}
                      className={`rounded-xl px-4 py-2 text-sm font-black transition ${
                        active
                          ? "bg-white text-slate-950 shadow-sm"
                          : "text-slate-500 hover:text-slate-950"
                      }`}
                    >
                      {filter.label}
                    </Link>
                  );
                })}
              </div>

              <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center xl:justify-end">
                <label className="flex items-center gap-2 text-sm font-black text-slate-700">
                  <span>Сортировать по</span>
                  <select
                    name="sort"
                    defaultValue={sort}
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-black text-blue-700 outline-none"
                  >
                    <option value="revenue">выручке</option>
                    <option value="netSalesQty">количеству</option>
                    <option value="expenses">расходам</option>
                    <option value="netProfitAfterTax">прибыли</option>
                    <option value="buyoutPercent">проценту выкупа</option>
                    <option value="marginAfterTaxPercent">маржинальности</option>
                    <option value="adsCost">рекламе</option>
                    <option value="drrPercent">ДРР</option>
                  </select>
                </label>

                <label className="flex items-center gap-2 text-sm font-black text-slate-700">
                  <span>порядок</span>
                  <select
                    name="dir"
                    defaultValue={dir}
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-black text-blue-700 outline-none"
                  >
                    <option value="desc">сначала высокая</option>
                    <option value="asc">сначала низкая</option>
                  </select>
                </label>

                <label className="flex items-center gap-2 text-sm font-black text-slate-700">
                  <span>строк</span>
                  <select
                    name="pageSize"
                    defaultValue={String(pageSize)}
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-black text-blue-700 outline-none"
                  >
                    {PAGE_SIZE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>

                <button className="rounded-2xl bg-blue-600 px-4 py-2.5 text-sm font-black text-white shadow-lg shadow-blue-200 transition hover:bg-blue-700">
                  Применить
                </button>
              </div>
            </form>

            <div className="mt-3 text-xs font-semibold text-slate-400">
              Сейчас: сортировка по {getSortLabel(sort)}, {currentSortDirLabel}.
              Компания: {getCompanyLabel(companyName)}. Строк на странице: {pageSize}.
            </div>
          </div>

          <div className="overflow-x-auto">
            <TableHeader />

            <div className="min-w-[1180px] bg-white">
              {displayedRows.map((row, index) => (
                <ProductRow
                  key={`${row.nmId}-${row.vendorCode}-${index}`}
                  row={row}
                  index={index}
                  totalRevenue={totals.revenue}
                />
              ))}

              {sortedRows.length === 0 ? (
                <div className="px-6 py-12 text-center">
                  <div className="text-lg font-black text-slate-950">
                    Нет данных для расчёта прибыли Ozon
                  </div>
                  <p className="mt-2 text-sm text-slate-500">
                    Загрузите Ozon Finance, Ozon Ads и ProductCost или измените
                    фильтры.
                  </p>
                  <Link
                    href="/import"
                    className="mt-5 inline-flex rounded-2xl bg-blue-600 px-5 py-3 text-sm font-black text-white shadow-lg shadow-blue-200"
                  >
                    Перейти к импорту
                  </Link>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4 text-sm font-semibold text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <div>
              Показано {formatNumber(displayedRows.length)} из{" "}
              {formatNumber(sortedRows.length)} групп после фильтров. Всего в
              периоде: {formatNumber(groupedRows.length)} групп / {formatNumber(rows.length)} SKU.
            </div>

            <div>Фото Ozon подтягиваются из Ozon Products API после синхронизации товаров.</div>
          </div>
        </section>
      </div>
    </main>
  );
}
