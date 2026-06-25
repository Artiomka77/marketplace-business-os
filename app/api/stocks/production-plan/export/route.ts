import { NextResponse } from "next/server";
import ExcelJS from "exceljs";

import { prisma } from "@/lib/prisma";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type AbcCategory = "A" | "B" | "C";
type Marketplace = "WB" | "OZON";
type Priority = "HIGH" | "MEDIUM" | "LOW";

type StockAbcInfo = {
  abcByRevenue: AbcCategory;
  abcByProfit: AbcCategory;
};

type OwnSupplyItem = {
  key: string;
  companyName: string;
  companyKey: string;
  articleKeys: Set<string>;
  sizeKey: string;
  availableQty: number;
  productName: string | null;
};

type SupplyPlanCandidate = {
  key: string;
  marketplace: Marketplace;
  priority: Priority;
  companyName: string;
  vendorCode: string;
  sku: string | null;
  size: string | null;
  productName: string | null;
  targetName: string;
  currentQty: number;
  ownItemKey: string | null;
  wantedQty: number;
  ownInitialQty: number;
  avgDailySalesQty: number | null;
  daysWithoutStock: number | null;
  abc: StockAbcInfo | null;
  reason: string;
  details: string[];
};

type SupplyPlanRow = SupplyPlanCandidate & {
  ownAvailableQty: number;
  recommendedQty: number;
};

type ProductionPlanRow = {
  key: string;
  companyName: string;
  vendorCode: string;
  sku: string | null;
  size: string | null;
  productName: string | null;
  marketplaces: Marketplace[];
  targets: string[];
  abc: StockAbcInfo | null;
  wantedQty: number;
  recommendedQty: number;
  deficitQty: number;
  leadTimeBufferQty: number;
  productionQty: number;
  avgDailySalesQty: number;
};

type ProductionImageInfo = {
  imageUrl: string | null;
  productName: string | null;
};


function normalizeKey(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeSearchValue(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[\s\-_/\\.]+/g, "")
    .trim();
}

function normalizeArticleForMatch(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[\s\-_/\\.]+/g, "")
    .trim();
}

function normalizeSupplyArticle(value: unknown) {
  return normalizeArticleForMatch(value);
}

function normalizeSupplySize(value: unknown) {
  return normalizeSearchValue(value);
}

function toNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function formatNumber(value: number) {
  return Math.round(value).toLocaleString("ru-RU");
}

function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function formatDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultPeriod() {
  const now = new Date();
  const dateTo = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );

  return {
    dateFrom: formatDateInput(addUtcDays(dateTo, -30)),
    dateTo: formatDateInput(dateTo),
  };
}

function toAbcCategory(value: unknown): AbcCategory {
  return value === "A" || value === "B" || value === "C" ? value : "C";
}

function getMarketplaceBaseArticle(value: unknown) {
  const article = normalizeKey(value);

  if (!article) return "";

  const baseArticle = article.split("-")[0]?.trim() ?? article;

  return /^\d+$/.test(baseArticle) ? baseArticle : "";
}

function registerUniqueArticleCompany(
  map: Map<string, string | null>,
  article: unknown,
  companyName: unknown
) {
  const company = normalizeKey(companyName);

  if (!company) return;

  for (const articleKey of getSupplyArticleCandidates(article)) {
    const existingCompany = map.get(articleKey);

    if (existingCompany === undefined) {
      map.set(articleKey, company);
      continue;
    }

    if (existingCompany !== company) {
      map.set(articleKey, null);
    }
  }
}

function findUniqueCompanyByArticle(
  map: Map<string, string | null>,
  article: unknown
) {
  for (const articleKey of getSupplyArticleCandidates(article)) {
    const company = map.get(articleKey);

    if (company) return company;
  }

  return null;
}

function getSupplierArticleRoot(value: unknown) {
  const vendorCode = normalizeKey(value);

  if (!vendorCode) return "";

  return vendorCode.split("-")[0]?.trim() ?? vendorCode;
}

function getSupplyArticleCandidates(value: unknown) {
  const vendorCode = normalizeKey(value);

  if (!vendorCode) return [];

  const candidates = new Set<string>();
  candidates.add(vendorCode);

  const baseArticle = getMarketplaceBaseArticle(vendorCode);
  if (baseArticle) candidates.add(baseArticle);

  const rootArticle = getSupplierArticleRoot(vendorCode);
  if (rootArticle) candidates.add(rootArticle);

  return Array.from(candidates)
    .map((candidate) => normalizeSupplyArticle(candidate))
    .filter(Boolean);
}
function getOzonSupplyCoverageKey(params: {
  companyName?: string | null;
  article?: string | null;
}) {
  const companyKey = normalizeSearchValue(params.companyName);
  const articleKey = normalizeSupplyArticle(params.article);

  return companyKey && articleKey ? `${companyKey}::${articleKey}` : "";
}

function getInclusiveDateRangeDays(dateFrom: string, dateTo: string) {
  const fromTime = new Date(`${dateFrom}T00:00:00.000Z`).getTime();
  const toTime = new Date(`${dateTo}T00:00:00.000Z`).getTime();

  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return 28;

  const days = Math.floor((toTime - fromTime) / (24 * 60 * 60 * 1000)) + 1;

  return Math.max(1, days);
}

function getOzonCalculatedTargetDays(abc: AbcCategory) {
  if (abc === "A") return 21;
  if (abc === "B") return 14;
  return 7;
}

function getWbConservativeTargetQty(abc: AbcCategory) {
  if (abc === "A") return 36;
  if (abc === "B") return 20;
  return 0;
}

function getWbGeoTargetDays(abc: AbcCategory) {
  if (abc === "A") return 14;
  if (abc === "B") return 7;
  return 0;
}

function getWbGeoConfidenceMultiplier(observedDays: number) {
  if (observedDays >= 30) return 1;
  if (observedDays >= 14) return 0.85;
  if (observedDays >= 7) return 0.7;
  return 0.5;
}

function getWbGeoSupplyKey(params: {
  companyName?: string | null;
  article?: string | null;
  size?: string | null;
  warehouseName?: string | null;
}) {
  const companyKey = normalizeSearchValue(params.companyName);
  const articleKey = normalizeSupplyArticle(params.article);
  const sizeKey = normalizeSupplySize(params.size);
  const warehouseKey = normalizeSearchValue(params.warehouseName);

  return companyKey && articleKey && warehouseKey
    ? `${companyKey}::${articleKey}::${sizeKey}::${warehouseKey}`
    : "";
}

function compactList(values: Iterable<string>, limit = 5) {
  const list = Array.from(values).filter(Boolean);

  if (list.length === 0) return "нет данных";

  const shown = list.slice(0, limit).join(", ");
  const hidden = list.length - limit;

  return hidden > 0 ? `${shown} + ещё ${hidden}` : shown;
}

function formatDecimal(value: number) {
  return value.toLocaleString("ru-RU", {
    maximumFractionDigits: 2,
  });
}


function inferSizeFromVendorCode(value: unknown) {
  const vendorCode = normalizeKey(value);

  if (!vendorCode || !vendorCode.includes("-")) return null;

  const parts = vendorCode
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);

  const numericTail: string[] = [];

  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];

    if (!/^\d{2,3}$/.test(part)) break;

    numericTail.unshift(part);

    if (numericTail.length >= 2) break;
  }

  if (numericTail.length === 0) return null;

  return numericTail.join(" / ");
}

function calculateAbcByPositiveValue<T>(
  rows: T[],
  getValue: (row: T) => number
): Map<T, AbcCategory> {
  const result = new Map<T, AbcCategory>();

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

function getStockAbcMapKey(companyName: unknown, article: unknown) {
  const company = normalizeKey(companyName);
  const normalizedArticle = normalizeKey(article);

  return company && normalizedArticle ? `${company}::${normalizedArticle}` : "";
}

function registerStockAbc(
  map: Map<string, StockAbcInfo>,
  params: {
    companyName?: string | null;
    article?: string | null;
    abc: StockAbcInfo;
  }
) {
  const article = normalizeKey(params.article);

  if (!article) return;

  const companyKey = getStockAbcMapKey(params.companyName, article);

  if (companyKey && !map.has(companyKey)) {
    map.set(companyKey, params.abc);
  }

  if (!map.has(article)) {
    map.set(article, params.abc);
  }
}

function findStockAbc(
  map: Map<string, StockAbcInfo>,
  params: {
    companyName?: string | null;
    articles: Array<string | null | undefined>;
  }
) {
  for (const article of params.articles) {
    const normalizedArticle = normalizeKey(article);

    if (!normalizedArticle) continue;

    const companyKey = getStockAbcMapKey(params.companyName, normalizedArticle);
    const companyValue = companyKey ? map.get(companyKey) : null;

    if (companyValue) return companyValue;

    const globalValue = map.get(normalizedArticle);

    if (globalValue) return globalValue;
  }

  return null;
}

function rowCompanyName(value: unknown, fallback: string | null) {
  return normalizeKey((value as { companyName?: string | null })?.companyName) || fallback;
}

function supplyPriorityWeight(priority: Priority) {
  if (priority === "HIGH") return 3;
  if (priority === "MEDIUM") return 2;
  return 1;
}

function getSupplyPriority(params: {
  wantedQty: number;
  ownAvailableQty: number;
  currentQty: number;
  abc: StockAbcInfo | null;
  daysWithoutStock?: number | null;
}): Priority {
  if (params.wantedQty <= 0) return "LOW";

  const abc = params.abc?.abcByProfit ?? "C";

  if (params.ownAvailableQty <= 0) {
    return abc === "A" && params.currentQty <= 2 ? "MEDIUM" : "LOW";
  }

  if (
    abc === "A" ||
    params.currentQty <= 2 ||
    toNumber(params.daysWithoutStock) > 0
  ) {
    return "HIGH";
  }

  if (abc === "B") return "MEDIUM";

  return "LOW";
}

function priorityLabel(priority: Priority) {
  if (priority === "HIGH") return "Высокий";
  if (priority === "MEDIUM") return "Средний";
  return "Низкий";
}

function supplyPlanMatchesSearch(row: SupplyPlanRow, query: string) {
  const normalizedQuery = normalizeSearchValue(query);

  if (!normalizedQuery) return true;

  const fields = [
    row.companyName,
    row.marketplace,
    row.targetName,
    row.vendorCode,
    row.sku,
    row.size,
    row.productName,
    row.reason,
    row.abc?.abcByProfit,
    priorityLabel(row.priority),
  ];

  const textHaystack = fields
    .map((field) => String(field ?? "").toLowerCase().replaceAll("ё", "е"))
    .join(" ");

  const compactHaystack = normalizeSearchValue(fields.join(" "));

  return (
    textHaystack.includes(String(query).toLowerCase().replaceAll("ё", "е")) ||
    compactHaystack.includes(normalizedQuery)
  );
}

function getQueryValue(url: URL, name: string) {
  return normalizeKey(url.searchParams.get(name));
}

function getMarketplaceFilter(value: string): "ALL" | Marketplace {
  if (value === "WB" || value === "OZON") return value;
  return "ALL";
}

function getPriorityFilter(value: string): "ALL" | Priority {
  if (value === "HIGH" || value === "MEDIUM" || value === "LOW") return value;
  return "ALL";
}

function getAbcFilter(value: string): "ALL" | AbcCategory {
  if (value === "A" || value === "B" || value === "C") return value;
  return "ALL";
}

function getRowsLimit(value: string, totalRows: number) {
  if (value === "ALL") return totalRows;

  const parsed = Number(value || 0);

  return [20, 50, 100, 200].includes(parsed) ? parsed : totalRows;
}

function applyHeaderStyle(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "111827" },
    };
    cell.font = {
      bold: true,
      color: { argb: "FFFFFF" },
    };
    cell.alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: true,
    };
    cell.border = {
      top: { style: "thin", color: { argb: "CBD5E1" } },
      left: { style: "thin", color: { argb: "CBD5E1" } },
      bottom: { style: "thin", color: { argb: "CBD5E1" } },
      right: { style: "thin", color: { argb: "CBD5E1" } },
    };
  });
}

function applyBodyStyle(row: ExcelJS.Row) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.alignment = {
      vertical: "middle",
      wrapText: true,
    };
    cell.border = {
      top: { style: "thin", color: { argb: "E2E8F0" } },
      left: { style: "thin", color: { argb: "E2E8F0" } },
      bottom: { style: "thin", color: { argb: "E2E8F0" } },
      right: { style: "thin", color: { argb: "E2E8F0" } },
    };
  });
}

async function buildSupplyPlanRows(url: URL) {
  const defaultPeriod = getDefaultPeriod();
  const dateFrom = getQueryValue(url, "dateFrom") || defaultPeriod.dateFrom;
  const dateTo = getQueryValue(url, "dateTo") || defaultPeriod.dateTo;
  const selectedCompanyName = getQueryValue(url, "companyName");
  const companyName =
    selectedCompanyName && selectedCompanyName !== "ALL" ? selectedCompanyName : null;

  const companyWhere = companyName ? companyName : undefined;

  const [wbProfitAnalytics, ozonProfitAnalytics] = await Promise.all([
    getProfitAnalytics({
      dateFrom,
      dateTo,
      companyName: companyName ?? "ALL",
    }),
    getProfitAnalyticsOzon({
      dateFrom,
      dateTo,
      usnRate: "1",
      vatRate: "5",
      companyName: companyName ?? "ALL",
    }),
  ]);

  const wbAbcByRevenue = calculateAbcByPositiveValue(
    wbProfitAnalytics.rows,
    (row) => toNumber(row.revenue)
  );
  const wbAbcMap = new Map<string, StockAbcInfo>();

  for (const row of wbProfitAnalytics.rows) {
    const abc = {
      abcByRevenue: wbAbcByRevenue.get(row) ?? "C",
      abcByProfit: toAbcCategory(row.abcByProfit),
    } satisfies StockAbcInfo;

    const rowCompany = rowCompanyName(row, companyName);

    registerStockAbc(wbAbcMap, {
      companyName: rowCompany,
      article: row.nmId,
      abc,
    });

    registerStockAbc(wbAbcMap, {
      companyName: rowCompany,
      article: row.vendorCode,
      abc,
    });
  }

  const ozonGroupsForAbc = new Map<
    string,
    {
      companyName: string | null;
      baseArticle: string;
      revenue: number;
      netProfitAfterTax: number;
      rows: typeof ozonProfitAnalytics.rows;
    }
  >();

  for (const row of ozonProfitAnalytics.rows) {
    const rowCompany = rowCompanyName(row, companyName);
    const baseArticle = getMarketplaceBaseArticle(row.vendorCode) || row.vendorCode;
    const key = `${rowCompany ?? ""}::${baseArticle}`;
    const current =
      ozonGroupsForAbc.get(key) ??
      ({
        companyName: rowCompany,
        baseArticle,
        revenue: 0,
        netProfitAfterTax: 0,
        rows: [],
      } satisfies {
        companyName: string | null;
        baseArticle: string;
        revenue: number;
        netProfitAfterTax: number;
        rows: typeof ozonProfitAnalytics.rows;
      });

    current.revenue += toNumber(row.revenue);
    current.netProfitAfterTax += toNumber(row.netProfitAfterTax);
    current.rows.push(row);

    ozonGroupsForAbc.set(key, current);
  }

  const ozonGroupedRowsForAbc = Array.from(ozonGroupsForAbc.values());
  const ozonGroupedAbcByRevenue = calculateAbcByPositiveValue(
    ozonGroupedRowsForAbc,
    (row) => row.revenue
  );
  const ozonGroupedAbcByProfit = calculateAbcByPositiveValue(
    ozonGroupedRowsForAbc,
    (row) => row.netProfitAfterTax
  );
  const ozonAbcMap = new Map<string, StockAbcInfo>();

  for (const group of ozonGroupedRowsForAbc) {
    const abc = {
      abcByRevenue: ozonGroupedAbcByRevenue.get(group) ?? "C",
      abcByProfit: ozonGroupedAbcByProfit.get(group) ?? "C",
    } satisfies StockAbcInfo;

    registerStockAbc(ozonAbcMap, {
      companyName: group.companyName,
      article: group.baseArticle,
      abc,
    });

    for (const row of group.rows) {
      registerStockAbc(ozonAbcMap, {
        companyName: group.companyName,
        article: row.vendorCode,
        abc,
      });

      registerStockAbc(ozonAbcMap, {
        companyName: group.companyName,
        article: row.nmId,
        abc,
      });
    }
  }

  const wbDailySaleDateFrom = new Date(`${dateFrom}T00:00:00.000Z`);
  const wbDailySaleDateTo = new Date(`${dateTo}T23:59:59.999Z`);

  const [
    rawWbStocks,
    ozonStocks,
    ozonSupplyRecommendations,
    wbDailySalesRows,
    warehouseStocks,
  ] = await Promise.all([
      prisma.wbStock.findMany({
        where: {
          companyName: companyWhere,
        },
        orderBy: [
          { companyName: "asc" },
          { vendorCode: "asc" },
          { size: "asc" },
          { warehouseName: "asc" },
        ],
        select: {
          id: true,
          companyName: true,
          vendorCode: true,
          nmId: true,
          barcode: true,
          size: true,
          warehouseName: true,
          warehouseQty: true,
          totalStock: true,
        },
      }),
      prisma.ozonStock.findMany({
        where: {
          companyName: companyWhere,
        },
        orderBy: [
          { companyName: "asc" },
          { vendorCode: "asc" },
          { warehouseName: "asc" },
        ],
        select: {
          companyName: true,
          vendorCode: true,
          sku: true,
          availableQty: true,
          preparingQty: true,
          supplyQty: true,
          inTransitQty: true,
        },
      }),
      prisma.ozonSupplyRecommendation.findMany({
        where: {
          companyName: companyWhere,
        },
        orderBy: [
          { companyName: "asc" },
          { clusterName: "asc" },
          { vendorCode: "asc" },
        ],
        select: {
          id: true,
          companyName: true,
          sku: true,
          vendorCode: true,
          productName: true,
          recommendationPeriodDays: true,
          recommendedSupplyQty: true,
          recommendation: true,
          clusterName: true,
          daysWithoutStock28: true,
          avgDailySalesQty28: true,
          fboStockQty: true,
          fbsStockQty: true,
          inTransitToOzonQty: true,
        },
      }),
      prisma.wbSale.findMany({
        where: {
          companyName: companyWhere,
          reportNumber: {
            startsWith: "WB_DAILY_STATISTICS_",
          },
          saleDate: {
            gte: wbDailySaleDateFrom,
            lte: wbDailySaleDateTo,
          },
        },
        orderBy: [{ saleDate: "asc" }],
        select: {
          companyName: true,
          vendorCode: true,
          nmId: true,
          barcode: true,
          size: true,
          warehouseName: true,
          countryName: true,
          oblastOkrugName: true,
          regionName: true,
          saleDate: true,
          quantity: true,
          wbRealizedAmount: true,
        },
      }),
      prisma.ozonWarehouseStock.findMany({
        where: {
          companyName: companyWhere,
        },
        orderBy: [{ companyName: "asc" }, { vendorCode: "asc" }, { size: "asc" }],
        select: {
          id: true,
          companyName: true,
          vendorCode: true,
          sku: true,
          productName: true,
          size: true,
          barcode: true,
          availableForSupplyQty: true,
        },
      }),
    ]);

  const supplierArticleByCompanyAndWbArticle = new Map<string, string>();
  const supplierArticleByWbArticle = new Map<string, string>();

  function getCompanyArticleKey(companyName: unknown, article: unknown) {
    const company = normalizeKey(companyName);
    const normalizedArticle = normalizeKey(article);

    return company && normalizedArticle ? `${company}::${normalizedArticle}` : "";
  }

  function registerWbSupplierArticleMapping(params: {
    companyName?: string | null;
    wbArticle?: string | null;
    supplierArticle?: string | null;
  }) {
    const wbArticle = normalizeKey(params.wbArticle);
    const supplierArticle = normalizeKey(params.supplierArticle);

    if (!wbArticle || !supplierArticle) return;

    const companyKey = getCompanyArticleKey(params.companyName, wbArticle);

    if (companyKey && !supplierArticleByCompanyAndWbArticle.has(companyKey)) {
      supplierArticleByCompanyAndWbArticle.set(companyKey, supplierArticle);
    }

    if (!supplierArticleByWbArticle.has(wbArticle)) {
      supplierArticleByWbArticle.set(wbArticle, supplierArticle);
    }
  }

  function findSupplierArticleByWbArticle(params: {
    companyName?: string | null;
    wbArticle?: string | null;
  }) {
    const wbArticle = normalizeKey(params.wbArticle);

    if (!wbArticle) return null;

    const companyKey = getCompanyArticleKey(params.companyName, wbArticle);

    return (
      (companyKey ? supplierArticleByCompanyAndWbArticle.get(companyKey) : undefined) ??
      supplierArticleByWbArticle.get(wbArticle) ??
      null
    );
  }

  for (const stock of rawWbStocks) {
    registerWbSupplierArticleMapping({
      companyName: stock.companyName,
      wbArticle: stock.nmId,
      supplierArticle: stock.vendorCode,
    });
  }

  const ownSupplyItems: OwnSupplyItem[] = warehouseStocks
    .map((stock) => {
      const vendorCode = normalizeKey(stock.vendorCode);
      const sku = normalizeKey(stock.sku);
      const size = normalizeKey(stock.size) || inferSizeFromVendorCode(vendorCode);
      const articleKeys = new Set<string>();

      for (const article of [
        vendorCode,
        sku,
        getMarketplaceBaseArticle(vendorCode),
        getSupplierArticleRoot(vendorCode),
      ]) {
        const normalizedArticle = normalizeSupplyArticle(article);
        if (normalizedArticle) articleKeys.add(normalizedArticle);
      }

      return {
        key: `own-${stock.id}`,
        companyName: stock.companyName,
        companyKey: normalizeKey(stock.companyName),
        articleKeys,
        sizeKey: normalizeSupplySize(size),
        availableQty: toNumber(stock.availableForSupplyQty),
        productName: stock.productName ?? null,
      } satisfies OwnSupplyItem;
    })
    .filter((item) => item.availableQty > 0 && item.articleKeys.size > 0);

  function findOwnSupplyItem(params: {
    companyName?: string | null;
    articles: Array<string | null | undefined>;
    size?: string | null;
  }) {
    const companyKey = normalizeKey(params.companyName);
    const articleKeys = new Set<string>();

    for (const article of params.articles) {
      for (const candidate of getSupplyArticleCandidates(article)) {
        articleKeys.add(candidate);
      }
    }

    const sizeKey = normalizeSupplySize(params.size);

    if (!companyKey || articleKeys.size === 0) return null;

    const sameCompanyItems = ownSupplyItems.filter(
      (item) =>
        item.companyKey === companyKey &&
        [...articleKeys].some((articleKey) => item.articleKeys.has(articleKey))
    );

    if (sameCompanyItems.length === 0) return null;

    const exactSize = sizeKey
      ? sameCompanyItems.find((item) => item.sizeKey && item.sizeKey === sizeKey)
      : null;

    if (sizeKey) {
      return exactSize ?? sameCompanyItems.find((item) => !item.sizeKey) ?? null;
    }

    return sameCompanyItems[0] ?? null;
  }

  const supplyPlanCandidates: SupplyPlanCandidate[] = [];
  const officialOzonSupplyKeys = new Set<string>();

  for (const row of ozonSupplyRecommendations) {
    const vendorCode = normalizeKey(row.vendorCode);
    const sku = normalizeKey(row.sku);
    const size = inferSizeFromVendorCode(vendorCode);
    const wantedQty = Math.max(0, toNumber(row.recommendedSupplyQty));

    if (!vendorCode) continue;

    for (const article of [vendorCode, sku, getMarketplaceBaseArticle(vendorCode)]) {
      const coverageKey = getOzonSupplyCoverageKey({
        companyName: row.companyName,
        article,
      });

      if (coverageKey) officialOzonSupplyKeys.add(coverageKey);
    }

    if (wantedQty <= 0) continue;

    const abc = findStockAbc(ozonAbcMap, {
      companyName: row.companyName,
      articles: [getMarketplaceBaseArticle(vendorCode), vendorCode, sku],
    });

    const baseArticle = getMarketplaceBaseArticle(vendorCode);
    const mappedSupplierArticle = findSupplierArticleByWbArticle({
      companyName: row.companyName,
      wbArticle: baseArticle,
    });
    const ownItem = findOwnSupplyItem({
      companyName: row.companyName,
      articles: [vendorCode, sku, baseArticle, mappedSupplierArticle],
      size,
    });

    const currentQty =
      toNumber(row.fboStockQty) +
      toNumber(row.fbsStockQty) +
      toNumber(row.inTransitToOzonQty);

    const ownInitialQty = ownItem?.availableQty ?? 0;
    const priority = getSupplyPriority({
      wantedQty,
      ownAvailableQty: ownInitialQty,
      currentQty,
      abc,
      daysWithoutStock: toNumber(row.daysWithoutStock28),
    });

    supplyPlanCandidates.push({
      key: `ozon-supply-${row.id}`,
      marketplace: "OZON",
      priority,
      companyName: row.companyName ?? "Без компании",
      vendorCode,
      sku: sku || null,
      size,
      productName: row.productName ?? ownItem?.productName ?? null,
      targetName: row.clusterName ? `Кластер: ${row.clusterName}` : "Кластер Ozon",
      currentQty,
      ownItemKey: ownItem?.key ?? null,
      wantedQty,
      ownInitialQty,
      avgDailySalesQty:
        row.avgDailySalesQty28 === null || row.avgDailySalesQty28 === undefined
          ? null
          : toNumber(row.avgDailySalesQty28),
      daysWithoutStock:
        row.daysWithoutStock28 === null || row.daysWithoutStock28 === undefined
          ? null
          : toNumber(row.daysWithoutStock28),
      abc,
      reason:
        normalizeKey(row.recommendation) ||
        `Ozon рекомендует поставить ${formatNumber(wantedQty)} шт. в кластер.`,
      details: [
        row.recommendationPeriodDays
          ? `Период: ${formatNumber(row.recommendationPeriodDays)} дн.`
          : "",
        row.avgDailySalesQty28 !== null && row.avgDailySalesQty28 !== undefined
          ? `Продажи: ${formatNumber(toNumber(row.avgDailySalesQty28))} шт/день`
          : "",
        row.daysWithoutStock28 !== null && row.daysWithoutStock28 !== undefined
          ? `Без остатка: ${formatNumber(toNumber(row.daysWithoutStock28))} дн.`
          : "",
      ].filter(Boolean),
    });
  }

  const ozonArticleCompanyByArticleKey = new Map<string, string | null>();

  for (const stock of ozonStocks) {
    registerUniqueArticleCompany(
      ozonArticleCompanyByArticleKey,
      stock.vendorCode,
      stock.companyName
    );
    registerUniqueArticleCompany(
      ozonArticleCompanyByArticleKey,
      stock.sku,
      stock.companyName
    );
  }

  for (const stock of warehouseStocks) {
    registerUniqueArticleCompany(
      ozonArticleCompanyByArticleKey,
      stock.vendorCode,
      stock.companyName
    );
    registerUniqueArticleCompany(
      ozonArticleCompanyByArticleKey,
      stock.sku,
      stock.companyName
    );
  }

  const ozonStockQtyByArticleKey = new Map<string, number>();

  for (const stock of ozonStocks) {
    const currentQty =
      toNumber(stock.availableQty) +
      toNumber(stock.preparingQty) +
      toNumber(stock.supplyQty) +
      toNumber(stock.inTransitQty);

    if (currentQty <= 0) continue;

    for (const article of [stock.vendorCode, stock.sku]) {
      const stockKey = getOzonSupplyCoverageKey({
        companyName: stock.companyName,
        article,
      });

      if (!stockKey) continue;

      ozonStockQtyByArticleKey.set(
        stockKey,
        (ozonStockQtyByArticleKey.get(stockKey) ?? 0) + currentQty
      );
    }
  }

  const ozonCalculatedGroups = new Map<
    string,
    {
      companyName: string;
      vendorCode: string;
      netSalesQty: number;
      revenue: number;
    }
  >();

  for (const row of ozonProfitAnalytics.rows) {
    const vendorCode = normalizeKey(row.vendorCode);
    const inferredCompanyName =
      findUniqueCompanyByArticle(ozonArticleCompanyByArticleKey, vendorCode) ??
      findUniqueCompanyByArticle(
        ozonArticleCompanyByArticleKey,
        getMarketplaceBaseArticle(vendorCode)
      );
    const rowCompany =
      rowCompanyName(row, companyName) ??
      inferredCompanyName ??
      "Без компании";
    const netSalesQty = Math.max(0, toNumber(row.netSalesQty));

    if (!vendorCode || netSalesQty <= 0) continue;

    const groupKey = `${normalizeSearchValue(rowCompany)}::${normalizeSupplyArticle(
      vendorCode
    )}`;
    const currentGroup =
      ozonCalculatedGroups.get(groupKey) ??
      ({
        companyName: rowCompany,
        vendorCode,
        netSalesQty: 0,
        revenue: 0,
      } satisfies {
        companyName: string;
        vendorCode: string;
        netSalesQty: number;
        revenue: number;
      });

    currentGroup.netSalesQty += netSalesQty;
    currentGroup.revenue += toNumber(row.revenue);

    ozonCalculatedGroups.set(groupKey, currentGroup);
  }

  const ozonSalesPeriodDays = getInclusiveDateRangeDays(dateFrom, dateTo);

  for (const group of ozonCalculatedGroups.values()) {
    const baseArticle = getMarketplaceBaseArticle(group.vendorCode);
    const hasOfficialRecommendation = [group.vendorCode, baseArticle].some((article) => {
      const coverageKey = getOzonSupplyCoverageKey({
        companyName: group.companyName,
        article,
      });

      return coverageKey ? officialOzonSupplyKeys.has(coverageKey) : false;
    });

    if (hasOfficialRecommendation) continue;

    const abc = findStockAbc(ozonAbcMap, {
      companyName: group.companyName,
      articles: [baseArticle, group.vendorCode],
    });
    const abcByProfit = abc?.abcByProfit ?? "C";
    const targetDays = getOzonCalculatedTargetDays(abcByProfit);
    const avgDailySalesQty = group.netSalesQty / ozonSalesPeriodDays;
    const targetQty = Math.ceil(avgDailySalesQty * targetDays);
    const currentQty =
      ozonStockQtyByArticleKey.get(
        getOzonSupplyCoverageKey({
          companyName: group.companyName,
          article: group.vendorCode,
        })
      ) ?? 0;
    const wantedQty = Math.max(0, targetQty - currentQty);

    if (wantedQty <= 0) continue;

    const size = inferSizeFromVendorCode(group.vendorCode);
    const mappedSupplierArticle = findSupplierArticleByWbArticle({
      companyName: group.companyName,
      wbArticle: baseArticle,
    });
    const ownItem = findOwnSupplyItem({
      companyName: group.companyName,
      articles: [group.vendorCode, baseArticle, mappedSupplierArticle],
      size,
    });
    const ownInitialQty = ownItem?.availableQty ?? 0;
    const priority = getSupplyPriority({
      wantedQty,
      ownAvailableQty: ownInitialQty,
      currentQty,
      abc,
    });

    supplyPlanCandidates.push({
      key: `ozon-calculated-${normalizeSearchValue(group.companyName)}-${normalizeSupplyArticle(
        group.vendorCode
      )}`,
      marketplace: "OZON",
      priority,
      companyName: group.companyName,
      vendorCode: group.vendorCode,
      sku: null,
      size,
      productName: ownItem?.productName ?? null,
      targetName: "Ozon API / общий остаток",
      currentQty,
      ownItemKey: ownItem?.key ?? null,
      wantedQty,
      ownInitialQty,
      avgDailySalesQty,
      daysWithoutStock: currentQty <= 0 ? ozonSalesPeriodDays : null,
      abc,
      reason: `Расчётная рекомендация: продажи за ${formatNumber(
        ozonSalesPeriodDays
      )} дн. — ${formatNumber(group.netSalesQty)} шт., целевой запас для ABC ${abcByProfit} — ${formatNumber(
        targetDays
      )} дн.`,
      details: [
        "Источник: расчёт системы по Ozon API, не официальный файл Ozon из ЛК",
        `Целевой запас: ${formatNumber(targetDays)} дн.`,
        `Продажи за период: ${formatNumber(group.netSalesQty)} шт.`,
        `Среднесуточные продажи: ${formatDecimal(avgDailySalesQty)} шт/день`,
        `Текущий остаток Ozon: ${formatNumber(currentQty)} шт.`,
        "Кластеры Ozon API не отдал — направление показано общим Ozon.",
      ],
    });
  }

  const wbStockQtyByWarehouseKey = new Map<string, number>();

  function registerWbStockQty(params: {
    companyName?: string | null;
    article?: string | null;
    size?: string | null;
    warehouseName?: string | null;
    qty: number;
  }) {
    const key = getWbGeoSupplyKey(params);

    if (!key) return;

    wbStockQtyByWarehouseKey.set(key, (wbStockQtyByWarehouseKey.get(key) ?? 0) + params.qty);
  }

  for (const stock of rawWbStocks) {
    if (!stock.warehouseName || stock.warehouseName === "__TOTAL__") continue;

    const stockCompanyName = normalizeKey(stock.companyName) || "Без компании";
    const vendorCode = normalizeKey(stock.vendorCode);
    const nmId = normalizeKey(stock.nmId);
    const size = normalizeKey(stock.size) || inferSizeFromVendorCode(vendorCode);
    const qty = toNumber(stock.warehouseQty);

    for (const article of [nmId, vendorCode]) {
      registerWbStockQty({
        companyName: stockCompanyName,
        article,
        size,
        warehouseName: stock.warehouseName,
        qty,
      });
    }
  }

  const wbGeoDemandGroups = new Map<
    string,
    {
      companyName: string;
      vendorCode: string;
      nmId: string;
      size: string | null;
      warehouseName: string;
      countryNames: Set<string>;
      oblastNames: Set<string>;
      regionNames: Set<string>;
      days: Set<string>;
      grossSalesQty: number;
      returnsQty: number;
      netSalesQty: number;
      salesAmount: number;
      currentQty: number;
      abc: StockAbcInfo | null;
    }
  >();

  for (const sale of wbDailySalesRows) {
    const companyName = normalizeKey(sale.companyName) || "Без компании";
    const vendorCode = normalizeKey(sale.vendorCode);
    const nmId = normalizeKey(sale.nmId);
    const articleKey = nmId || vendorCode;
    const size = normalizeKey(sale.size) || inferSizeFromVendorCode(vendorCode);
    const warehouseName = normalizeKey(sale.warehouseName);
    const quantity = toNumber(sale.quantity);

    if (!articleKey || !warehouseName || quantity === 0) continue;

    const groupKey = getWbGeoSupplyKey({
      companyName,
      article: articleKey,
      size,
      warehouseName,
    });

    if (!groupKey) continue;

    const currentGroup =
      wbGeoDemandGroups.get(groupKey) ??
      ({
        companyName,
        vendorCode,
        nmId,
        size,
        warehouseName,
        countryNames: new Set<string>(),
        oblastNames: new Set<string>(),
        regionNames: new Set<string>(),
        days: new Set<string>(),
        grossSalesQty: 0,
        returnsQty: 0,
        netSalesQty: 0,
        salesAmount: 0,
        currentQty:
          wbStockQtyByWarehouseKey.get(
            getWbGeoSupplyKey({
              companyName,
              article: articleKey,
              size,
              warehouseName,
            })
          ) ?? 0,
        abc: findStockAbc(wbAbcMap, {
          companyName,
          articles: [nmId, vendorCode],
        }),
      } satisfies {
        companyName: string;
        vendorCode: string;
        nmId: string;
        size: string | null;
        warehouseName: string;
        countryNames: Set<string>;
        oblastNames: Set<string>;
        regionNames: Set<string>;
        days: Set<string>;
        grossSalesQty: number;
        returnsQty: number;
        netSalesQty: number;
        salesAmount: number;
        currentQty: number;
        abc: StockAbcInfo | null;
      });

    if (!currentGroup.vendorCode && vendorCode) currentGroup.vendorCode = vendorCode;
    if (!currentGroup.nmId && nmId) currentGroup.nmId = nmId;
    if (!currentGroup.size && size) currentGroup.size = size;

    const countryName = normalizeKey(sale.countryName);
    const oblastName = normalizeKey(sale.oblastOkrugName);
    const regionName = normalizeKey(sale.regionName);

    if (countryName) currentGroup.countryNames.add(countryName);
    if (oblastName) currentGroup.oblastNames.add(oblastName);
    if (regionName) currentGroup.regionNames.add(regionName);

    if (sale.saleDate) {
      currentGroup.days.add(formatDateInput(sale.saleDate));
    }

    if (quantity > 0) currentGroup.grossSalesQty += quantity;
    if (quantity < 0) currentGroup.returnsQty += Math.abs(quantity);

    currentGroup.netSalesQty += quantity;
    currentGroup.salesAmount += toNumber(sale.wbRealizedAmount);

    wbGeoDemandGroups.set(groupKey, currentGroup);
  }

  for (const group of wbGeoDemandGroups.values()) {
    const abcByProfit = group.abc?.abcByProfit ?? "C";
    const targetDays = getWbGeoTargetDays(abcByProfit);

    if (targetDays <= 0) continue;

    const observedDays = Math.max(1, group.days.size);
    const demandQty = Math.max(0, group.netSalesQty);

    if (demandQty <= 0) continue;

    const avgDailySalesQty = demandQty / observedDays;
    const confidenceMultiplier = getWbGeoConfidenceMultiplier(observedDays);
    const targetQty = Math.ceil(avgDailySalesQty * targetDays * confidenceMultiplier);
    const rawWantedQty = Math.max(0, targetQty - group.currentQty);

    if (rawWantedQty <= 0) continue;

    const mappedSupplierArticle = findSupplierArticleByWbArticle({
      companyName: group.companyName,
      wbArticle: group.nmId || group.vendorCode,
    });
    const ownItem = findOwnSupplyItem({
      companyName: group.companyName,
      articles: [
        group.vendorCode,
        group.nmId,
        mappedSupplierArticle,
        getMarketplaceBaseArticle(mappedSupplierArticle ?? group.vendorCode),
        getSupplierArticleRoot(mappedSupplierArticle ?? group.vendorCode),
      ],
      size: group.size,
    });
    const ownInitialQty = ownItem?.availableQty ?? 0;

    if (ownInitialQty <= 0) continue;

    const wantedQty = Math.min(rawWantedQty, ownInitialQty);
    const priority = getSupplyPriority({
      wantedQty,
      ownAvailableQty: ownInitialQty,
      currentQty: group.currentQty,
      abc: group.abc,
    });

    supplyPlanCandidates.push({
      key: `wb-geo-${normalizeSearchValue(group.companyName)}-${normalizeSupplyArticle(
        group.nmId || group.vendorCode
      )}-${normalizeSupplySize(group.size)}-${normalizeSearchValue(group.warehouseName)}`,
      marketplace: "WB",
      priority,
      companyName: group.companyName,
      vendorCode: group.vendorCode || group.nmId,
      sku: null,
      size: group.size,
      productName: ownItem?.productName ?? null,
      targetName: `WB / ${group.warehouseName}`,
      currentQty: group.currentQty,
      ownItemKey: ownItem?.key ?? null,
      wantedQty,
      ownInitialQty,
      avgDailySalesQty,
      daysWithoutStock: group.currentQty <= 0 ? observedDays : null,
      abc: group.abc,
      reason: `WB география спроса: за ${formatNumber(observedDays)} дн. чистые продажи ${formatNumber(
        demandQty
      )} шт., текущий остаток на складе ${formatNumber(group.currentQty)} шт.`,
      details: [
        `Направление: склад WB “${group.warehouseName}”.`,
        `Регионы спроса: ${compactList(group.regionNames.size > 0 ? group.regionNames : group.oblastNames)}.`,
        `Страны: ${compactList(group.countryNames, 3)}.`,
        `Продажи: ${formatNumber(group.grossSalesQty)} шт.; возвраты: ${formatNumber(group.returnsQty)} шт.; чистый спрос: ${formatNumber(demandQty)} шт.`,
        `Среднесуточный спрос: ${formatDecimal(avgDailySalesQty)} шт/день.`,
        `Целевой запас для ABC ${abcByProfit}: ${formatNumber(targetDays)} дн.`,
        `Коэффициент осторожности по периоду ${formatNumber(observedDays)} дн.: ${formatDecimal(confidenceMultiplier)}.`,
        "Если по направлению нет продаж/выкупов, рекомендация WB не создаётся.",
      ],
    });
  }

  const ownSupplyRemaining = new Map(
    ownSupplyItems.map((item) => [item.key, item.availableQty])
  );

  const rows: SupplyPlanRow[] = supplyPlanCandidates
    .sort((a, b) => {
      const priorityDiff =
        supplyPriorityWeight(b.priority) - supplyPriorityWeight(a.priority);

      if (priorityDiff !== 0) return priorityDiff;

      if (b.ownInitialQty !== a.ownInitialQty) {
        return b.ownInitialQty - a.ownInitialQty;
      }

      return b.wantedQty - a.wantedQty;
    })
    .map((candidate) => {
      const ownAvailableQty = candidate.ownItemKey
        ? ownSupplyRemaining.get(candidate.ownItemKey) ?? 0
        : 0;
      const recommendedQty = Math.min(candidate.wantedQty, ownAvailableQty);

      if (candidate.ownItemKey) {
        ownSupplyRemaining.set(
          candidate.ownItemKey,
          Math.max(0, ownAvailableQty - recommendedQty)
        );
      }

      return {
        ...candidate,
        ownAvailableQty,
        recommendedQty,
      };
    })
    .filter((row) => row.wantedQty > 0);

  const marketplaceFilter = getMarketplaceFilter(getQueryValue(url, "supplyMarketplace"));
  const priorityFilter = getPriorityFilter(getQueryValue(url, "supplyPriority"));
  const abcFilter = getAbcFilter(getQueryValue(url, "supplyAbc"));
  const targetFilter = getQueryValue(url, "supplyTarget");
  const query = getQueryValue(url, "supplyQ");

  const filteredRows = rows.filter((row) => {
    if (marketplaceFilter !== "ALL" && row.marketplace !== marketplaceFilter) {
      return false;
    }

    if (priorityFilter !== "ALL" && row.priority !== priorityFilter) {
      return false;
    }

    if (abcFilter !== "ALL" && row.abc?.abcByProfit !== abcFilter) {
      return false;
    }

    if (targetFilter && targetFilter !== "ALL" && row.targetName !== targetFilter) {
      return false;
    }

    return supplyPlanMatchesSearch(row, query);
  });

  const rowsLimit = getRowsLimit(getQueryValue(url, "supplyRows"), filteredRows.length);

  return filteredRows.slice(0, rowsLimit);
}


const PRODUCTION_BUFFER_DAY_OPTIONS = [15, 20, 30, 60] as const;
const DEFAULT_PRODUCTION_BUFFER_DAYS = 15;

function getProductionBufferDays(value: string | null) {
  const parsed = Number(value ?? DEFAULT_PRODUCTION_BUFFER_DAYS);

  return PRODUCTION_BUFFER_DAY_OPTIONS.includes(
    parsed as (typeof PRODUCTION_BUFFER_DAY_OPTIONS)[number]
  )
    ? parsed
    : DEFAULT_PRODUCTION_BUFFER_DAYS;
}

function getProductionArticleKey(row: SupplyPlanRow) {
  const baseArticle = getMarketplaceBaseArticle(row.vendorCode);
  const rootArticle = getSupplierArticleRoot(row.vendorCode);

  return normalizeSupplyArticle(baseArticle || rootArticle || row.vendorCode || row.sku);
}

function productionPlanSummaryQty(rows: ProductionPlanRow[]) {
  return rows.reduce((sum, row) => sum + Math.max(0, row.productionQty), 0);
}

function getProductionPlanRows(rows: SupplyPlanRow[], bufferDays: number) {
  const groups = new Map<
    string,
    ProductionPlanRow & {
      marketplaceSet: Set<Marketplace>;
      targetSet: Set<string>;
    }
  >();

  for (const row of rows) {
    const abcByProfit = row.abc?.abcByProfit ?? "C";

    if (abcByProfit !== "A") continue;

    const deficitQty = Math.max(0, row.wantedQty - row.recommendedQty);

    if (deficitQty <= 0) continue;

    const articleKey = getProductionArticleKey(row);
    const sizeKey = normalizeSupplySize(row.size);

    if (!articleKey) continue;

    const groupKey = `${normalizeSearchValue(row.companyName)}::${articleKey}::${sizeKey}`;
    const avgDailySalesQty = Math.max(0, row.avgDailySalesQty ?? 0);
    const leadTimeBufferQty = Math.ceil(avgDailySalesQty * bufferDays);
    const productionQty = deficitQty + leadTimeBufferQty;
    const current =
      groups.get(groupKey) ??
      ({
        key: groupKey,
        companyName: row.companyName,
        vendorCode: row.vendorCode,
        sku: row.sku,
        size: row.size,
        productName: row.productName,
        marketplaces: [],
        targets: [],
        abc: row.abc,
        wantedQty: 0,
        recommendedQty: 0,
        deficitQty: 0,
        leadTimeBufferQty: 0,
        productionQty: 0,
        avgDailySalesQty: 0,
        marketplaceSet: new Set<Marketplace>(),
        targetSet: new Set<string>(),
      } satisfies ProductionPlanRow & {
        marketplaceSet: Set<Marketplace>;
        targetSet: Set<string>;
      });

    current.marketplaceSet.add(row.marketplace);
    current.targetSet.add(row.targetName);
    current.wantedQty += Math.max(0, row.wantedQty);
    current.recommendedQty += Math.max(0, row.recommendedQty);
    current.deficitQty += deficitQty;
    current.leadTimeBufferQty += leadTimeBufferQty;
    current.productionQty += productionQty;
    current.avgDailySalesQty += avgDailySalesQty;

    if (!current.productName && row.productName) current.productName = row.productName;
    if (!current.sku && row.sku) current.sku = row.sku;
    if (!current.size && row.size) current.size = row.size;

    groups.set(groupKey, current);
  }

  return Array.from(groups.values())
    .map((row) => ({
      ...row,
      marketplaces: Array.from(row.marketplaceSet).sort(),
      targets: Array.from(row.targetSet).sort((a, b) =>
        a.localeCompare(b, "ru", {
          numeric: true,
          sensitivity: "base",
        })
      ),
    }))
    .sort((a, b) => {
      const bothDiff =
        Number(b.marketplaces.length > 1) - Number(a.marketplaces.length > 1);

      if (bothDiff !== 0) return bothDiff;

      if (b.productionQty !== a.productionQty) {
        return b.productionQty - a.productionQty;
      }

      return b.deficitQty - a.deficitQty;
    });
}

function putImageInfo(
  map: Map<string, ProductionImageInfo>,
  key: string,
  value: ProductionImageInfo
) {
  if (!key || map.has(key)) return;
  if (!value.imageUrl && !value.productName) return;

  map.set(key, value);
}

function getCompanyLookupKey(companyName: unknown, value: unknown) {
  const company = normalizeSearchValue(companyName);
  const key = normalizeSupplyArticle(value);

  return company && key ? `${company}::${key}` : "";
}

function getGlobalLookupKey(value: unknown) {
  const key = normalizeSupplyArticle(value);

  return key ? `__global__::${key}` : "";
}

async function getProductionImageInfoMap(rows: ProductionPlanRow[]) {
  const result = new Map<string, ProductionImageInfo>();

  const vendorCodes = Array.from(
    new Set(
      rows
        .flatMap((row) => [
          row.vendorCode,
          row.sku,
          getMarketplaceBaseArticle(row.vendorCode),
          getSupplierArticleRoot(row.vendorCode),
        ])
        .map((value) => normalizeKey(value))
        .filter(Boolean)
    )
  );

  const skus = Array.from(
    new Set(rows.map((row) => normalizeKey(row.sku)).filter(Boolean))
  );
  const companyNames = Array.from(
    new Set(rows.map((row) => normalizeKey(row.companyName)).filter(Boolean))
  );

  if (vendorCodes.length === 0 && skus.length === 0) {
    return result;
  }

  const [ozonProducts, wbCards] = await Promise.all([
    prisma.ozonProduct.findMany({
      where: {
        ...(companyNames.length > 0
          ? {
              companyName: {
                in: companyNames,
              },
            }
          : {}),
        OR: [
          ...(vendorCodes.length > 0
            ? [
                {
                  vendorCode: {
                    in: vendorCodes,
                  },
                },
              ]
            : []),
          ...(skus.length > 0
            ? [
                {
                  sku: {
                    in: skus,
                  },
                },
              ]
            : []),
        ],
      },
      select: {
        companyName: true,
        vendorCode: true,
        sku: true,
        productName: true,
        imageUrl: true,
        imageSmallUrl: true,
      },
      orderBy: [{ companyName: "asc" }, { vendorCode: "asc" }],
    }),
    prisma.wbProductCard.findMany({
      where: {
        ...(companyNames.length > 0
          ? {
              companyName: {
                in: companyNames,
              },
            }
          : {}),
        OR: [
          ...(vendorCodes.length > 0
            ? [
                {
                  vendorCode: {
                    in: vendorCodes,
                  },
                },
                {
                  nmId: {
                    in: vendorCodes,
                  },
                },
              ]
            : []),
        ],
      },
      select: {
        companyName: true,
        nmId: true,
        vendorCode: true,
        title: true,
        photoSmallUrl: true,
        photoBigUrl: true,
      },
      orderBy: [{ companyName: "asc" }, { nmId: "asc" }],
    }),
  ]);

  const imageLookup = new Map<string, ProductionImageInfo>();

  for (const product of ozonProducts) {
    const info = {
      imageUrl: normalizeKey(product.imageUrl) || normalizeKey(product.imageSmallUrl) || null,
      productName: normalizeKey(product.productName) || null,
    } satisfies ProductionImageInfo;

    for (const keyValue of [product.vendorCode, product.sku]) {
      putImageInfo(imageLookup, getCompanyLookupKey(product.companyName, keyValue), info);
      putImageInfo(imageLookup, getGlobalLookupKey(keyValue), info);
    }
  }

  for (const card of wbCards) {
    const info = {
      imageUrl: normalizeKey(card.photoSmallUrl) || normalizeKey(card.photoBigUrl) || null,
      productName: normalizeKey(card.title) || null,
    } satisfies ProductionImageInfo;

    for (const keyValue of [card.vendorCode, card.nmId]) {
      putImageInfo(imageLookup, getCompanyLookupKey(card.companyName, keyValue), info);
      putImageInfo(imageLookup, getGlobalLookupKey(keyValue), info);
    }
  }

  for (const row of rows) {
    const candidates = [
      row.vendorCode,
      row.sku,
      getMarketplaceBaseArticle(row.vendorCode),
      getSupplierArticleRoot(row.vendorCode),
    ];

    let info: ProductionImageInfo | null = null;

    for (const candidate of candidates) {
      info =
        imageLookup.get(getCompanyLookupKey(row.companyName, candidate)) ??
        imageLookup.get(getGlobalLookupKey(candidate)) ??
        null;

      if (info) break;
    }

    result.set(row.key, {
      imageUrl: info?.imageUrl ?? null,
      productName: row.productName ?? info?.productName ?? null,
    });
  }

  return result;
}

async function fetchImageForExcel(url: string) {
  try {
    const response = await fetch(url, {
      cache: "no-store",
    });

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "";
    const extension: "png" | "jpeg" = contentType.includes("png") ? "png" : "jpeg";
    const mimeType = extension === "png" ? "image/png" : "image/jpeg";
    const arrayBuffer = await response.arrayBuffer();

    if (arrayBuffer.byteLength < 500) return null;

    return {
      base64: `data:${mimeType};base64,${Buffer.from(arrayBuffer).toString("base64")}`,
      extension,
    };
  } catch {
    return null;
  }
}

function buildProductionDirectionText(row: ProductionPlanRow) {
  const targets = row.targets.slice(0, 12).join("; ");

  return row.targets.length > 12
    ? `${targets}; +${row.targets.length - 12}`
    : targets;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    url.searchParams.delete("supplyRows");

    const bufferDays = getProductionBufferDays(url.searchParams.get("bufferDays"));
    const supplyRows = await buildSupplyPlanRows(url);
    const productionRows = getProductionPlanRows(supplyRows, bufferDays);
    const imageInfoMap = await getProductionImageInfoMap(productionRows);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Marketplace Business OS";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(`План пошива ${bufferDays} дн`, {
      views: [{ state: "frozen", ySplit: 1 }],
    });

    sheet.columns = [
      { header: "Фото", key: "photo", width: 12 },
      { header: "Компания", key: "companyName", width: 18 },
      { header: "Артикул", key: "vendorCode", width: 24 },
      { header: "SKU", key: "sku", width: 18 },
      { header: "Размер", key: "size", width: 12 },
      { header: "Название", key: "productName", width: 34 },
      { header: "Каналы", key: "marketplaces", width: 16 },
      { header: "Направления спроса", key: "targets", width: 46 },
      { header: "ABC", key: "abc", width: 10 },
      { header: "Реком. к поставке", key: "wantedQty", width: 18 },
      { header: "Можно отгрузить", key: "recommendedQty", width: 18 },
      { header: "Дефицит", key: "deficitQty", width: 14 },
      { header: `Буфер ${bufferDays} дней`, key: "leadTimeBufferQty", width: 18 },
      { header: "К пошиву", key: "productionQty", width: 14 },
      { header: "Средний спрос, шт/день", key: "avgDailySalesQty", width: 22 },
      { header: "Фото URL", key: "photoUrl", width: 42 },
      { header: "Комментарий", key: "comment", width: 46 },
    ];

    applyHeaderStyle(sheet.getRow(1));
    sheet.getRow(1).height = 34;

    const imageCache = new Map<string, Awaited<ReturnType<typeof fetchImageForExcel>>>();

    for (const row of productionRows) {
      const imageInfo = imageInfoMap.get(row.key) ?? {
        imageUrl: null,
        productName: row.productName,
      };
      const imageUrl = imageInfo.imageUrl;
      const excelRow = sheet.addRow({
        photo: imageUrl ? "фото" : "",
        companyName: row.companyName,
        vendorCode: row.vendorCode,
        sku: row.sku ?? "",
        size: row.size ?? "",
        productName: row.productName ?? imageInfo.productName ?? "",
        marketplaces: row.marketplaces.map((item) => (item === "OZON" ? "Ozon" : "WB")).join(" + "),
        targets: buildProductionDirectionText(row),
        abc: row.abc?.abcByProfit ?? "C",
        wantedQty: row.wantedQty,
        recommendedQty: row.recommendedQty,
        deficitQty: row.deficitQty,
        leadTimeBufferQty: row.leadTimeBufferQty,
        productionQty: row.productionQty,
        avgDailySalesQty: row.avgDailySalesQty,
        photoUrl: imageUrl ?? "",
        comment: `План пошива: дефицит ${formatNumber(row.deficitQty)} шт. + буфер ${formatNumber(bufferDays)} дн. (${formatNumber(row.leadTimeBufferQty)} шт.)`,
      });

      excelRow.height = 46;

      if (imageUrl) {
        let image = imageCache.get(imageUrl);

        if (image === undefined) {
          image = await fetchImageForExcel(imageUrl);
          imageCache.set(imageUrl, image);
        }

        if (image) {
          const imageId = workbook.addImage({
            base64: image.base64,
            extension: image.extension,
          });

          sheet.addImage(imageId, {
            tl: { col: 0.15, row: excelRow.number - 0.85 },
            ext: { width: 52, height: 52 },
          });
        }
      }
    }

    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      applyBodyStyle(row);

      row.getCell(10).numFmt = "0";
      row.getCell(11).numFmt = "0";
      row.getCell(12).numFmt = "0";
      row.getCell(13).numFmt = "0";
      row.getCell(14).numFmt = "0";
      row.getCell(15).numFmt = "0.00";
      row.alignment = { vertical: "middle", wrapText: true };
    }

    sheet.autoFilter = {
      from: "A1",
      to: "Q1",
    };

    const summary = workbook.addWorksheet("Сводка");
    summary.columns = [
      { header: "Показатель", key: "name", width: 32 },
      { header: "Значение", key: "value", width: 24 },
    ];
    applyHeaderStyle(summary.getRow(1));
    summary.addRow({ name: "Буфер пошива, дней", value: bufferDays });
    summary.addRow({ name: "Позиций", value: productionRows.length });
    summary.addRow({ name: "Всего к пошиву, шт.", value: productionPlanSummaryQty(productionRows) });
    summary.addRow({ name: "Дата формирования", value: new Date().toLocaleString("ru-RU") });

    for (let rowNumber = 2; rowNumber <= summary.rowCount; rowNumber++) {
      applyBodyStyle(summary.getRow(rowNumber));
    }

    if (productionRows.length === 0) {
      const row = sheet.addRow({
        companyName: "Нет строк по выбранным фильтрам",
      });

      sheet.mergeCells(`A${row.number}:Q${row.number}`);
      row.getCell(1).alignment = { vertical: "middle", horizontal: "center" };
      row.getCell(1).font = { bold: true, color: { argb: "64748B" } };
    }

    const now = new Date();
    const fileStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(now.getDate()).padStart(2, "0")}`;
    const buffer = await workbook.xlsx.writeBuffer();

    return new NextResponse(Buffer.from(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="production-plan-buffer-${bufferDays}-${fileStamp}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("PRODUCTION_PLAN_EXPORT_ERROR", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Ошибка экспорта плана пошива",
      },
      { status: 500 }
    );
  }
}
